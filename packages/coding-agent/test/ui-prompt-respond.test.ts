import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionError,
	ExtensionContext,
	ExtensionHandler,
	ExtensionUIContext,
	UIPromptEndEvent,
	UIPromptRespondEvent,
	UIPromptRespondResult,
	UIPromptStartEvent,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const owner = { namespace: "test", id: "interaction" };
type PromptEvent = UIPromptStartEvent | UIPromptEndEvent;
type Responder = ExtensionHandler<UIPromptRespondEvent, UIPromptRespondResult | undefined>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
type RespondFn = (...args: Parameters<Responder>) => unknown;
/** One responder in the "/tmp" extension, or a list loaded as extensions "/tmp/r0", "/tmp/r1", ... */
async function harness(opts: { respond?: RespondFn | RespondFn[] } = {}) {
	const events: PromptEvent[] = [];
	const runtime = createExtensionRuntime();
	const single = typeof opts.respond === "function" ? opts.respond : undefined;
	const extension = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", (event) => {
				events.push(event);
			});
			pi.on("ui_prompt_end", (event) => {
				events.push(event);
			});
			if (single) pi.on("ui_prompt_respond", single as Responder);
		},
		"/tmp",
		createEventBus(),
		runtime,
	);
	const responders = await Promise.all(
		(Array.isArray(opts.respond) ? opts.respond : []).map((respond, i) =>
			loadExtensionFromFactory(
				(pi) => {
					pi.on("ui_prompt_respond", respond as Responder);
				},
				"/tmp",
				createEventBus(),
				runtime,
				`/tmp/r${i}`,
			),
		),
	);
	const runner = new ExtensionRunner(
		[extension, ...responders],
		runtime,
		"/tmp",
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const custom = deferred<unknown>();
	const raw: ExtensionUIContext = {
		...runner.getUIContext(),
		input: vi.fn(async () => "human"),
		select: vi.fn(async () => "choice"),
		confirm: vi.fn(async () => true),
		editor: vi.fn(async () => "text"),
		custom: vi.fn(() => custom.promise) as ExtensionUIContext["custom"],
	};
	runner.setUIContext(raw, "tui");
	const errors: ExtensionError[] = [];
	runner.onError((error) => errors.push(error));
	return { runner, raw, ui: runner.getUIContext(), events, custom, errors };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ui_prompt_respond", () => {
	it.each([
		["select", "choice", (ui: ExtensionUIContext) => ui.select("Pick", ["choice", "other"])],
		["confirm", true, (ui: ExtensionUIContext) => ui.confirm("Sure?", "msg")],
		["input", "typed", (ui: ExtensionUIContext) => ui.input("Name", "ph")],
	] as const)("answers %s without the native dialog", async (kind, value, call) => {
		const h = await harness({ respond: () => ({ value, answered_by: "afk/rules" }) });
		expect(await call(h.ui)).toEqual(value);
		expect(h.raw[kind]).not.toHaveBeenCalled();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.events.map((e) => [e.type, e.answered_by])).toEqual([
			["ui_prompt_start", "afk/rules"],
			["ui_prompt_end", "afk/rules"],
		]);
	});

	it("emits the answered prompt with kind, title and owner", async () => {
		const h = await harness({ respond: () => ({ value: "other", answered_by: "afk/rules" }) });
		expect(await h.ui.select("Pick", ["choice", "other"], { owner })).toBe("other");
		await Promise.resolve();
		await Promise.resolve();
		expect(h.events).toEqual(
			["ui_prompt_start", "ui_prompt_end"].map((type) => ({
				type,
				reason: "ui_prompt",
				kind: "select",
				title: "Pick",
				owner,
				answered_by: "afk/rules",
			})),
		);
	});

	it.each([
		["undefined", () => undefined],
		[
			"throw",
			() => {
				throw new Error("boom");
			},
		],
		["invalid select value", () => ({ value: "not-an-option", answered_by: "afk/rules" })],
		["non-string select value", () => ({ value: true, answered_by: "afk/rules" })],
		["missing answered_by", () => ({ value: "choice" })],
		["empty answered_by", () => ({ value: "choice", answered_by: "" })],
		["oversized answered_by", () => ({ value: "choice", answered_by: "a".repeat(65) })],
	])("falls through to the native dialog on %s", async (_name, respond) => {
		const h = await harness({ respond });
		expect(await h.ui.select("Pick", ["choice"])).toBe("choice");
		expect(h.raw.select).toHaveBeenCalledOnce();
		await Promise.resolve();
		expect(h.events.map((e) => [e.type, e.answered_by])).toEqual([
			["ui_prompt_start", undefined],
			["ui_prompt_end", undefined],
		]);
	});

	it.each([
		["confirm given a string", (ui: ExtensionUIContext) => ui.confirm("Sure?", "msg"), "yes", "confirm"],
		["input given a boolean", (ui: ExtensionUIContext) => ui.input("Name"), true, "input"],
		["input over 4096 chars", (ui: ExtensionUIContext) => ui.input("Name"), "x".repeat(4097), "input"],
	] as const)("falls through on %s", async (_name, call, value, kind) => {
		const h = await harness({ respond: () => ({ value, answered_by: "afk/rules" }) });
		await call(h.ui);
		expect(h.raw[kind]).toHaveBeenCalledOnce();
	});

	it("accepts input at the 4096 char bound", async () => {
		const value = "x".repeat(4096);
		const h = await harness({ respond: () => ({ value, answered_by: "afk/rules" }) });
		expect(await h.ui.input("Name")).toBe(value);
		expect(h.raw.input).not.toHaveBeenCalled();
	});

	it("reports a throwing responder and still lets a later one answer", async () => {
		const h = await harness({
			respond: [
				() => {
					throw new Error("boom");
				},
				() => ({ value: "other", answered_by: "afk/rules" }),
			],
		});
		expect(await h.ui.select("Pick", ["choice", "other"])).toBe("other");
		expect(h.raw.select).not.toHaveBeenCalled();
		expect(h.errors).toEqual([
			expect.objectContaining({ extensionPath: "/tmp/r0", event: "ui_prompt_respond", error: "boom" }),
		]);
	});

	it("asks responders in order and the first valid result wins", async () => {
		const calls: string[] = [];
		const runtime = createExtensionRuntime();
		const load = (name: string, result: UIPromptRespondResult | undefined) =>
			loadExtensionFromFactory(
				(pi) => {
					pi.on("ui_prompt_respond", () => {
						calls.push(name);
						return result;
					});
				},
				`/tmp/${name}`,
				createEventBus(),
				runtime,
			);
		const runner = new ExtensionRunner(
			[
				await load("a", undefined),
				await load("b", { value: "other", answered_by: "b" }),
				await load("c", { value: "choice", answered_by: "c" }),
			],
			runtime,
			"/tmp",
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const select = vi.fn(async () => "choice");
		runner.setUIContext({ ...runner.getUIContext(), select }, "tui");
		expect(await runner.getUIContext().select("Pick", ["choice", "other"])).toBe("other");
		expect(calls).toEqual(["a", "b"]);
		expect(select).not.toHaveBeenCalled();
	});

	it("falls through after the 5 s bound", async () => {
		vi.useFakeTimers();
		const h = await harness({ respond: () => new Promise(() => {}) });
		const pending = h.ui.confirm("Sure?", "msg");
		await vi.advanceTimersByTimeAsync(4999);
		expect(h.raw.confirm).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2);
		expect(await pending).toBe(true);
		expect(h.raw.confirm).toHaveBeenCalledOnce();
	});

	it("calls no later responder once the 5 s bound fires", async () => {
		vi.useFakeTimers();
		const slow = deferred<undefined>();
		const later = vi.fn(() => ({ value: true, answered_by: "afk/rules" }));
		const h = await harness({ respond: [() => slow.promise, later] });
		const pending = h.ui.confirm("Sure?", "msg");
		await vi.advanceTimersByTimeAsync(5001);
		expect(await pending).toBe(true);
		expect(h.raw.confirm).toHaveBeenCalledOnce();
		slow.resolve(undefined);
		await vi.advanceTimersByTimeAsync(0);
		// Count rather than toHaveBeenCalled: printing the call would read ctx getters off a stopped runtime.
		expect(later.mock.calls.length).toBe(0);
	});

	it("gives a responder that opens a dialog the native dialog", async () => {
		const respond = vi.fn(async (_event: UIPromptRespondEvent, ctx: ExtensionContext) => {
			// Guard so a regression recurses once instead of forever.
			if (respond.mock.calls.length > 1) return undefined;
			const ok = await ctx.ui.confirm("Really?", "inner");
			return { value: ok ? "other" : "choice", answered_by: "afk/rules" };
		});
		const h = await harness({ respond });
		expect(await h.ui.select("Pick", ["choice", "other"])).toBe("other");
		expect(respond).toHaveBeenCalledOnce();
		expect(h.raw.confirm).toHaveBeenCalledOnce();
		expect(h.raw.select).not.toHaveBeenCalled();
		expect(h.errors).toEqual([]);
	});

	it("never consults responders for editor or custom", async () => {
		const respond = vi.fn(() => ({ value: "x", answered_by: "afk/yolo" }));
		const h = await harness({ respond });
		await h.ui.editor("Edit", "pre");
		h.custom.resolve("c");
		await h.ui.custom(() => ({ render: () => [], invalidate() {} }));
		expect(respond).not.toHaveBeenCalled();
	});

	it("never consults responders for a prompt nested inside an open prompt", async () => {
		const respond = vi.fn(() => ({ value: "x", answered_by: "afk/yolo" }));
		const h = await harness({ respond });
		const outer = h.ui.custom(() => ({ render: () => [], invalidate() {} }));
		expect(await h.ui.input("Nested")).toBe("human");
		h.custom.resolve("c");
		await outer;
		expect(respond).not.toHaveBeenCalled();
	});

	it("falls through when another prompt opened while responders deliberated", async () => {
		const answer = deferred<UIPromptRespondResult>();
		const h = await harness({ respond: () => answer.promise });
		const pending = h.ui.confirm("Sure?", "msg");
		const other = h.ui.custom(() => ({ render: () => [], invalidate() {} }));
		answer.resolve({ value: false, answered_by: "afk/rules" });
		await vi.waitFor(() => expect(h.raw.confirm).toHaveBeenCalledOnce());
		h.custom.resolve("c");
		await Promise.all([pending, other]);
		for (const event of h.events) expect(event).not.toHaveProperty("answered_by");
	});

	it("passes title, message, options and owner to the responder", async () => {
		const respond = vi.fn(() => undefined);
		const h = await harness({ respond });
		await h.ui.confirm("Sure?", "details", { owner });
		expect(respond).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ui_prompt_respond",
				kind: "confirm",
				title: "Sure?",
				message: "details",
				owner,
			}),
			expect.anything(),
		);
		await h.ui.select("Pick", ["choice", "other"]);
		expect(respond).toHaveBeenLastCalledWith(
			{ type: "ui_prompt_respond", kind: "select", title: "Pick", options: ["choice", "other"] },
			expect.anything(),
		);
	});

	it("leaves behaviour unchanged with no responder", async () => {
		const h = await harness();
		const nativePromise = h.raw.select("Pick", ["choice"]);
		(h.raw.select as ReturnType<typeof vi.fn>).mockClear();
		(h.raw.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(nativePromise);
		const returned = h.ui.select("Pick", ["choice"]);
		expect(returned).toBe(nativePromise);
		expect(await returned).toBe("choice");
		expect(h.events.map((e) => e.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		for (const event of h.events) expect(event).not.toHaveProperty("answered_by");
	});
});
