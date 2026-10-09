import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { InputEventProvenance } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const testGlobal = globalThis as typeof globalThis & { testVar?: unknown };
type ProvenanceSnapshot = { [K in keyof InputEventProvenance]: InputEventProvenance[K] };

describe("Input Event", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		// Clean globalThis test vars
		delete testGlobal.testVar;
	});

	afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

	async function createRunner(...extensions: string[]) {
		// Clear and recreate extensions dir for clean state
		fs.rmSync(extensionsDir, { recursive: true, force: true });
		fs.mkdirSync(extensionsDir);
		for (let i = 0; i < extensions.length; i++) fs.writeFileSync(path.join(extensionsDir, `e${i}.ts`), extensions[i]);
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sm = SessionManager.inMemory();
		const mr = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, sm, mr);
	}

	it("returns continue when no handlers, undefined return, or explicit continue", async () => {
		// No handlers
		expect((await (await createRunner()).emitInput("x", undefined, "interactive")).action).toBe("continue");
		// Returns undefined
		let r = await createRunner(`export default p => p.on("input", async () => {});`);
		expect((await r.emitInput("x", undefined, "interactive")).action).toBe("continue");
		// Returns explicit continue
		r = await createRunner(`export default p => p.on("input", async () => ({ action: "continue" }));`);
		expect((await r.emitInput("x", undefined, "interactive")).action).toBe("continue");
	});

	it("transforms text and preserves images when omitted", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => ({ action: "transform", text: "T:" + e.text }));`,
		);
		const imgs = [{ type: "image" as const, data: "orig", mimeType: "image/png" }];
		const result = await r.emitInput("hi", imgs, "interactive");
		expect(result).toEqual({ action: "transform", text: "T:hi", images: imgs });
	});

	it("transforms and replaces images when provided", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async () => ({ action: "transform", text: "X", images: [{ type: "image", data: "new", mimeType: "image/jpeg" }] }));`,
		);
		const result = await r.emitInput("hi", [{ type: "image", data: "orig", mimeType: "image/png" }], "interactive");
		expect(result).toEqual({
			action: "transform",
			text: "X",
			images: [{ type: "image", data: "new", mimeType: "image/jpeg" }],
		});
	});

	it("chains transforms across multiple handlers", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => ({ action: "transform", text: e.text + "[1]" }));`,
			`export default p => p.on("input", async e => ({ action: "transform", text: e.text + "[2]" }));`,
		);
		const result = await r.emitInput("X", undefined, "interactive");
		expect(result).toEqual({ action: "transform", text: "X[1][2]", images: undefined });
	});

	it("short-circuits on handled and skips subsequent handlers", async () => {
		testGlobal.testVar = false;
		const r = await createRunner(
			`export default p => p.on("input", async () => ({ action: "handled" }));`,
			`export default p => p.on("input", async () => { globalThis.testVar = true; });`,
		);
		expect(await r.emitInput("X", undefined, "interactive")).toEqual({ action: "handled" });
		expect(testGlobal.testVar).toBe(false);
	});

	it("passes source correctly for all source types", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => { globalThis.testVar = e.source; return { action: "continue" }; });`,
		);
		for (const source of ["interactive", "rpc", "extension"] as const) {
			await r.emitInput("x", undefined, source);
			expect(testGlobal.testVar).toBe(source);
		}
	});

	it("passes streamingBehavior correctly", async () => {
		const r = await createRunner(
			`export default p => p.on("input", async e => { globalThis.testVar = e.streamingBehavior; return { action: "continue" }; });`,
		);
		await r.emitInput("x", undefined, "interactive", "steer");
		expect(testGlobal.testVar).toBe("steer");
		await r.emitInput("x", undefined, "interactive", "followUp");
		expect(testGlobal.testVar).toBe("followUp");
		await r.emitInput("x", undefined, "interactive");
		expect(testGlobal.testVar).toBeUndefined();
	});

	it("catches handler errors and continues", async () => {
		const r = await createRunner(`export default p => p.on("input", async () => { throw new Error("boom"); });`);
		const errs: string[] = [];
		r.onError((e) => errs.push(e.error));
		const result = await r.emitInput("x", undefined, "interactive");
		expect(result.action).toBe("continue");
		expect(errs).toContain("boom");
	});

	it("shares provenance with observers before and after a transform", async () => {
		const r = await createRunner(
			`export default p => p.on("input", (e, ctx) => { globalThis.testVar = { views: [e.provenance], before: { ...e.provenance }, markers: [ctx.inputProvenance], texts: [e.text] }; });`,
			`export default p => p.on("input", e => ({ action: "transform", text: "T:" + e.text }));`,
			`export default p => p.on("input", (e, ctx) => { globalThis.testVar.views.push(e.provenance); globalThis.testVar.after = { ...e.provenance }; globalThis.testVar.markers.push(ctx.inputProvenance); globalThis.testVar.texts.push(e.text); });`,
		);

		expect(await r.emitInput("original", undefined, "interactive")).toEqual({
			action: "transform",
			text: "T:original",
			images: undefined,
		});
		const state = testGlobal.testVar as {
			views: InputEventProvenance[];
			before: ProvenanceSnapshot;
			after: ProvenanceSnapshot;
			markers: unknown[];
			texts: string[];
		};
		expect(state.views[0]).toBe(state.views[1]);
		expect(state.before).toEqual({
			source: "interactive",
			settled: false,
			transformed: false,
			handled: false,
			failed: false,
		});
		expect(state.after).toEqual({
			source: "interactive",
			settled: false,
			transformed: true,
			handled: false,
			failed: false,
		});
		expect(state.views[0]?.settled).toBe(true);
		expect(state.markers).toEqual(["pipeline-v1", "pipeline-v1"]);
		expect(state.texts).toEqual(["original", "T:original"]);
	});

	it("keeps transformed true when later transforms restore the original input", async () => {
		const r = await createRunner(
			`export default p => p.on("input", e => ({ action: "transform", text: e.text + "!" }));`,
			`export default p => p.on("input", e => ({ action: "transform", text: e.text.slice(0, -1) }));`,
			`export default p => p.on("input", e => { globalThis.testVar = e.provenance; });`,
		);

		expect(await r.emitInput("same", undefined, "interactive")).toEqual({ action: "continue" });
		const provenance = testGlobal.testVar as InputEventProvenance;
		expect(provenance.transformed).toBe(true);
		expect(provenance.settled).toBe(true);
	});

	it("records a same-content transform without changing the legacy result", async () => {
		const r = await createRunner(
			`export default p => p.on("input", e => { globalThis.testVar = e.provenance; return { action: "transform", text: e.text }; });`,
		);

		expect(await r.emitInput("same", undefined, "interactive")).toEqual({ action: "continue" });
		expect(testGlobal.testVar).toMatchObject({ transformed: true, settled: true });
	});

	it("settles provenance when handled short-circuits the pipeline", async () => {
		testGlobal.testVar = { skipped: false };
		const r = await createRunner(
			`export default p => p.on("input", e => { globalThis.testVar.view = e.provenance; });`,
			`export default p => p.on("input", () => ({ action: "handled" }));`,
			`export default p => p.on("input", () => { globalThis.testVar.skipped = true; });`,
		);

		expect(await r.emitInput("x", undefined, "interactive")).toEqual({ action: "handled" });
		const state = testGlobal.testVar as { view: InputEventProvenance; skipped: boolean };
		expect(state.view).toMatchObject({ settled: true, transformed: false, handled: true, failed: false });
		expect(state.skipped).toBe(false);
	});

	it("records caught handler failures and preserves error continuation", async () => {
		const r = await createRunner(
			`export default p => p.on("input", e => { globalThis.testVar = { view: e.provenance }; throw new Error("boom"); });`,
			`export default p => p.on("input", e => { globalThis.testVar.observed = { ...e.provenance }; });`,
		);
		const errors: string[] = [];
		r.onError((error) => errors.push(error.error));

		expect(await r.emitInput("x", undefined, "interactive")).toEqual({ action: "continue" });
		const state = testGlobal.testVar as { view: InputEventProvenance; observed: ProvenanceSnapshot };
		expect(state.observed).toEqual({
			source: "interactive",
			settled: false,
			transformed: false,
			handled: false,
			failed: true,
		});
		expect(state.view).toMatchObject({ settled: true, failed: true });
		expect(errors).toContain("boom");
	});

	it("exposes an exact frozen getter-backed provenance view", async () => {
		const r = await createRunner(
			`export default p => p.on("input", e => { const descriptors = Object.getOwnPropertyDescriptors(e.provenance); globalThis.testVar = { view: e.provenance, frozen: Object.isFrozen(e.provenance), keys: Object.keys(e.provenance), descriptorKinds: Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, { get: typeof value.get, set: value.set, writable: value.writable }])) , setResult: Reflect.set(e.provenance, "transformed", false) }; });`,
		);

		await r.emitInput("x", undefined, "rpc");
		const state = testGlobal.testVar as {
			view: InputEventProvenance;
			frozen: boolean;
			keys: string[];
			descriptorKinds: Record<string, { get: string; set?: unknown; writable?: boolean }>;
			setResult: boolean;
		};
		expect(state.frozen).toBe(true);
		expect(state.keys).toEqual(["source", "settled", "transformed", "handled", "failed"]);
		expect(state.descriptorKinds).toEqual(
			Object.fromEntries(state.keys.map((key) => [key, { get: "function", set: undefined, writable: undefined }])),
		);
		expect(state.setResult).toBe(false);
		expect(state.view).toEqual({
			source: "rpc",
			settled: true,
			transformed: false,
			handled: false,
			failed: false,
		});
	});

	it("creates distinct provenance views for distinct invocations", async () => {
		testGlobal.testVar = [];
		const r = await createRunner(
			`export default p => p.on("input", e => { globalThis.testVar.push(e.provenance); });`,
		);

		await r.emitInput("one", undefined, "interactive");
		await r.emitInput("two", undefined, "extension");
		const views = testGlobal.testVar as InputEventProvenance[];
		expect(views).toHaveLength(2);
		expect(views[0]).not.toBe(views[1]);
		expect(views.map((view) => view.source)).toEqual(["interactive", "extension"]);
		expect(views.every((view) => view.settled)).toBe(true);
	});

	it("keeps provenance unsettled across the awaited handler boundary", async () => {
		let enter: (() => void) | undefined;
		let release: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		testGlobal.testVar = { enter, gate };
		const r = await createRunner(
			`export default p => p.on("input", async e => { globalThis.testVar.view = e.provenance; globalThis.testVar.enter(); await globalThis.testVar.gate; globalThis.testVar.insideAfterGate = e.provenance.settled; });`,
		);

		const emission = r.emitInput("x", undefined, "interactive");
		await entered;
		const state = testGlobal.testVar as {
			view: InputEventProvenance;
			insideAfterGate?: boolean;
		};
		expect(state.view.settled).toBe(false);
		release?.();
		expect(await emission).toEqual({ action: "continue" });
		expect(state.insideAfterGate).toBe(false);
		expect(state.view.settled).toBe(true);
	});

	it("reports default no-transform provenance without changing the result", async () => {
		const r = await createRunner(
			`export default p => p.on("input", (e, ctx) => { globalThis.testVar = { view: e.provenance, marker: ctx.inputProvenance }; });`,
		);

		expect(await r.emitInput("x", undefined, "interactive")).toEqual({ action: "continue" });
		const state = testGlobal.testVar as { view: InputEventProvenance; marker: unknown };
		expect(state.marker).toBe("pipeline-v1");
		expect(state.view).toEqual({
			source: "interactive",
			settled: true,
			transformed: false,
			handled: false,
			failed: false,
		});
	});

	it("hasHandlers returns correct value", async () => {
		let r = await createRunner();
		expect(r.hasHandlers("input")).toBe(false);
		r = await createRunner(`export default p => p.on("input", async () => {});`);
		expect(r.hasHandlers("input")).toBe(true);
	});
});
