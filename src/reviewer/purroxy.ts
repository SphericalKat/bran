import type { Api, Model, OpenAICompletionsCompat } from "@earendil-works/pi-ai";

const BASE_URL = "https://main.purroxy.org";

const routes = {
  openai: { path: "openai", api: "openai-completions", metadataProviders: ["openai"] },
  "openai-priority": { path: "openai/priority", api: "openai-completions", metadataProviders: ["openai"] },
  "openai-flex": { path: "openai/flex", api: "openai-completions", metadataProviders: ["openai"] },
  vertex: { path: "google/vertex", api: "google-generative-ai", metadataProviders: ["google"] },
  "vertex-priority": { path: "google/vertex/priority", api: "google-generative-ai", metadataProviders: ["google"] },
  glm: { path: "glm", api: "openai-completions", metadataProviders: ["zai"] },
  "glm-anthropic": { path: "glm/anthropic", api: "anthropic-messages", metadataProviders: ["zai"] },
  alibaba: {
    path: "alibaba",
    api: "openai-completions",
    metadataProviders: ["qwen-token-plan", "moonshotai", "minimax", "zai", "deepseek"],
  },
  "alibaba-anthropic": {
    path: "alibaba/anthropic",
    api: "anthropic-messages",
    metadataProviders: ["qwen-token-plan", "moonshotai", "minimax", "zai", "deepseek"],
  },
} as const satisfies Record<string, { path: string; api: Api; metadataProviders: readonly string[] }>;

export type PurroxyModelLookup = (provider: string, modelId: string) => Model<Api> | undefined;

export function resolvePurroxyModel(value: string, lookup?: PurroxyModelLookup): Model<Api> {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("Purroxy models must use purroxy/<route>/<model>");
  }

  const routeName = value.slice(0, separator);
  const route = routes[routeName as keyof typeof routes];
  if (!route) throw new Error(`Unknown Purroxy route: ${routeName}`);

  const modelId = value.slice(separator + 1);
  const upstream = findUpstreamModel(route.metadataProviders, modelId, lookup);
  const reasoning = upstream?.reasoning ?? inferReasoning(routeName, modelId);
  const compat = route.api === "openai-completions"
    ? openAICompatibility(routeName, modelId, reasoning, upstream)
    : undefined;
  return {
    id: modelId,
    name: `${routeName}/${modelId}`,
    api: route.api,
    provider: "purroxy",
    baseUrl: `${BASE_URL}/${route.path}`,
    reasoning,
    thinkingLevelMap: upstream?.thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: upstream?.contextWindow ?? 128_000,
    maxTokens: upstream?.maxTokens ?? 16_384,
    ...(compat ? { compat } : {}),
  };
}

function findUpstreamModel(
  providers: readonly string[],
  modelId: string,
  lookup: PurroxyModelLookup | undefined,
): Model<Api> | undefined {
  if (!lookup) return undefined;
  const unqualifiedId = modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  for (const provider of providers) {
    for (const candidate of new Set([modelId, unqualifiedId])) {
      const model = lookup(provider, candidate);
      if (model) return model;
    }
  }
  return undefined;
}

function inferReasoning(routeName: string, modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (routeName.startsWith("openai")) return /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/.test(id);
  if (routeName.startsWith("vertex")) {
    return /^(?:gemini-(?:2\.5|[3-9])|gemma-[4-9])/.test(id) && !/(?:embedding|lyria)/.test(id);
  }
  if (routeName.startsWith("glm")) return /^glm-(?:4\.[5-9]|[5-9])/.test(id) && !/(?:image|vision|ocr)/.test(id);
  return /(?:^|\/)(?:qwen3|qwq|deepseek-r1|glm-[5-9])|(?:thinking|reasoning)/.test(id);
}

function openAICompatibility(
  routeName: string,
  modelId: string,
  reasoning: boolean,
  upstream: Model<Api> | undefined,
): OpenAICompletionsCompat | undefined {
  const inherited = upstream?.api === "openai-completions"
    ? upstream.compat as OpenAICompletionsCompat | undefined
    : undefined;
  if (routeName.startsWith("openai") && reasoning) {
    return {
      ...inherited,
      supportsReasoningEffort: inherited?.supportsReasoningEffort ?? true,
      thinkingFormat: inherited?.thinkingFormat ?? "openai",
    };
  }
  if (inherited) return inherited;
  if (!reasoning) return undefined;
  if (routeName === "glm") return { supportsReasoningEffort: true, thinkingFormat: "zai" };

  const id = modelId.toLowerCase();
  if (/(?:^|\/)(?:qwen|qwq)/.test(id)) return { supportsReasoningEffort: false, thinkingFormat: "qwen" };
  if (/(?:^|\/)(?:glm|zhipu)/.test(id)) return { supportsReasoningEffort: true, thinkingFormat: "zai" };
  if (/(?:deepseek|kimi).*(?:r1|thinking|reasoning)/.test(id)) {
    return { supportsReasoningEffort: false, thinkingFormat: "deepseek" };
  }
  return undefined;
}
