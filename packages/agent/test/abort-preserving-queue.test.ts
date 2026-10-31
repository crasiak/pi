import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, runAgentLoop } from "../src/index.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// CRA-860: the queue fence belongs to the aborted run, not to the Agent's future runs.
describe("Agent preserving abort", () => {
	for (const queue of ["steer", "followUp"] as const) {
		for (const phase of ["agent_start", "tool", "turn_end"] as const) {
			it.each(["one-at-a-time", "all"] as const)(
				`retains ${queue} at ${phase} (%s) and resumes only explicitly`,
				async (mode) => {
					const entered = gate(),
						release = gate();
					let active = true;
					const tool: AgentTool = {
						name: "wait",
						label: "Wait",
						description: "Wait for cancellation",
						parameters: Type.Object({}),
						execute: async (_id, _args, signal) => {
							entered.resolve();
							await release.promise;
							signal?.throwIfAborted();
							return { content: [], details: {} };
						},
					};
					let calls = 0;
					const agent = new Agent({
						initialState: { tools: [tool] },
						steeringMode: mode,
						followUpMode: mode,
						streamFn: () => {
							calls++;
							const stream = createAssistantMessageEventStream();
							queueMicrotask(() => {
								const message =
									active && phase === "tool" && calls === 1
										? fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })
										: fauxAssistantMessage("complete");
								stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
							});
							return stream;
						},
					});
					const events: AgentEvent[] = [];
					agent.subscribe(async (event) => {
						events.push(event);
						if (active && event.type === phase) {
							entered.resolve();
							await release.promise;
						}
					});
					const running = agent.prompt("start");
					await entered.promise;
					const original: AgentMessage = {
						role: "user",
						content: [
							{ type: "text", text: "retained" },
							{ type: "image", data: "image", mimeType: "image/png" },
						],
						timestamp: 1,
					};
					const later: AgentMessage = { role: "user", content: "later arrival", timestamp: 2 };
					agent[queue](original);
					agent.abort({ preserveQueue: true });
					agent[queue](later);
					release.resolve();
					await running;
					expect(calls).toBe(phase === "agent_start" ? 0 : 1);
					expect(agent.peekQueuedMessages()[0]).toBe(original);
					expect(
						events.some((e) => e.type === "message_start" && (e.message === original || e.message === later)),
					).toBe(false);
					expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(agent.peekQueuedMessages()[0]).toBe(original);
					active = false;
					// A preserving abort while idle must not arm a fence for the next run.
					agent.abort({ preserveQueue: true });
					await agent.prompt("explicit resume");
					expect(agent.hasQueuedMessages()).toBe(false);
					expect(events.some((e) => e.type === "message_start" && e.message === original)).toBe(true);
					expect(events.some((e) => e.type === "message_start" && e.message === later)).toBe(true);
				},
			);
		}
	}
});

it.each([
	"startup",
	"turn_end",
	"next-turn-preparation",
	"request-preparation",
	"context-transform",
	"llm-conversion",
	"key-resolution",
] as const)("low-level stop predicate fences %s scheduling", async (phase) => {
	let stopped = phase === "startup";
	let turns = 0;
	const events: AgentEvent[] = [];
	const steering = vi.fn(async () => []);
	const followUp = vi.fn(async () => []);
	const request = vi.fn(() => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("complete") }));
		return stream;
	});
	await runAgentLoop(
		[{ role: "user", content: "start", timestamp: 0 }],
		{ messages: [] },
		{
			model: new Agent({ streamFn: request }).state.model,
			convertToLlm: async () => {
				if (phase === "llm-conversion") stopped = true;
				return [];
			},
			transformContext: async (messages) => {
				if (phase === "context-transform") stopped = true;
				return messages;
			},
			getApiKey: async () => {
				if (phase === "key-resolution") stopped = true;
				return undefined;
			},
			shouldStop: () => stopped,
			getSteeringMessages: steering,
			getFollowUpMessages: followUp,
			finishTurn: () =>
				phase === "next-turn-preparation" ? { action: ++turns === 1 ? "continue" : "end" } : undefined,
			prepareNextTurn: async () => {
				stopped = true;
			},
			prepareRequest: async () => {
				if (phase === "request-preparation") stopped = true;
			},
		},
		async (event) => {
			events.push(event);
			if (event.type === "turn_end" && phase === "turn_end") {
				await Promise.resolve();
				stopped = true;
			}
		},
		undefined,
		request,
	);
	expect(request).toHaveBeenCalledTimes(phase === "turn_end" || phase === "next-turn-preparation" ? 1 : 0);
	expect(steering).toHaveBeenCalledTimes(phase === "startup" ? 0 : phase === "next-turn-preparation" ? 2 : 1);
	expect(followUp).toHaveBeenCalledTimes(phase === "next-turn-preparation" ? 1 : 0);
	expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
});

