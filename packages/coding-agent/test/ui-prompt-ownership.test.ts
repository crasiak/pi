import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionUIContext,
	UIPromptEndEvent,
	UIPromptOwner,
	UIPromptStartEvent,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const owner = { namespace: "test", id: "interaction" };
const other = { namespace: "test", id: "other" };
type PromptEvent = UIPromptStartEvent | UIPromptEndEvent;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
async function harness() {
	const events: PromptEvent[] = [];
	const runtime = createExtensionRuntime();
	const input = deferred<string | undefined>();
	const extension = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", (event) => {
				events.push(event);
			});
			pi.on("ui_prompt_end", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", () => {
				input.resolve(undefined);
			});
		},
		"/tmp",
		createEventBus(),
		runtime,
	);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		"/tmp",
		SessionManager.inMemory(),
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
	);
	const custom = deferred<unknown>();
	const raw: ExtensionUIContext = {
		...runner.getUIContext(),
		input: vi.fn(() => input.promise),
		select: vi.fn(async () => "choice"),
		confirm: vi.fn(async () => true),
		editor: vi.fn(async () => "text"),
		custom: vi.fn(() => custom.promise) as ExtensionUIContext["custom"],
	};
	runner.setUIContext(raw, "tui");
	return { runner, raw, ui: runner.getUIContext(), events, input, custom };
}

