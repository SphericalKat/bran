import { Type } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { describe, expect, it, vi } from "vitest";
import { parseModelString, resolveReviewModelList } from "../src/reviewer/model";
import { resolvePurroxyModel } from "../src/reviewer/purroxy";

describe("Purroxy models", () => {
  it("keeps an explicit single-model override", () => {
    expect(resolveReviewModelList({
      model: "purroxy-glm/glm-5.2",
      configuredModels: "purroxy/openai/gpt-5.6-sol,purroxy-kimi/kimi-k3",
    })).toEqual(["purroxy-glm/glm-5.2"]);
  });

  it("uses an explicit model list before other settings", () => {
    expect(resolveReviewModelList({
      models: ["purroxy-kimi/kimi-k3", "purroxy-glm/glm-5.2"],
      model: "purroxy/openai/gpt-5.6-sol",
      configuredModels: "purroxy-alibaba/qwen3.8-max",
    })).toEqual(["purroxy-kimi/kimi-k3", "purroxy-glm/glm-5.2"]);
  });

  it("accepts local Pi Purroxy provider aliases in Worker configuration", () => {
    expect(parseModelString("purroxy-glm/glm-5.2")).toEqual({
      provider: "purroxy",
      modelId: "glm/glm-5.2",
    });
    expect(parseModelString("purroxy-kimi/kimi-k3")).toEqual({
      provider: "purroxy",
      modelId: "kimi/kimi-k3",
    });
    expect(parseModelString("purroxy-alibaba/qwen3.8-max")).toEqual({
      provider: "purroxy",
      modelId: "alibaba/qwen3.8-max",
    });
  });

  it("routes gpt-5.6-sol through Responses so tools retain reasoning", () => {
    expect(resolvePurroxyModel("openai/gpt-5.6-sol")).toMatchObject({
      api: "openai-responses",
      reasoning: true,
    });
  });

  it("sends function tools and reasoning effort to the Responses endpoint", async () => {
    const model = resolvePurroxyModel("openai/gpt-5.6-sol");
    let payload: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "stop after payload capture" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    await openAIResponsesApi().streamSimple(model, {
      messages: [{ role: "user", content: "Review this", timestamp: 1 }],
      tools: [{ name: "submit_review", description: "Submit", parameters: Type.Object({}) }],
    }, {
      apiKey: "test-key",
      reasoning: "high",
      fetch,
      onPayload(value) { payload = value; },
    }).result();

    expect(fetch.mock.calls[0]?.[0]).toBe("https://main.purroxy.org/openai/responses");
    expect(payload).toMatchObject({
      reasoning: { effort: "high" },
      tools: [{ name: "submit_review" }],
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

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

  it("resolves Anthropic, Google, and Kimi routes", () => {
    expect(resolvePurroxyModel("glm-anthropic/glm-5.2")).toMatchObject({
      api: "anthropic-messages",
      reasoning: true,
    });
    expect(resolvePurroxyModel("vertex/gemini-3.1-pro-preview")).toMatchObject({
      api: "google-generative-ai",
      reasoning: true,
    });
    expect(resolvePurroxyModel("kimi/kimi-k3")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://main.purroxy.org/kimi",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        thinkingFormat: "openai",
        requiresReasoningContentOnAssistantMessages: true,
        deferredToolsMode: "kimi",
      },
    });
    expect(resolvePurroxyModel("alibaba/qwen3.8-max")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://main.purroxy.org/alibaba",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: "qwen",
      },
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

  it("rejects malformed and unsafe routes", () => {
    expect(() => resolvePurroxyModel("gpt-5.4-mini")).toThrow(
      "Purroxy models must use purroxy/<route>/<model>",
    );
    expect(() => resolvePurroxyModel("../model")).toThrow("Invalid Purroxy route");
  });
});
