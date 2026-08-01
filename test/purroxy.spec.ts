import { describe, expect, it } from "vitest";
import { resolvePurroxyModel } from "../src/reviewer/purroxy";

describe("Purroxy models", () => {
  it("resolves an OpenAI-compatible route", () => {
    expect(resolvePurroxyModel("openai-priority/gpt-5.4-mini")).toMatchObject({
      id: "gpt-5.4-mini",
      name: "openai-priority/gpt-5.4-mini",
      provider: "purroxy",
      api: "openai-completions",
      baseUrl: "https://main.purroxy.org/openai/priority",
      reasoning: true,
      compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
    });
  });

  it("preserves slashes inside an upstream model ID", () => {
    expect(resolvePurroxyModel("alibaba/kimi/kimi-k2.7-code")).toMatchObject({
      id: "kimi/kimi-k2.7-code",
      api: "openai-completions",
      baseUrl: "https://main.purroxy.org/alibaba",
    });
  });

  it("resolves Anthropic and Google routes", () => {
    expect(resolvePurroxyModel("glm-anthropic/glm-5.2")).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
    });
    expect(resolvePurroxyModel("vertex/gemini-3.1-pro-preview")).toMatchObject({
      api: "google-generative-ai",
      reasoning: true,
    });
  });

  it("inherits exact effort levels and token limits from a known upstream model", () => {
    const model = resolvePurroxyModel("openai/gpt-5.4-mini", (_provider, id) => id === "gpt-5.4-mini"
      ? {
          id,
          name: id,
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh", max: null },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 400_000,
          maxTokens: 128_000,
          compat: { supportsReasoningEffort: true },
        }
      : undefined);

    expect(model).toMatchObject({
      reasoning: true,
      thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh", max: null },
      contextWindow: 400_000,
      maxTokens: 128_000,
      compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
    });
  });

  it("rejects malformed and unknown routes", () => {
    expect(() => resolvePurroxyModel("gpt-5.4-mini")).toThrow(
      "Purroxy models must use purroxy/<route>/<model>",
    );
    expect(() => resolvePurroxyModel("unknown/model")).toThrow("Unknown Purroxy route: unknown");
  });
});