it("finishes transfer of an already-selected message without a new request or silent loss", async () => {
	let stopped = false;
	const selected: AgentMessage = { role: "user", content: "already selected", timestamp: 1 };
	const events: AgentEvent[] = [];
	const request = vi.fn(() => createAssistantMessageEventStream());
	const prepare = vi.fn();
	await runAgentLoop(
		[{ role: "user", content: "start", timestamp: 0 }],
		{ messages: [] },
		{
			model: new Agent({ streamFn: request }).state.model,
			convertToLlm: () => [],
			shouldStop: () => stopped,
			getSteeringMessages: async () => {
				queueMicrotask(() => {
					stopped = true;
				});
				return [selected];
			},
			prepareRequest: prepare,
		},
		(event) => {
			events.push(event);
		},
		undefined,
		request,
	);
	expect(request).not.toHaveBeenCalled();
	expect(prepare).not.toHaveBeenCalled();
	expect(events.filter((event) => event.type === "message_end" && event.message === selected)).toHaveLength(1);
	expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
});

// CRA-860: awaited preparation owns its returned messages even when cancellation stops the next request.
it("finalizes snapshot messages selected before cancellation during awaited next-turn preparation", async () => {
	const entered = gate(),
		release = gate();
	let stopped = false;
	const selected: AgentMessage = {
		role: "user",
		content: [
			{ type: "text", text: "selected by preparation" },
			{ type: "image", data: "image", mimeType: "image/png" },
		],
		timestamp: 1,
	};
	const sourceQueue = [selected];
	const events: AgentEvent[] = [];
	const request = vi.fn(() => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("complete") }));
		return stream;
	});
	const pollsAfterStop = vi.fn();
	const prepare = vi.fn(async () => {
		const messages = sourceQueue.splice(0);
		entered.resolve();
		await release.promise;
		return { messages };
	});
	const running = runAgentLoop(
		[{ role: "user", content: "start", timestamp: 0 }],
		{ messages: [] },
		{
			model: new Agent({ streamFn: request }).state.model,
			convertToLlm: () => [],
			shouldStop: () => stopped,
			finishTurn: () => ({ action: "continue" }),
			getSteeringMessages: async () => {
				if (stopped) pollsAfterStop();
				return [];
			},
			getFollowUpMessages: async () => {
				if (stopped) pollsAfterStop();
				return [];
			},
			prepareNextTurn: prepare,
		},
		(event) => {
			events.push(event);
		},
		undefined,
		request,
	);
	await entered.promise;
	expect(sourceQueue).toHaveLength(0);
	stopped = true;
	release.resolve();
	const messages = await running;
	expect(events.filter((event) => event.type === "message_start" && event.message === selected)).toHaveLength(1);
	expect(events.filter((event) => event.type === "message_end" && event.message === selected)).toHaveLength(1);
	expect(messages.filter((message) => message === selected)).toHaveLength(1);
	const ends = events.filter((event) => event.type === "agent_end");
	expect(ends).toHaveLength(1);
	expect(ends[0]?.type === "agent_end" && ends[0].messages.some((message) => message === selected)).toBe(true);
	expect(sourceQueue).toHaveLength(0);
	expect(request).toHaveBeenCalledTimes(1);
	expect(prepare).toHaveBeenCalledTimes(1);
	expect(pollsAfterStop).not.toHaveBeenCalled();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(request).toHaveBeenCalledTimes(1);
	expect(events.filter((event) => event.type === "message_end" && event.message === selected)).toHaveLength(1);
});

it("does not change ordinary abort queue scheduling", async () => {
	let calls = 0;
	const queued: AgentMessage = { role: "user", content: "ordinary follow-up", timestamp: 1 };
	const agent = new Agent({
		streamFn: () => {
			calls++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("complete") }));
			return stream;
		},
	});
	agent.subscribe((event) => {
		if (event.type === "turn_end" && calls === 1) {
			agent.followUp(queued);
			agent.abort();
		}
	});
	await agent.prompt("start");
	expect(calls).toBe(2);
	expect(agent.hasQueuedMessages()).toBe(false);
	expect(agent.state.messages.some((message) => message === queued)).toBe(true);
});