// CRA-860 / D009: ownership is correlation only; mixed UI must retain the generic intervention event.
describe("UI prompt aggregate ownership", () => {
	it.each(["select", "confirm", "input", "custom"] as const)(
		"propagates %s ownership without changing results or event counts",
		async (kind) => {
			const h = await harness();
			h.input.resolve("text");
			h.custom.resolve("custom result");
			const options = { owner };
			const result =
				kind === "custom"
					? await h.ui.custom(() => ({ render: () => [], invalidate() {} }), options)
					: kind === "input"
						? await h.ui.input("Title", "placeholder", options)
						: kind === "select"
							? await h.ui.select("Title", ["choice"], options)
							: await h.ui.confirm("Title", "message", options);
			expect(result).toBe({ select: "choice", confirm: true, input: "text", custom: "custom result" }[kind]);
			expect(h.events).toEqual(
				["ui_prompt_start", "ui_prompt_end"].map((type) => ({
					type,
					reason: "ui_prompt",
					kind,
					...(kind === "custom" ? {} : { title: "Title" }),
					owner,
				})),
			);
			expect(h.raw[kind]).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		undefined,
		null,
		false,
		"owner",
		[],
		{},
		{ namespace: "test" },
		{ namespace: "", id: "x" },
		{ namespace: "x", id: "" },
		{ namespace: 1, id: "x" },
		{ namespace: "x", id: 1 },
		{ namespace: "x".repeat(257), id: "x" },
		{ namespace: "x", id: "x".repeat(257) },
		{
			get namespace() {
				throw new Error("bad metadata");
			},
			id: "x",
		},
	])("ignores absent/invalid owner %# while still showing UI", async (value) => {
		const h = await harness();
		expect(await h.ui.select("Title", ["choice"], { owner: value as UIPromptOwner })).toBe("choice");
		expect(h.events).toHaveLength(2);
		for (const event of h.events) expect(event).not.toHaveProperty("owner");
	});

	it("accepts the bound, copies values once and freezes the owner snapshot", async () => {
		const h = await harness();
		const source = { namespace: "n".repeat(256), id: "i".repeat(256) };
		const expected = { ...source };
		const p = h.ui.input("A", "", { owner: source });
		source.namespace = "changed";
		source.id = "changed";
		await Promise.resolve();
		expect(h.events[0].owner).toEqual(expected);
		expect(h.events[0].owner).not.toBe(source);
		expect(Object.isFrozen(h.events[0].owner)).toBe(true);
		// Replacing the event field cannot rewrite the aggregate's private copy either.
		h.events[0].owner = other;
		h.input.resolve("answer");
		await p;
		expect(h.events[1].owner).toEqual(expected);
	});

	for (const nested of [
		owner,
		other,
		{ namespace: "other", id: owner.id },
		undefined,
		{ namespace: "", id: "invalid" },
	]) {
		for (const outerFirst of [false, true]) {
			it(`aggregates ${JSON.stringify(nested)}; outer finishes first: ${outerFirst}`, async () => {
				const h = await harness();
				const a = h.ui.input("Outer", "", { owner });
				const b = h.ui.custom(() => ({ render: () => [], invalidate() {} }), { owner: nested });
				await Promise.resolve();
				expect(h.events).toHaveLength(1);
				if (outerFirst) {
					h.input.resolve("a");
					await a;
				} else {
					h.custom.resolve("b");
					await b;
				}
				expect(h.events).toHaveLength(1);
				// Same-owner UI after a contaminating prompt finished must never restore attribution.
				await h.ui.select("Later same owner", ["choice"], { owner });
				if (outerFirst) {
					h.custom.resolve("b");
					await b;
				} else {
					h.input.resolve("a");
					await a;
				}
				expect(h.events).toEqual([
					{ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Outer", owner },
					{
						type: "ui_prompt_end",
						reason: "ui_prompt",
						kind: "input",
						title: "Outer",
						...(nested === owner ? { owner } : {}),
					},
				]);
				await h.ui.select("New interval", ["choice"], { owner: other });
				expect(h.events.slice(2).map((e) => e.owner)).toEqual([other, other]);
			});
		}
	}

	it("unowned outer prompt cannot acquire an owner, including through rebind", async () => {
		const h = await harness();
		const a = h.ui.input("Unowned");
		h.runner.setUIContext(h.raw, "tui");
		await h.runner.getUIContext().select("Owned", [], { owner });
		h.input.resolve(undefined);
		await a;
		expect(h.events).toHaveLength(2);
		for (const event of h.events) expect(event).not.toHaveProperty("owner");
	});

	it("editor remains ordinary unowned UI and contaminates an owned interval", async () => {
		const h = await harness();
		const a = h.ui.input("Outer", "", { owner });
		expect(await h.ui.editor("Editor")).toBe("text");
		h.input.resolve(undefined);
		await a;
		expect(h.events).toHaveLength(2);
		expect(h.events[1]).not.toHaveProperty("owner");
		await h.ui.editor("Standalone");
		expect(h.events[3]).toEqual({ type: "ui_prompt_end", reason: "ui_prompt", kind: "editor", title: "Standalone" });
	});

	it("observes lifecycle settlement while returning the native promise unchanged", async () => {
		const h = await harness();
		const nativePromise = h.input.promise;
		const returned = h.ui.input("Native", "", { owner });
		expect(returned).toBe(nativePromise);
		h.input.resolve("human");
		await expect(returned).resolves.toBe("human");
		expect(h.events.map((event) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
	});

	it.each(["throw", "reject"])("cleans up after %s and resets at depth zero", async (failure) => {
		const h = await harness();
		h.raw.select = () => {
			throw new Error("sync failure");
		};
		if (failure === "throw") expect(() => h.ui.select("Failed", [], { owner })).toThrow("sync failure");
		else {
			const p = h.ui.input("Failed", "", { owner });
			h.input.reject(new Error("async failure"));
			await expect(p).rejects.toThrow("async failure");
		}
		await h.ui.confirm("Next", "", { owner: other });
		expect(h.events.map((e) => e.owner)).toEqual([owner, owner, other, other]);
	});

	it("shutdown cleanup finishes the aggregate; an unbound/new runner has no inherited owner", async () => {
		const h = await harness();
		const a = h.ui.input("Owned", "", { owner });
		await h.ui.editor("Mixed");
		// The registered session_shutdown owner settles the outstanding UI before teardown.
		await h.runner.emit({ type: "session_shutdown", reason: "reload" });
		await a;
		h.runner.invalidate();
		h.runner.setUIContext();
		expect(h.runner.getUIContext().uiPromptOwnership).toBeUndefined();
		expect(h.events).toHaveLength(2);
		expect(h.events[1].owner).toBeUndefined();
		const next = await harness();
		await next.ui.select("Fresh", [], { owner: other });
		expect(next.events.map((e) => e.owner)).toEqual([other, other]);
	});

	it("advertises semantics from the native wrapper, independently of cancellation support", async () => {
		const h = await harness();
		expect(h.raw.uiPromptOwnership).toBeUndefined();
		expect(h.ui.targetedDialogCancellation).toBeUndefined();
		expect(h.ui.uiPromptOwnership).toBe("exclusive-v1");
		for (const mode of ["rpc", "print", "json"] as const) {
			h.runner.setUIContext(
				{ ...h.raw, uiPromptOwnership: "exclusive-v1", targetedDialogCancellation: ["input"] },
				mode,
			);
			expect(h.runner.getUIContext().uiPromptOwnership).toBeUndefined();
		}
	});
});
