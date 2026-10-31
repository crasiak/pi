import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("admits only the live completed turn boundary and returns the same ticket for repeated requests", async () => {
	let previousContext: ExtensionContext | undefined;
	let previousRequest: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
	let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
	let repeated: typeof ticket;
	const outside: Array<typeof ticket> = [];
	let turns = 0;
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", (_event, ctx) => {
					outside.push(ctx.endRunPreservingQueue?.());
				});
				pi.on("turn_end", (_event, ctx) => {
					if (++turns === 1) {
						previousContext = ctx;
						outside.push(ctx.endRunPreservingQueue?.());
					} else {
						previousRequest = previousContext?.endRunPreservingQueue?.();
						ticket = ctx.endRunPreservingQueue?.();
						repeated = ctx.endRunPreservingQueue?.();
					}
				});
				pi.on("agent_before_settle", (_event, ctx) => {
					outside.push(ctx.endRunPreservingQueue?.());
				});
				pi.on("agent_settled", (_event, ctx) => {
					outside.push(ctx.endRunPreservingQueue?.());
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error" }), fauxAssistantMessage("complete")]);
	try {
		await harness.session.prompt("fails");
		expect(previousContext).toBeDefined();
		await harness.session.prompt("succeeds");
		expect(outside.length).toBeGreaterThan(0);
		expect(outside.every((value) => value === undefined)).toBe(true);
		expect(previousRequest).toBeUndefined();
		expect(ticket).toBeDefined();
		expect(repeated).toBe(ticket);
		// A successful later turn does not erase the prior episode's failure.
		expect(await ticket?.completion).toBe(true);
		expect(Object.isFrozen(ticket)).toBe(true);
	} finally {
		harness.cleanup();
	}
});

it("returns false for awaited extension failures, cancellation, or runtime invalidation after admission", async () => {
	for (const fault of ["turn-handler", "settled-handler", "settled-abort", "invalidated-runtime"] as const) {
		let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (_event, ctx) => {
						ticket = ctx.endRunPreservingQueue?.();
						if (fault === "turn-handler") throw new Error("turn handler failed");
					});
					pi.on("agent_settled", async (_event, ctx) => {
						await Promise.resolve();
						if (fault === "settled-handler") throw new Error("settled handler failed");
						if (fault === "settled-abort") ctx.abortPreservingQueue?.();
						if (fault === "invalidated-runtime") harness.session.extensionRunner.invalidate();
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("complete")]);
		try {
			await harness.session.prompt("start");
			expect(ticket, fault).toBeDefined();
			expect(await ticket?.completion, fault).toBe(false);
			if (fault === "invalidated-runtime") expect(ticket?.isCurrent()).toBe(false);
		} finally {
			harness.cleanup();
		}
	}
});

it("does not prove completion after a later core failure or raw signal cancellation", async () => {
	for (const fault of ["finish-hook", "end-listener", "raw-abort"] as const) {
		let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
		let cancel: (() => void) | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (_event, ctx) => {
						ticket ??= ctx.endRunPreservingQueue?.();
					});
					pi.on("turn_end", () => {
						cancel?.();
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("complete")]);
		if (fault === "raw-abort") cancel = () => harness.session.agent.abort();
		if (fault === "finish-hook") {
			const original = harness.session.agent.finishTurn;
			harness.session.agent.finishTurn = async (turn, signal) => {
				await original?.(turn, signal);
				throw new Error("late finish-hook failure");
			};
		}
		if (fault === "end-listener") {
			let failed = false;
			harness.session.subscribe((event) => {
				if (event.type === "agent_end" && !failed) {
					failed = true;
					throw new Error("late end-listener failure");
				}
			});
		}
		try {
			await harness.session.prompt("start");
			expect(ticket).toBeDefined();
			expect(await ticket?.completion, fault).toBe(false);
		} finally {
			harness.cleanup();
		}
	}
});

