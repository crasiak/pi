import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./suite/harness.ts";

function interruptibleTool(): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait until the active run is aborted",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			if (!signal?.aborted) {
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			}
			signal?.throwIfAborted();
			return { content: [{ type: "text", text: "unreachable" }], details: {} };
		},
	};
}

async function runningHarness(): Promise<{ harness: Harness; prompt: Promise<void> }> {
	const harness = await createHarness({ tools: [interruptibleTool()] });
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("resumed prompt"),
		fauxAssistantMessage("retained queue"),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_start" || event.toolName !== "wait") return;
			unsubscribe();
			resolve();
		});
	});
	const prompt = harness.session.prompt("start");
	await started;
	return { harness, prompt };
}

async function queueMixedMessages(harness: Harness): Promise<AgentMessage[]> {
	const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
	harness.session.setFollowUpMode("all");
	await harness.session.followUp("human with image", [image]);
	const custom: AgentMessage = {
		role: "custom",
		customType: "queue-preservation",
		content: [{ type: "text", text: "invisible custom" }],
		display: false,
		timestamp: Date.now(),
	};
	harness.session.agent.followUp(custom);
	const queued = harness.session.agent.peekQueuedMessages();
	expect(queued).toHaveLength(2);
	const human = queued[0];
	if (!human || human.role !== "user") throw new Error("Expected queued human message");
	expect(human.content[1]).toBe(image);
	expect(queued[1]).toBe(custom);
	return queued;
}

