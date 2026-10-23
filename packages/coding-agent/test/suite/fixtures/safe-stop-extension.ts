import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { SafeStopParticipant } from "../../../src/core/safe-stop.ts";

/** Test-only audited participant. No stock extension is certified by this fixture. */
export function safeStopFixture() {
	let api: ExtensionAPI;
	let work: SafeStopParticipant;
	return {
		factory(pi: ExtensionAPI) {
			api = pi;
			work = pi.registerSafeStop({ version: 1 });
		},
		get api() {
			return api;
		},
		get work() {
			return work;
		},
	};
}