it("invalidates a previous ticket before the next prompt's provider-capable preflight", async () => {
	const started = gate(),
		release = gate();
	let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
	let prompts = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("turn_end", (_event, ctx) => {
					ticket ??= ctx.endRunPreservingQueue?.();
				});
				pi.on("before_agent_start", async () => {
					if (++prompts === 2) {
						started.resolve();
						await release.promise;
					}
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await harness.session.prompt("first");
	const previous = ticket;
	expect(await previous?.completion).toBe(true);
	const next = harness.session.prompt("next");
	try {
		await started.promise;
		expect(previous?.isCurrent()).toBe(false);
	} finally {
		release.resolve();
		await next;
		harness.cleanup();
	}
});

it("retains literal terminal-settlement prompts and acknowledges their preflight", async () => {
	const entered = gate(),
		release = gate();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("turn_end", (_event, ctx) => {
					ctx.endRunPreservingQueue?.();
				});
				pi.on("agent_settled", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must remain unused")]);
	const prompt = harness.session.prompt("first");
	try {
		await entered.promise;
		const accepted = vi.fn();
		await harness.session.prompt("/literal-command $ARGUMENTS", {
			expandPromptTemplates: false,
			preflightResult: accepted,
		});
		expect(accepted).toHaveBeenCalledExactlyOnceWith("queued");
		expect(harness.session.getFollowUpMessages()).toEqual(["/literal-command $ARGUMENTS"]);
		release.resolve();
		await prompt;
		expect(harness.getPendingResponseCount()).toBe(1);
	} finally {
		release.resolve();
		await prompt;
		harness.cleanup();
	}
});

it("retains work requested by final persistence notifications", async () => {
	let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
	let queued: Promise<void> | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("turn_end", (_event, ctx) => {
					ticket ??= ctx.endRunPreservingQueue?.();
				});
				pi.on("agent_settled", () => {
					pi.sendMessage(
						{ customType: "final-persist", content: "context only", display: false },
						{ triggerTurn: false },
					);
				});
			},
		],
	});
	harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("must remain unused")]);
	harness.session.subscribe((event) => {
		if (
			event.type === "message_end" &&
			event.message.role === "custom" &&
			event.message.customType === "final-persist" &&
			!queued
		) {
			queued = harness.session.sendCustomMessage(
				{ customType: "retained-from-flush", content: "later", display: false },
				{ triggerTurn: true },
			);
		}
	});
	try {
		await harness.session.prompt("first");
		await queued;
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(await ticket?.completion).toBe(true);
		expect(harness.session.agent.peekQueuedMessages()[0]).toMatchObject({ customType: "retained-from-flush" });
	} finally {
		harness.cleanup();
	}
});

