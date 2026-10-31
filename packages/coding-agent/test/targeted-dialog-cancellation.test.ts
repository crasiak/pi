import { type Component, Container, isViewportTUI, type OverlayHandle, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type PrivateMode = {
	createExtensionUIContext(): ExtensionUIContext;
};
function harness(tuiMode: "regular" | "fullscreen") {
	const ui = createInteractiveTui({
		tuiMode,
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal: new VirtualTerminal(),
	});
	// No render scheduler is needed for these ownership tests; retain the actual focus/overlay implementation.
	vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	const status = vi.spyOn(ui.terminal, "setProgramStatus");
	const editor = Object.assign(new Text("draft", 0, 0), { getText: () => "draft", setText: vi.fn() });
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	if (isViewportTUI(ui)) ui.setLayoutRoot(editorContainer);
	ui.setFocus(editor);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		ui,
		renderer: ui,
		editor,
		editorContainer,
		keybindings: new KeybindingsManager(),
		programStatus: new ProgramStatusReporter(
			() => ui.terminal,
			() => undefined,
		),
		extensionDialogClosers: new Map(),
	}) as PrivateMode;
	return { ui, editor, editorContainer, status, ctx: mode.createExtensionUIContext() };
}
const component = () => ({ render: () => ["overlay"], invalidate() {}, dispose: vi.fn() });

