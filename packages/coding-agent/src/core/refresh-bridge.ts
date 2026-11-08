import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentSession } from "./agent-session.ts";
import type { SafeStopGate, SafeStopStatus } from "./safe-stop.ts";

export const REFRESH_SCHEMA = "aoe.pi-refresh.v1";
export const REFRESH_MAX_FRAME_BYTES = 16 * 1024;

export interface RefreshIdentity {
	pid: number;
	run_id: string;
	native_id: string;
	cwd: string;
	generation: string;
	instance_id: string;
	profile: string;
	aoe_profile: string;
	lock_hash: string;
	session_file: string | null;
}

export interface RefreshRequest {
	schema: typeof REFRESH_SCHEMA;
	method: "probe" | "stop";
	request_id: string;
	expected?: RefreshIdentity;
}

export interface RefreshResponse {
	schema: typeof REFRESH_SCHEMA;
	request_id: string;
	identity: RefreshIdentity;
	status: SafeStopStatus["status"] | "accepted";
	reason: string;
	resource_discovery: { skill_names: string[]; truncated?: boolean };
}

/** HOST and CORE are checked and fenced in one synchronous call, never isIdle()+shutdown(). */
export class RefreshController {
	private readonly options: {
		getSession: () => AgentSession;
		host: SafeStopGate;
		runtime: SafeStopGate;
		identity: Omit<RefreshIdentity, "native_id" | "cwd" | "generation" | "session_file">;
		/** Must be synchronous, side-effect free, and account for editor, queues and dialogs. */
		checkHost: () => SafeStopStatus;
		/** Disable input synchronously. Cleanup is scheduled separately, after the accepted reply. */
		fenceInput: () => void;
	};

	constructor(options: RefreshController["options"]) {
		this.options = options;
	}

	get identity(): RefreshIdentity {
		const session = this.options.getSession();
		return {
			...this.options.identity,
			native_id: session.sessionId,
			cwd: realpathSync(session.sessionManager.getCwd()),
			generation: session.safeStopGeneration,
			session_file:
				session.sessionFile && existsSync(session.sessionFile) ? realpathSync(session.sessionFile) : null,
		};
	}

	handle(value: unknown): RefreshResponse {
		const identity = this.identity;
		let request_id = "";
		const reply = (status: RefreshResponse["status"], reason: string): RefreshResponse => ({
			schema: REFRESH_SCHEMA,
			request_id,
			identity,
			status,
			reason,
			resource_discovery: {
				skill_names: this.options
					.getSession()
					.resourceLoader.getSkills()
					.skills.map((skill) => skill.name)
					.sort(),
			},
		});
		if (!value || typeof value !== "object") return reply("error", "invalid_request");
		const request = value as Partial<RefreshRequest>;
		if (typeof request.request_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(request.request_id)) {
			request_id = request.request_id;
		}
		if (
			!request_id ||
			request.schema !== REFRESH_SCHEMA ||
			(request.method !== "probe" && request.method !== "stop")
		) {
			return reply("error", "invalid_request");
		}
		const expected = request.expected;
		if (
			(request.method === "stop" && !expected) ||
			(expected && Object.entries(identity).some(([key, value]) => expected[key as keyof RefreshIdentity] !== value))
		) {
			return reply("error", "identity_mismatch");
		}
		const { host, runtime, getSession, checkHost, fenceInput } = this.options;
		if (host.isStopping || runtime.isStopping) return reply("error", "stopping");
		if (host.isBusy || runtime.isBusy) return reply("busy", "host_work");
		const hostStatus = checkHost();
		if (hostStatus.status !== "idle") return reply(hostStatus.status, hostStatus.reason);
		const session = getSession();
		const coreStatus = session.probeSafeStop();
		if (coreStatus.status !== "idle") return reply(coreStatus.status, coreStatus.reason);
		if (request.method === "probe") return reply("idle", "quiescent");
		const result = session.tryBeginSafeStop(expected!);
		if (result.status !== "accepted") return reply(result.status, result.reason);
		host.tryClose();
		runtime.tryClose();
		fenceInput();
		return reply("accepted", "stopping");
	}
}

export interface RefreshBridge {
	close(): Promise<void>;
}