// CRA-860 / D010: this capability must bypass native editor recovery without recreating queue entries.
describe("ExtensionContext.abortPreservingQueue", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is bound by AgentSession, bypasses the native abort handler, and retains exact queue objects until explicit resumption", async () => {
		const { harness, prompt } = await runningHarness();
		harnesses.push(harness);
		const nativeAbortHandler = vi.fn(() => {
			harness.session.clearQueue();
			void harness.session.abort();
		});
		await harness.session.bindExtensions({ abortHandler: nativeAbortHandler });
		const queued = await queueMixedMessages(harness);
		const ctx = harness.session.extensionRunner.createContext();

		expect(ctx.abortPreservingQueue).toBeTypeOf("function");
		ctx.abortPreservingQueue?.();
		await prompt;

		expect(nativeAbortHandler).not.toHaveBeenCalled();
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.agent.peekQueuedMessages()).toEqual(queued);
		expect(harness.session.agent.peekQueuedMessages()[0]).toBe(queued[0]);
		expect(harness.session.agent.peekQueuedMessages()[1]).toBe(queued[1]);
		const responsesBeforeExplicitResume = harness.getPendingResponseCount();
		expect(responsesBeforeExplicitResume).toBeGreaterThan(0);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.getPendingResponseCount()).toBe(responsesBeforeExplicitResume);
		expect(harness.session.agent.peekQueuedMessages()).toEqual(queued);

		await harness.session.prompt("resume explicitly");
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("retains SDK follow-ups in this tool-cancellation path while keeping native ctx.abort recovery", async () => {
		const defaultRun = await runningHarness();
		harnesses.push(defaultRun.harness);
		await defaultRun.harness.session.bindExtensions({});
		const defaultQueue = await queueMixedMessages(defaultRun.harness);
		defaultRun.harness.session.extensionRunner.createContext().abort();
		await defaultRun.prompt;
		expect(defaultRun.harness.session.agent.peekQueuedMessages()).toEqual(defaultQueue);

		const nativeRun = await runningHarness();
		harnesses.push(nativeRun.harness);
		const nativeAbortHandler = vi.fn(() => {
			nativeRun.harness.session.clearQueue();
			void nativeRun.harness.session.abort();
		});
		await nativeRun.harness.session.bindExtensions({ abortHandler: nativeAbortHandler });
		await queueMixedMessages(nativeRun.harness);
		nativeRun.harness.session.extensionRunner.createContext().abort();
		await nativeRun.prompt;
		expect(nativeAbortHandler).toHaveBeenCalledTimes(1);
		expect(nativeRun.harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	// CRA-860: preserving abort must fence selection, not just bypass editor recovery.
	for (const phase of ["preparation", "tool", "turn-end", "awaited-turn-end"] as const) {
		for (const queue of ["steer", "followUp"] as const) {
			it.each(["one-at-a-time", "all"] as const)(
				`retains ${queue} objects through ${phase} cancellation (%s)`,
				async (mode) => {
					let enter!: () => void;
					let release!: () => void;
					const entered = new Promise<void>((resolve) => {
						enter = resolve;
					});
					const held = new Promise<void>((resolve) => {
						release = resolve;
					});
					let firstRun = true;
					const tool: AgentTool = {
						...interruptibleTool(),
						execute: async (_id, _args, signal) => {
							enter();
							await held;
							signal?.throwIfAborted();
							return { content: [], details: {} };
						},
					};
					const harness = await createHarness({
						tools: [tool],
						settings: { compaction: { enabled: false }, retry: { enabled: false } },
						extensionFactories: [
							(pi) => {
								if (phase === "preparation")
									pi.on("before_agent_start", async () => {
										if (!firstRun) return;
										enter();
										await held;
									});
								if (phase === "turn-end")
									pi.on("turn_end", async () => {
										if (!firstRun) return;
										enter();
										await held;
									});
							},
						],
					});
					harnesses.push(harness);
					harness.session.setSteeringMode(mode);
					harness.session.setFollowUpMode(mode);
					if (phase === "awaited-turn-end")
						harness.session.agent.subscribe(async (event) => {
							if (!firstRun || event.type !== "turn_end") return;
							enter();
							await held;
						});
					const firstResponse =
						phase === "tool"
							? fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })
							: fauxAssistantMessage("first");
					harness.setResponses([firstResponse]);
					const prompt = harness.session.prompt("start");
					await entered;
					const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
					await harness.session[queue]("retained human", [image]);
					const human = harness.session.agent.peekQueuedMessages()[0];
					const custom: AgentMessage = {
						role: "custom",
						customType: "retained-before",
						content: "before abort",
						display: false,
						timestamp: 1,
					};
					harness.session.agent[queue](custom);
					try {
						harness.session.extensionRunner.createContext().abortPreservingQueue?.();
						// Arrivals after the request still belong to the retained queue, not this run.
						const later: AgentMessage = {
							role: "custom",
							customType: "retained-after",
							content: "after abort",
							display: false,
							timestamp: 2,
						};
						harness.session.agent[queue](later);
						release();
						await prompt;
						expect(harness.session.isIdle).toBe(true);
						expect(human?.role).toBe("user");
						if (human?.role !== "user") throw new Error("Missing queued human");
						expect(human.content[1]).toBe(image);
						const retained = [human, custom, later];
						expect(harness.session.agent.peekQueuedMessages()[0]).toBe(human);
						for (const message of retained)
							expect(
								harness.events.some((event) => event.type === "message_start" && event.message === message),
							).toBe(false);
						expect(harness.getPendingResponseCount()).toBe(phase === "preparation" ? 1 : 0);
						const assistants = harness.session.messages.filter((message) => message.role === "assistant");
						expect(assistants).toHaveLength(phase === "preparation" ? 0 : 1);
						await new Promise<void>((resolve) => setImmediate(resolve));
						expect(harness.session.agent.peekQueuedMessages()[0]).toBe(human);
						firstRun = false;
						harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("explicitly resumed")));
						await harness.session.prompt("resume explicitly");
						expect(harness.session.agent.hasQueuedMessages()).toBe(false);
						for (const message of retained)
							expect(
								harness.events.some((event) => event.type === "message_start" && event.message === message),
							).toBe(true);
					} finally {
						release();
						await prompt;
					}
				},
			);
		}
	}

	it("does not launch a late prepared core run after preserving abort and disposal", async () => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						enter();
						await held;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const prompt = harness.session.prompt("start");
		await entered;
		await harness.session.steer("retained after disposal");
		const queued = harness.session.agent.peekQueuedMessages()[0];
		harness.session.extensionRunner.createContext().abortPreservingQueue?.();
		harness.session.dispose();
		release();
		const result = await prompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.agent.peekQueuedMessages()[0]).toBe(queued);
		expect(harness.session.agent.state.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Session is disposed");
	});

	it("does not launch a core run when the prepared-start notification disposes the session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const result = await harness.session.prompt("start", { preflightResult: () => harness.session.dispose() }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.agent.state.isStreaming).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toBe("Session is disposed");
	});

	it("stops a before-settle continuation and rejects a stale captured binding", async () => {
		let boundaryContext: ExtensionContext | undefined;
		let notifyBoundary!: () => void;
		let releaseBoundary!: () => void;
		const boundaryStarted = new Promise<void>((resolve) => {
			notifyBoundary = resolve;
		});
		const boundaryReleased = new Promise<void>((resolve) => {
			releaseBoundary = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", async (_event, ctx) => {
						boundaryContext = ctx;
						notifyBoundary();
						await boundaryReleased;
						return { continue: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must remain unused")]);
		const prompt = harness.session.prompt("boundary");
		await boundaryStarted;
		expect(boundaryContext?.abortPreservingQueue).toBeTypeOf("function");
		boundaryContext?.abortPreservingQueue?.();
		releaseBoundary();
		await prompt;
		expect(harness.getPendingResponseCount()).toBe(1);
		const stale = boundaryContext;
		harness.session.extensionRunner.invalidate("stale binding");
		expect(() => stale?.abortPreservingQueue?.()).toThrow("stale binding");
	});
});