it("requires warmer quiescence at admission and again after final handlers", async () => {
	for (const scenario of ["unsupported", "busy-at-admission", "busy-at-finalization", "quiescent"] as const) {
		let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
		let checks = 0;
		const quiesce = vi.fn(() => {
			checks++;
			return scenario !== "busy-at-admission" && !(scenario === "busy-at-finalization" && checks > 1);
		});
		const warmer = {
			cancel: vi.fn(),
			status: { state: "inactive" as const },
			onAgentSettled: vi.fn(),
			onModeChanged: vi.fn(),
			...(scenario === "unsupported" ? {} : { quiesce }),
		};
		const harness = await createHarness({
			cacheWarmer: warmer,
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (_event, ctx) => {
						ticket = ctx.endRunPreservingQueue?.();
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("complete")]);
		try {
			await harness.session.prompt("start");
			if (scenario === "unsupported" || scenario === "busy-at-admission") {
				expect(ticket).toBeUndefined();
				expect(warmer.onAgentSettled).toHaveBeenCalledOnce();
			} else {
				expect(await ticket?.completion).toBe(scenario === "quiescent");
				expect(warmer.onAgentSettled).not.toHaveBeenCalled();
				expect(quiesce).toHaveBeenCalledTimes(2);
			}
		} finally {
			harness.cleanup();
		}
	}
});

// CRA-863 / D036: a successful effect must end before queue/next-request selection, not by aborting a new request.
it("ends the whole episode, preserves queues and waits for final handlers before proving completion", async () => {
	for (const queue of ["steer", "followUp"] as const) {
		for (const mode of ["one-at-a-time", "all"] as const) {
			const started = gate(),
				finishTool = gate(),
				settled = gate(),
				finishSettled = gate();
			let ticket: ReturnType<NonNullable<ExtensionContext["endRunPreservingQueue"]>>;
			let terminalRequested = false;
			let publicSettled = false;
			const tool: AgentTool = {
				name: "effect",
				label: "Effect",
				description: "Complete a deterministic effect",
				parameters: Type.Object({}),
				execute: async () => {
					started.resolve();
					await finishTool.promise;
					return { content: [{ type: "text", text: "applied" }], details: {} };
				},
			};
			const harness = await createHarness({
				tools: [tool],
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (_event, ctx) => {
							if (terminalRequested) return;
							terminalRequested = true;
							ticket = ctx.endRunPreservingQueue?.();
						});
						pi.on("turn_end", () => (terminalRequested && !publicSettled ? { continue: true } : undefined));
						pi.on("agent_settled", async () => {
							if (publicSettled) return;
							pi.sendMessage(
								{ customType: "settled-work", content: "retain this", display: false },
								{ triggerTurn: true, deliverAs: queue },
							);
							settled.resolve();
							await finishSettled.promise;
						});
					},
				],
			});
			const nativeAbort = vi.fn(() => {
				harness.session.clearQueue();
			});
			await harness.session.bindExtensions({ abortHandler: nativeAbort });
			harness.session.setSteeringMode(mode);
			harness.session.setFollowUpMode(mode);
			harness.session.subscribe((event) => {
				if (event.type === "agent_settled") publicSettled = true;
			});
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" }),
				...Array.from({ length: 6 }, () => fauxAssistantMessage("explicitly resumed")),
			]);
			const queued: AgentMessage[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "queued human" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					timestamp: 1,
				},
				{
					role: "custom",
					customType: "queued-original",
					content: "original custom object",
					display: false,
					timestamp: 2,
				},
			];
			const prompt = harness.session.prompt("start");
			try {
				await started.promise;
				for (const message of queued) harness.session.agent[queue](message);
				finishTool.resolve();
				await settled.promise;
				expect(ticket).toBeDefined();
				if (!ticket) throw new Error("Missing terminal capability");
				const proof = ticket;
				expect(proof.version).toBe(1);
				expect(proof.isCurrent()).toBe(true);
				let completed = false;
				void proof.completion.then(() => {
					completed = true;
				});
				await Promise.resolve();
				expect(completed).toBe(false);
				expect(harness.getPendingResponseCount()).toBe(6);
				finishSettled.resolve();
				await prompt;
				expect(await proof.completion).toBe(true);
				expect(publicSettled).toBe(true);
				expect(nativeAbort).not.toHaveBeenCalled();
				expect(harness.getPendingResponseCount()).toBe(6);
				expect(harness.session.agent.peekQueuedMessages()[0]).toBe(queued[0]);
				expect(harness.session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
				expect(harness.session.messages.some((m) => m.role === "toolResult" && m.isError)).toBe(false);
				expect(harness.session.extensionRunner.createContext().endRunPreservingQueue?.()).toBeUndefined();

				await harness.session.prompt("resume explicitly");
				expect(proof.isCurrent()).toBe(false);
				expect(harness.session.agent.hasQueuedMessages()).toBe(false);
				const delivered = harness.events.filter((e) => e.type === "message_start").map((e) => e.message);
				for (const message of queued) expect(delivered.some((m) => m === message)).toBe(true);
				expect(delivered.some((m) => m.role === "custom" && m.customType === "settled-work")).toBe(true);
				const ctx = harness.session.extensionRunner.createContext();
				harness.session.extensionRunner.invalidate("stale terminal binding");
				expect(() => ctx.endRunPreservingQueue?.()).toThrow("stale terminal binding");
			} finally {
				finishTool.resolve();
				finishSettled.resolve();
				await prompt;
				harness.cleanup();
			}
		}
	}
});
