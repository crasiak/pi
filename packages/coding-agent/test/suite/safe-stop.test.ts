import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheWarmer } from "../../src/core/cache-warmer.ts";
import { REFRESH_SCHEMA, RefreshController } from "../../src/core/refresh-bridge.ts";
import { SafeStopGate } from "../../src/core/safe-stop.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { safeStopFixture } from "./fixtures/safe-stop-extension.ts";
import { createHarness, type Harness } from "./harness.ts";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.restoreAllMocks();
});

async function persisted() {
	const directory = mkdtempSync(join(tmpdir(), "pi-stop-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const fixture = safeStopFixture();
	const harness = await createHarness({
		sessionManager: SessionManager.create(directory, directory),
		extensionFactories: [fixture.factory],
	});
	cleanups.push(harness.cleanup);
	// The faux provider is the only custom provider qualified by this audited test participant.
	const model = harness.getModel();
	fixture.api.registerProvider(model.provider, { apiKey: "faux-key", api: model.api, models: [{ ...model }] });
	harness.setResponses([fauxAssistantMessage("persisted")]);
	await harness.session.prompt("history");
	return { ...harness, fixture };
}

function controller(harness: Harness, host = new SafeStopGate(), runtime = new SafeStopGate()) {
	const fenceInput = vi.fn();
	const control = new RefreshController({
		getSession: () => harness.session,
		host,
		runtime,
		identity: {
			pid: process.pid,
			run_id: "run_test",
			instance_id: "instance",
			profile: "personal",
			aoe_profile: "personal-ledger",
			lock_hash: "a".repeat(64),
		},
		checkHost: () => ({ status: "idle", reason: "quiescent" }),
		fenceInput,
	});
	const request = (method: "probe" | "stop" = "stop") => ({
		schema: REFRESH_SCHEMA,
		request_id: "request-1",
		method,
		expected: control.identity,
	});
	return { control, host, runtime, fenceInput, request };
}

// CRA-1153: admission must start before preflight, not at agent_start or isStreaming.
describe("conditional safe stop", () => {
	it("probe never fences; stop fences synchronously, preserves JSONL, and rejects repeats and ingress", async () => {
		const h = await persisted();
		const { control, request, fenceInput } = controller(h);
		const before = readFileSync(h.session.sessionFile!, "utf8");
		expect(control.handle({ schema: REFRESH_SCHEMA, method: "probe", request_id: "discover" }).status).toBe("idle");
		expect(h.session.safeStop.isStopping).toBe(false);
		expect(control.handle(request()).status).toBe("accepted");
		expect(fenceInput).toHaveBeenCalledOnce();
		expect(control.handle(request()).status).toBe("error");
		await expect(h.session.prompt("late")).rejects.toThrow("fenced");
		await expect(h.session.steer("late")).rejects.toThrow("fenced");
		await expect(h.session.followUp("late")).rejects.toThrow("fenced");
		await expect(h.session.sendUserMessage("late")).rejects.toThrow("fenced");
		await expect(
			h.session.sendCustomMessage({ customType: "late", content: "late", display: false }),
		).rejects.toThrow("fenced");
		await expect(h.session.executeBash("never execute")).rejects.toThrow("fenced");
		await expect(h.session.compact()).rejects.toThrow("fenced");
		await expect(h.session.reload()).rejects.toThrow("fenced");
		await expect(h.session.navigateTree("absent")).rejects.toThrow("fenced");
		expect(() => h.fixture.work.beginWork()).toThrow("fenced");
		expect(() => h.fixture.api.sendUserMessage("late")).toThrow("fenced");
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(before);
	});

	it.each(["input", "command"] as const)("refuses during %s preflight without aborting or waiting", async (kind) => {
		const h = await persisted();
		const entered = barrier(),
			finish = barrier();
		if (kind === "input")
			h.fixture.api.on("input", async () => {
				entered.resolve();
				await finish.promise;
				return { action: "handled" };
			});
		else
			h.fixture.api.registerCommand("hold", {
				handler: async () => {
					entered.resolve();
					await finish.promise;
				},
			});
		const pending = h.session.prompt(kind === "command" ? "/hold" : "input");
		await entered.promise;
		expect(h.session.isIdle).toBe(true);
		const abort = vi.spyOn(h.session, "abort");
		const { control, request } = controller(h);
		expect(control.handle(request()).status).toBe("busy");
		expect(abort).not.toHaveBeenCalled();
		expect(h.session.safeStop.isStopping).toBe(false);
		finish.resolve();
		await pending;
		expect(control.handle(request()).status).toBe("accepted");
	});

	it.each(["steer", "followUp", "nextTurn"] as const)("refuses queued %s without clearing it", async (kind) => {
		const h = await persisted();
		if (kind === "nextTurn")
			await h.session.sendCustomMessage(
				{ customType: "aside", content: "saved later", display: false },
				{ deliverAs: "nextTurn" },
			);
		else await h.session[kind]("pending");
		const { control, request } = controller(h);
		expect(control.handle(request())).toMatchObject({ status: "busy", reason: "pending_messages" });
		expect(h.session.safeStop.isStopping).toBe(false);
	});

	it("admits compaction before its abort/wait phase", async () => {
		const h = await persisted();
		const finish = barrier();
		vi.spyOn(h.session, "abort").mockImplementation(() => finish.promise);
		const compact = h.session.compact().catch(() => {});
		const { control, request } = controller(h);
		expect(control.handle(request()).status).toBe("busy");
		finish.resolve();
		await compact;
	});

	it("tracks bash through operations and cleanup", async () => {
		const h = await persisted();
		const entered = barrier(),
			finish = barrier();
		const bash = h.session.executeBash("fixture", undefined, {
			operations: {
				exec: async () => {
					entered.resolve();
					await finish.promise;
					return { exitCode: 0 };
				},
			},
		});
		await entered.promise;
		const { control, request } = controller(h);
		expect(control.handle(request()).status).toBe("busy");
		finish.resolve();
		await bash;
		expect(control.handle(request()).status).toBe("accepted");
	});

	it("refuses owned extension work until release and unqualified extensions by default", async () => {
		const h = await persisted();
		const release = h.fixture.work.beginWork();
		const { control, request } = controller(h);
		expect(control.handle(request())).toMatchObject({ status: "busy", reason: "extension_work" });
		release();
		release();
		h.session.resourceLoader.getExtensions().extensions[0].safeStopQualified = undefined;
		expect(control.handle(request())).toMatchObject({
			status: "unsupported",
			reason: expect.stringContaining("unqualified_extensions:"),
		});
	});

	it("refuses providers registered outside a qualified participant", async () => {
		const h = await persisted();
		h.session.modelRuntime.registerProvider("external", { apiKey: "not-real" });
		const { control, request } = controller(h);
		expect(control.handle(request())).toMatchObject({ status: "unsupported", reason: "unqualified_providers" });
	});

	it("refuses retry sleep without aborting it", async () => {
		const h = await persisted();
		vi.spyOn(h.settingsManager, "getRetrySettings").mockReturnValue({
			enabled: true,
			maxRetries: 1,
			baseDelayMs: 1000,
			maxAgentDelayMs: 60_000,
		});
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		const started = barrier();
		h.session.subscribe((event) => {
			if (event.type === "auto_retry_start") started.resolve();
		});
		vi.useFakeTimers();
		try {
			const pending = h.session.prompt("retry");
			await started.promise;
			const { control, request } = controller(h);
			expect(control.handle(request()).status).toBe("busy");
			await vi.runAllTimersAsync();
			await pending;
			expect(control.handle(request()).status).toBe("accepted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts cache decision work even after cancellation hides its display status", async () => {
		const h = await persisted();
		const entered = barrier(),
			finish = barrier();
		const warmer = new CacheWarmer(
			h.session.modelRuntime,
			h.sessionManager,
			() => "idle",
			async () => {
				entered.resolve();
				await finish.promise;
				return "stop";
			},
		);
		Reflect.set(h.session, "_cacheWarmer", warmer);
		vi.useFakeTimers();
		try {
			warmer.start(
				{ model: { ...h.getModel(), promptCache: { short: 60 } }, context: { messages: [] }, options: {} },
				() => true,
			);
			const { control, request } = controller(h);
			expect(control.handle(request())).toMatchObject({ status: "busy", reason: "cache_warming" });
			vi.advanceTimersByTime(54_000);
			await entered.promise;
			warmer.cancel();
			expect(warmer.status.state).toBe("inactive");
			expect(warmer.hasPendingWork).toBe(true);
			expect(control.handle(request()).status).toBe("busy");
			finish.resolve();
			await vi.runAllTimersAsync();
			expect(warmer.hasPendingWork).toBe(false);
			expect(control.handle(request()).status).toBe("accepted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("refuses in-memory/no-history sessions", async () => {
		const h = await createHarness({ withConfiguredAuth: false });
		cleanups.push(h.cleanup);
		expect(h.session.probeSafeStop()).toMatchObject({ status: "unsupported", reason: "persisted_history_required" });
	});

	it.each(["pid", "run_id", "native_id", "cwd", "generation", "instance_id", "profile", "lock_hash", "session_file"])(
		"binds exact %s and does not fence on mismatch",
		async (key) => {
			const h = await persisted();
			const { control, request } = controller(h);
			const wrong = request();
			Object.assign(wrong.expected, { [key]: "wrong" });
			expect(control.handle(wrong)).toMatchObject({ status: "error", reason: "identity_mismatch" });
			expect(h.session.safeStop.isStopping).toBe(false);
		},
	);

	it("refuses host callbacks and runtime replacements until cleanup", async () => {
		const h = await persisted();
		const { control, request, host, runtime } = controller(h);
		const releaseHost = host.beginWork(),
			releaseRuntime = runtime.beginWork();
		expect(control.handle(request()).status).toBe("busy");
		releaseHost();
		expect(control.handle(request()).status).toBe("busy");
		releaseRuntime();
		expect(control.handle(request()).status).toBe("accepted");
		expect(() => host.beginWork()).toThrow("fenced");
		expect(() => runtime.beginWork()).toThrow("fenced");
	});

	it("rejects an old identity after native session transition", async () => {
		const h = await persisted();
		const { control, request } = controller(h);
		const stale = request();
		h.sessionManager.newSession();
		expect(control.handle(stale)).toMatchObject({ status: "error", reason: "identity_mismatch" });
	});
});
