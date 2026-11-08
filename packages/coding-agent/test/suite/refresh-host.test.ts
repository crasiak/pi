import { describe, expect, it, vi } from "vitest";
import type { SafeStopStatus } from "../../src/core/safe-stop.ts";
import { SafeStopGate } from "../../src/core/safe-stop.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { OAuthSelectorComponent } from "../../src/modes/interactive/components/oauth-selector.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import type { TreeSelectorComponent } from "../../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import * as clipboard from "../../src/utils/clipboard.ts";

function hostState() {
	const editor = { getText: () => "", getExpandedText: () => "" };
	return {
		refreshWork: new SafeStopGate(),
		isInitialized: true,
		isShuttingDown: false,
		shutdownRequested: false,
		editor,
		pendingUserInputs: [] as string[],
		compactionQueuedMessages: [] as string[],
		pendingTools: new Map(),
		bashComponent: undefined,
		activeSelectorToken: undefined,
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		renderer: { hasOverlayEntries: false, getFocusedComponent: () => editor },
	};
}

type HostState = ReturnType<typeof hostState>;
const host = InteractiveMode.prototype as unknown as {
	checkRefreshHost(this: HostState): SafeStopStatus;
	submitEditorText(this: HostState, text: string): Promise<void>;
	handleBashCommand(
		this: {
			refreshWork: SafeStopGate;
			session: { extensionRunner: { emitUserBash: () => Promise<never> } };
			sessionManager: { getCwd: () => string };
		},
		command: string,
	): Promise<void>;
};

// CRA-1153: HOST must refuse unsaved input and work that has not entered CORE yet.
describe("refresh host admission", () => {
	it("refuses whitespace-only unsaved input", () => {
		const state = hostState();
		state.editor.getExpandedText = () => " \n";
		expect(host.checkRefreshHost.call(state)).toMatchObject({ status: "busy", reason: "editor_input" });
	});
	it.each(["pendingUserInputs", "compactionQueuedMessages"] as const)("refuses %s", (key) => {
		const state = hostState();
		state[key].push("pending");
		expect(host.checkRefreshHost.call(state).status).toBe("busy");
	});
	it("refuses modal input and overlays", () => {
		const state = hostState();
		state.renderer.hasOverlayEntries = true;
		expect(host.checkRefreshHost.call(state).status).toBe("busy");
	});
	it("does not submit input after the fence", async () => {
		const state = hostState();
		state.refreshWork.tryClose();
		await expect(host.submitEditorText.call(state, "late")).rejects.toThrow("fenced");
		expect(state.pendingUserInputs).toEqual([]);
	});
	it("keeps logout busy after its selector dismisses until provider cleanup completes", async () => {
		initTheme("dark");
		let finish!: () => void;
		const wait = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let selector!: OAuthSelectorComponent;
		const done = vi.fn();
		const state = {
			refreshWork: new SafeStopGate(),
			getLogoutProviderOptions: async () => [{ id: "fixture", name: "Fixture", authType: "api_key" as const }],
			showSelector: (factory: (done: () => void) => { component: OAuthSelectorComponent }) => {
				selector = factory(done).component;
			},
			session: { modelRuntime: { logout: () => wait } },
			updateAvailableProviderCount: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const show = Reflect.get(InteractiveMode.prototype, "showOAuthSelector") as (
			this: typeof state,
			mode: "logout",
		) => Promise<void>;
		await show.call(state, "logout");
		const select = Reflect.get(selector, "onSelectCallback") as (id: string) => Promise<void>;
		const pending = select("fixture");
		expect(done).toHaveBeenCalledOnce();
		expect(state.refreshWork.isBusy).toBe(true);
		finish();
		await pending;
		expect(state.refreshWork.isBusy).toBe(false);
	});

	it("retains session loader work after dismissal until the cancelled loader unwinds", async () => {
		initTheme("dark");
		let finish!: () => void;
		const wait = new Promise<[]>((resolve) => {
			finish = () => resolve([]);
		});
		const work = new SafeStopGate();
		const run = vi.spyOn(work, "run");
		let signal: AbortSignal | undefined;
		const selector = new SessionSelectorComponent(
			(_progress, currentSignal) => {
				signal = currentSignal;
				return wait;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ work },
		);
		const pending = run.mock.results[0].value as Promise<void>;
		selector.dispose();
		expect(signal?.aborted).toBe(true);
		expect(work.isBusy).toBe(true);
		expect(work.tryClose()).toBe(false);
		finish();
		await pending;
		expect(work.isBusy).toBe(false);
	});

	it("retains tree copy work after dismissal until clipboard cleanup completes", async () => {
		initTheme("dark");
		let finish!: () => void;
		const wait = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockReturnValue(wait);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "copy me", timestamp: Date.now() });
		let selector!: TreeSelectorComponent;
		const done = vi.fn();
		const state = {
			refreshWork: new SafeStopGate(),
			sessionManager,
			settingsManager: { getTreeFilterMode: () => "default" },
			ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
			showSelector: (factory: (done: () => void) => { component: TreeSelectorComponent }) => {
				selector = factory(done).component;
			},
			showError: vi.fn(),
			showStatus: vi.fn(),
		};
		const show = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof state) => void;
		show.call(state);
		const pending = selector.onCopy?.("copy me");
		done();
		expect(state.refreshWork.isBusy).toBe(true);
		finish();
		await pending;
		expect(state.refreshWork.isBusy).toBe(false);
		copy.mockRestore();
	});

	it("tracks bash preflight before the first extension await", async () => {
		let finish!: () => void;
		const wait = new Promise<never>((_resolve, reject) => {
			finish = () => reject(new Error("fixture refusal"));
		});
		const state = {
			refreshWork: new SafeStopGate(),
			session: { extensionRunner: { emitUserBash: vi.fn(() => wait) } },
			sessionManager: { getCwd: () => "/tmp" },
		};
		const pending = host.handleBashCommand.call(state, "never execute");
		expect(state.refreshWork.isBusy).toBe(true);
		expect(state.refreshWork.tryClose()).toBe(false);
		finish();
		await pending;
		expect(state.refreshWork.isBusy).toBe(false);
	});
});