// CRA-860: regressions must fail against unpatched Pi, in both native renderers.
describe.each(["regular", "fullscreen"] as const)("targeted extension dialogs (%s)", (tuiMode) => {
	beforeEach(() => initTheme("dark"));
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	it("completing an older overlay preserves the newer overlay and focus", async () => {
		const h = harness(tuiMode);
		const a = component(),
			b = component();
		let finishA!: (value: string) => void, finishB!: (value: string) => void;
		const pa = h.ctx.custom<string>(
			(_ui, _theme, _kb, done) => {
				finishA = done;
				return a;
			},
			{ overlay: true },
		);
		await Promise.resolve();
		const pb = h.ctx.custom<string>(
			(_ui, _theme, _kb, done) => {
				finishB = done;
				return b;
			},
			{ overlay: true },
		);
		await Promise.resolve();
		finishA("a");
		finishA("duplicate");
		expect(await pa).toBe("a");
		expect(h.ui.getFocusedComponent()).toBe(b);
		expect(a.dispose).toHaveBeenCalledTimes(1);
		expect(b.dispose).not.toHaveBeenCalled();
		finishB("b");
		await pb;
		expect(h.ui.hasOverlayEntries).toBe(false);
		expect(h.ui.getFocusedComponent()).toBe(h.editor);
		expect(h.editor.setText).not.toHaveBeenCalled();
	});
	it("early completion cannot pop a foreign overlay and disposes the late factory result", async () => {
		const h = harness(tuiMode),
			foreign = component(),
			late = component();
		h.ui.showOverlay(foreign);
		let deliver!: (c: Component) => void;
		const p = h.ctx.custom(
			(_ui, _theme, _kb, done) => {
				done("early");
				return new Promise<Component>((resolve) => {
					deliver = resolve;
				});
			},
			{ overlay: true },
		);
		expect(await p).toBe("early");
		expect(h.ui.getFocusedComponent()).toBe(foreign);
		deliver(late);
		await Promise.resolve();
		expect(late.dispose).toHaveBeenCalledTimes(1);
		expect(h.ui.getFocusedComponent()).toBe(foreign);
	});
	it("hidden overlay completion removes its entry without showing it", async () => {
		const h = harness(tuiMode);
		let finish!: (value: null) => void, handle!: OverlayHandle;
		const p = h.ctx.custom<null>(
			(_ui, _t, _k, done) => {
				finish = done;
				return component();
			},
			{
				overlay: true,
				onHandle: (v) => {
					handle = v;
				},
			},
		);
		await Promise.resolve();
		handle.setHidden(true);
		finish(null);
		await p;
		expect(h.ui.hasOverlayEntries).toBe(false);
	});
	for (const kind of ["input", "select"] as const) {
		const open = (ctx: ExtensionUIContext, signal: AbortSignal) =>
			kind === "input"
				? ctx.input("Input", "", { signal, timeout: 1000 })
				: ctx.select("Select", ["A"], { signal, timeout: 1000 });
		it(`old ${kind} abort preserves a replacement and removes its listener/timer`, async () => {
			vi.useFakeTimers();
			const h = harness(tuiMode),
				a = new AbortController(),
				b = new AbortController();
			const remove = vi.spyOn(a.signal, "removeEventListener");
			const pa = open(h.ctx, a.signal),
				old = h.editorContainer.children[0]!;
			const dispose = vi.spyOn(old as Component & { dispose(): void }, "dispose");
			const pb = open(h.ctx, b.signal),
				replacement = h.editorContainer.children[0];
			a.abort();
			old.handleInput?.("\r");
			expect(await pa).toBeUndefined();
			expect(h.editorContainer.children).toEqual([replacement]);
			expect(h.ui.getFocusedComponent()).toBe(replacement);
			expect(dispose).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(1);
			b.abort();
			await pb;
			expect(vi.getTimerCount()).toBe(0);
		});
		it.each([false, true])(`${kind} beneath overlay restores a live fallback (replacement %s)`, async (replace) => {
			const h = harness(tuiMode),
				a = new AbortController(),
				b = new AbortController();
			const pa = open(h.ctx, a.signal);
			const overlay = component();
			const handle = h.ui.showOverlay(overlay);
			const pb = replace ? open(h.ctx, b.signal) : undefined;
			const fallback = replace ? h.editorContainer.children[0] : h.editor;
			if (replace) handle.focus();
			a.abort();
			await pa;
			expect(h.ui.getFocusedComponent()).toBe(overlay);
			handle.hide();
			expect(h.ui.getFocusedComponent()).toBe(fallback);
			b.abort();
			await pb;
		});
	}
	// CRA-860: the overlay can precede the dialog, temporarily lending it focus.
	for (const kind of ["input", "select", "confirm"] as const) {
		it.each(["answer", "abort", "timeout"] as const)(
			`restores an older capturing overlay after ${kind} %s`,
			async (finish) => {
				vi.useFakeTimers();
				const h = harness(tuiMode);
				const overlay = component();
				const handle = h.ui.showOverlay(overlay);
				const controller = new AbortController();
				const options = { signal: controller.signal, timeout: 1000 };
				const prompt =
					kind === "input"
						? h.ctx.input("Question", "", options)
						: kind === "select"
							? h.ctx.select("Question", ["A"], options)
							: h.ctx.confirm("Permission", "Proceed?", options);
				const dialog = h.editorContainer.children[0];
				expect(h.ui.getFocusedComponent() === dialog).toBe(true);
				if (finish === "abort") controller.abort();
				else if (finish === "timeout") await vi.advanceTimersByTimeAsync(1000);
				else dialog?.handleInput?.("\r");
				await prompt;
				// showOverlay also queued an xterm cursor write; flush that zero-delay timer, not dialog timers.
				await vi.advanceTimersByTimeAsync(0);
				expect(h.ui.hasOverlay()).toBe(true);
				expect(h.ui.getFocusedComponent() === overlay).toBe(true);
				expect(h.editorContainer.children[0] === h.editor).toBe(true);
				expect(vi.getTimerCount()).toBe(0);
				handle.hide();
				expect(h.ui.getFocusedComponent() === h.editor).toBe(true);
			},
		);
	}
	it.each(["input", "select"] as const)("retiring an old %s preserves Pi1.2 permission status", async (kind) => {
		const h = harness(tuiMode);
		const controller = new AbortController();
		const first =
			kind === "input"
				? h.ctx.input("Old question", "", { signal: controller.signal })
				: h.ctx.select("Old question", ["A"], { signal: controller.signal });
		const confirmation = h.ctx.confirm("New permission", "Proceed?");
		const callsBeforeAbort = h.status.mock.calls.length;
		controller.abort();
		await first;
		expect(h.status).toHaveBeenCalledTimes(callsBeforeAbort);
		expect(h.status.mock.lastCall?.[0]).toMatchObject({
			state: "blocked",
			kind: "permission",
			message: "New permission",
		});
		h.editorContainer.children[0]?.handleInput?.("\r");
		expect(await confirmation).toBe(true);
		expect(h.status.mock.lastCall?.[0]).toMatchObject({ state: "idle" });
	});
	it("advertises exactly the qualified native kinds", () => {
		expect(harness(tuiMode).ctx.targetedDialogCancellation).toEqual(["input", "select", "custom-overlay"]);
	});
	it("a factory mount failure removes only its own overlay", async () => {
		const h = harness(tuiMode),
			c = component();
		const p = h.ctx.custom(() => c, {
			overlay: true,
			onHandle: () => {
				throw new Error("mount");
			},
		});
		await expect(p).rejects.toThrow("mount");
		expect(c.dispose).toHaveBeenCalledTimes(1);
		expect(h.ui.hasOverlayEntries).toBe(false);
	});
	it("input cancellation preserves a foreign selector and its subsequent completion", async () => {
		const h = harness(tuiMode),
			a = new AbortController();
		const pa = h.ctx.input("A", "", { signal: a.signal });
		const pb = h.ctx.select("B", ["B"]),
			b = h.editorContainer.children[0]!;
		a.abort();
		await pa;
		expect(h.editorContainer.children[0] === b).toBe(true);
		b.handleInput?.("\r");
		expect(await pb).toBe("B");
	});
	it("retargets owned descendant references idempotently without changing foreign focus", () => {
		const h = harness(tuiMode),
			retired = new Container(),
			child = component(),
			foreign = component();
		retired.addChild(child);
		h.editorContainer.addChild(retired);
		h.ui.setFocus(child);
		const a = h.ui.showOverlay(component());
		h.ui.setFocus(foreign); // An unrelated non-overlay focus target must not be changed.
		h.editorContainer.addChild(foreign);
		h.editorContainer.removeChild(retired);
		h.ui.retargetFocus(retired, h.editor);
		h.ui.retargetFocus(retired, h.editor);
		expect(h.ui.getFocusedComponent() === foreign).toBe(true);
		a.focus();
		a.hide();
		expect(h.ui.getFocusedComponent() === h.editor).toBe(true);
	});
	it("retargets deferred focus restoration without resurrecting the retired component", () => {
		const h = harness(tuiMode),
			retired = component(),
			overlay = component();
		h.editorContainer.addChild(retired);
		const handle = h.ui.showOverlay(overlay);
		h.ui.setFocus(retired);
		handle.unfocus({ target: retired });
		h.editorContainer.removeChild(retired);
		h.ui.retargetFocus(retired, h.editor);
		handle.hide();
		expect(h.ui.getFocusedComponent() === h.editor).toBe(true);
	});
	it("rejects a cyclic or unmounted fallback", () => {
		const h = harness(tuiMode),
			retired = new Container(),
			child = component();
		retired.addChild(child);
		h.editorContainer.addChild(retired);
		h.ui.setFocus(child);
		h.ui.retargetFocus(retired, child);
		expect(h.ui.getFocusedComponent() === child).toBe(true);
		h.ui.retargetFocus(retired, component());
		expect(h.ui.getFocusedComponent() === child).toBe(true);
	});
});
