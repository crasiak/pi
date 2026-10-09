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
		fauxAssistantMessage("aborted tool boundary"),
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

	it("leaves default SDK abort queue-preserving while retaining native ctx.abort recovery", async () => {
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
