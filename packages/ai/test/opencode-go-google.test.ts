import { beforeEach, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import type { ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const google = vi.hoisted(() => ({
	stream: vi.fn<ProviderStreams["stream"]>(),
	streamSimple: vi.fn<ProviderStreams["streamSimple"]>(),
}));
vi.mock("../src/api/google-generative-ai.lazy.ts", () => ({ googleGenerativeAIApi: () => google }));
beforeEach(() => {
	google.stream.mockReset().mockImplementation(() => new AssistantMessageEventStream());
	google.streamSimple.mockReset().mockImplementation(() => new AssistantMessageEventStream());
});

it.each(["stream", "streamSimple"] as const)("dispatches pinned OpenCode Go Google models through %s", (method) => {
	const provider = opencodeGoProvider();
	const model = provider.getModels().find((candidate) => candidate.api === "google-generative-ai");
	if (!model) throw new Error("Pinned catalog lacks the advertised OpenCode Go Google model");
	const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
	provider[method](model, context, { apiKey: "fake", sessionId: "fixture-session" });
	expect(google[method]).toHaveBeenCalledWith(
		model,
		context,
		expect.objectContaining({ apiKey: "fake", headers: { "x-opencode-session": "fixture-session" } }),
	);
});
