import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	managedRefreshEndpoint,
	REFRESH_MAX_FRAME_BYTES,
	REFRESH_SCHEMA,
	RefreshController,
	startRefreshBridge,
} from "../../src/core/refresh-bridge.ts";
import { SafeStopGate } from "../../src/core/safe-stop.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { safeStopFixture } from "./fixtures/safe-stop-extension.ts";
import { createHarness } from "./harness.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	// Short physical path: macOS limits sockaddr_un to 104 bytes.
	const directory = mkdtempSync("/tmp/pi-bridge-");
	chmodSync(directory, 0o700);
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const fixture = safeStopFixture();
	const h = await createHarness({
		sessionManager: SessionManager.create(directory, directory),
		extensionFactories: [fixture.factory],
	});
	cleanup.push(h.cleanup);
	const model = h.getModel();
	fixture.api.registerProvider(model.provider, { apiKey: "faux", api: model.api, models: [{ ...model }] });
	h.setResponses([fauxAssistantMessage("saved")]);
	await h.session.prompt("history");
	const host = new SafeStopGate();
	const controller = new RefreshController({
		getSession: () => h.session,
		host,
		runtime: new SafeStopGate(),
		identity: {
			pid: process.pid,
			run_id: "run_test",
			instance_id: "test",
			profile: "personal",
			aoe_profile: "personal-ledger",
			lock_hash: "b".repeat(64),
		},
		checkHost: () => ({ status: "idle", reason: "idle" }),
		fenceInput: () => {},
	});
	return { h, controller, path: join(directory, "refresh.sock"), directory };
}

function exchange(path: string, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		let output = "";
		socket.on("connect", () => socket.write(payload));
		socket.on("data", (chunk) => {
			output += chunk.toString();
		});
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "ECONNRESET") reject(error);
		});
		socket.on("close", () => resolve(output));
	});
}

// CRA-1153: local control is bounded, identity-bound, and never carries transcript content.
describe("refresh socket", () => {
	it("uses 0600, discovers identity, accepts exactly once, then gracefully cleans up", async () => {
		const { h, controller, path } = await setup();
		let finish!: () => void, entered!: () => void;
		const shutdownEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const shutdownFinished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const shutdown = vi.fn(async () => {
			entered();
			await shutdownFinished;
		});
		const bridge = await startRefreshBridge({ path, controller, shutdown });
		cleanup.push(bridge.close);
		expect(lstatSync(path).mode & 0o777).toBe(0o600);
		const probe = JSON.parse(
			await exchange(path, `${JSON.stringify({ schema: REFRESH_SCHEMA, method: "probe", request_id: "probe" })}\n`),
		);
		expect(probe).toMatchObject({
			request_id: "probe",
			status: "idle",
			identity: { native_id: h.session.sessionId, session_file: realpathSync(h.session.sessionFile!) },
			resource_discovery: { skill_names: [] },
		});
		const request = { schema: REFRESH_SCHEMA, method: "stop", request_id: "stop", expected: probe.identity };
		const accepted = JSON.parse(await exchange(path, `${JSON.stringify(request)}\n`));
		expect(accepted).toMatchObject({ status: "accepted", request_id: "stop", identity: probe.identity });
		await shutdownEntered;
		expect(h.session.safeStop.isStopping).toBe(true);
		expect(JSON.parse(await exchange(path, `${JSON.stringify(request)}\n`)).status).toBe("error");
		expect(shutdown).toHaveBeenCalledOnce();
		finish();
		await shutdownFinished;
		await bridge.close();
		expect(existsSync(path)).toBe(false);
	});

	it.each(["not-json\n", "{}\n{}\n", "x".repeat(REFRESH_MAX_FRAME_BYTES + 1)])(
		"rejects malformed, multiple, or oversized frames",
		async (frame) => {
			const { controller, path } = await setup();
			const shutdown = vi.fn(async () => {});
			const bridge = await startRefreshBridge({ path, controller, shutdown });
			cleanup.push(bridge.close);
			expect(await exchange(path, frame)).toBe("");
			expect(shutdown).not.toHaveBeenCalled();
		},
	);

	it("accepts fragmented bounded requests and refuses a missing stop identity", async () => {
		const { controller, path } = await setup();
		const bridge = await startRefreshBridge({ path, controller, shutdown: async () => {} });
		cleanup.push(bridge.close);
		const socket = connect(path);
		await once(socket, "connect");
		const result = new Promise<string>((resolve) => {
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk;
			});
			socket.on("close", () => resolve(text));
		});
		socket.write('{"schema":"aoe.pi-refresh.v1",');
		socket.write('"method":"stop","request_id":"fragment"}\n');
		expect(JSON.parse(await result)).toMatchObject({ status: "error", reason: "identity_mismatch" });
	});

	it("never replaces an existing endpoint and rejects public/symlink directories", async () => {
		const { controller, path, directory } = await setup();
		const options = { path, controller, shutdown: async () => {} };
		writeFileSync(path, "do not remove");
		await expect(startRefreshBridge(options)).rejects.toThrow("Unsafe");
		chmodSync(directory, 0o755);
		await expect(startRefreshBridge({ ...options, path: join(directory, "other.sock") })).rejects.toThrow("Unsafe");
		chmodSync(directory, 0o700);
		const link = `${directory}-link`;
		symlinkSync(directory, link);
		cleanup.push(() => unlinkSync(link));
		await expect(startRefreshBridge({ ...options, path: join(link, "other.sock") })).rejects.toThrow("Unsafe");
	});

	it("does not enable for arbitrary SDK environments or partial managed metadata", () => {
		expect(managedRefreshEndpoint({})).toBeUndefined();
		expect(
			managedRefreshEndpoint({
				LEDGER_RUN_ID: `run_${"a".repeat(32)}`,
				AOE_INSTANCE_ID: "b".repeat(16),
				LEDGER_PROFILE: "personal",
				AOE_PROFILE: "personal-ledger",
			}),
		).toBeUndefined();
	});
});
