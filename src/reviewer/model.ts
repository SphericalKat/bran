import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DiffStats, ReviewDiffMode } from "./review-diff";

export function parseModelString(value: string): { provider: string; modelId: string } {
  const model = value.trim();
  if (!model) throw new Error("Model name must be provided");
  const slash = model.indexOf("/");
  if (slash > 0) {
    const rawProvider = model.slice(0, slash).toLowerCase();
    return {
      provider: rawProvider === "bedrock" ? "amazon-bedrock" : rawProvider,
      modelId: model.slice(slash + 1).replace(/^converse\//, ""),
    };
  }
  if (/^(gpt|o[134])|openai/i.test(model)) return { provider: "openai", modelId: model };
  return { provider: "anthropic", modelId: model };
}

export function resolveModel(value: string): Model<Api> {
  const { provider, modelId } = parseModelString(value);
  if (!getBuiltinProviders().includes(provider as never)) {
    throw new Error(`Unsupported model provider: ${provider}`);
  }
  const model = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!model) throw new Error(`Unknown model: ${value}`);
  return model;
}

export function selectReasoningEffort(options: {
  requested?: string;
  mode: ReviewDiffMode;
  diff: string;
  stats: DiffStats;
}): ThinkingLevel {
  const requested = options.requested?.toLowerCase();
  if (["minimal", "low", "medium", "high", "xhigh", "max"].includes(requested ?? "")) {
    return requested as ThinkingLevel;
  }
  const changedLines = options.stats.additions + options.stats.deletions;
  return options.mode === "incremental" || (options.stats.files <= 10 && changedLines <= 500)
    ? "high"
    : "xhigh";
}