/** Fixed local path only. Never delete an existing socket: it may belong to a live generation. */
export async function startRefreshBridge(options: {
	path: string;
	controller: RefreshController;
	shutdown: () => Promise<void>;
}): Promise<RefreshBridge> {
	const directory = lstatSync(dirname(options.path));
	if (
		!isAbsolute(options.path) ||
		Buffer.byteLength(options.path) > 103 ||
		directory.isSymbolicLink() ||
		!directory.isDirectory() ||
		directory.uid !== process.getuid?.() ||
		(directory.mode & 0o777) !== 0o700 ||
		existsSync(options.path)
	)
		throw new Error("Unsafe refresh socket path");
	const sockets = new Set<Socket>();
	let ready = false;
	let shutdownScheduled = false;
	let closing: Promise<void> | undefined;
	let server: Server;
	const close = (): Promise<void> => {
		closing ??= new Promise<void>((resolve) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => resolve());
		});
		return closing;
	};
	const scheduleShutdown = () => {
		if (shutdownScheduled) return;
		shutdownScheduled = true;
		setImmediate(() => {
			// Cleanup failure leaves admission fenced; there is deliberately no timeout-to-kill.
			void options
				.shutdown()
				.finally(close)
				.catch(() => {});
		});
	};
	server = createServer((socket) => {
		if (!ready || sockets.size >= 32) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		const deadline = setTimeout(() => socket.destroy(), 5000);
		let buffer = Buffer.alloc(0);
		let handled = false;
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(deadline);
			sockets.delete(socket);
		});
		socket.on("data", (chunk: Buffer) => {
			if (handled) return;
			if (buffer.length + chunk.length > REFRESH_MAX_FRAME_BYTES) {
				socket.destroy();
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			handled = true;
			if (newline !== buffer.length - 1) {
				socket.destroy();
				return;
			}
			let response: RefreshResponse;
			try {
				response = options.controller.handle(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
			} catch {
				socket.destroy();
				return;
			}
			if (response.status === "accepted") socket.once("close", scheduleShutdown);
			let frame = `${JSON.stringify(response)}\n`;
			if (Buffer.byteLength(frame) > REFRESH_MAX_FRAME_BYTES) {
				response.resource_discovery = { skill_names: [], truncated: true };
				frame = `${JSON.stringify(response)}\n`;
			}
			if (Buffer.byteLength(frame) > REFRESH_MAX_FRAME_BYTES) {
				socket.destroy();
				return;
			}
			socket.end(frame, () => {
				if (response.status === "accepted") scheduleShutdown();
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.path, () => {
			try {
				chmodSync(options.path, 0o600);
				ready = true;
				resolve();
			} catch (error) {
				server.close();
				reject(error);
			}
		});
	});
	return { close };
}

/** Only managed AoE + Ledger TUI hosts call this; SDK/print/RPC never create a socket. */
export function managedRefreshEndpoint(env: NodeJS.ProcessEnv = process.env):
	| {
			path: string;
			identity: Omit<RefreshIdentity, "native_id" | "cwd" | "generation" | "session_file">;
	  }
	| undefined {
	const run_id = env.LEDGER_RUN_ID;
	const instance_id = env.AOE_INSTANCE_ID;
	const profile = env.LEDGER_PROFILE;
	const aoe_profile = env.AOE_PROFILE;
	const lock_hash = env.LEDGER_LOCK_HASH;
	const uid = process.getuid?.();
	if (
		uid === undefined ||
		!run_id ||
		!/^run_[0-9a-f]{32}$/.test(run_id) ||
		!instance_id ||
		!/^[0-9a-f]{16}$/.test(instance_id) ||
		!profile ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(profile) ||
		!aoe_profile ||
		!/^[a-zA-Z0-9_.-]{1,128}$/.test(aoe_profile) ||
		!lock_hash ||
		!/^[0-9a-f]{64}$/.test(lock_hash)
	)
		return undefined;
	const directory = `/tmp/aoe-pi-refresh-${uid}`;
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
		throw new Error("Unsafe refresh socket directory");
	}
	return {
		path: join(directory, `${run_id}.sock`),
		identity: { pid: process.pid, run_id, instance_id, profile, aoe_profile, lock_hash },
	};
}
