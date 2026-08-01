import type { ReviewMetrics } from "./types";

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function formatMetricsMarkdown(metrics: ReviewMetrics): string {
  const totalInput = metrics.inputTokens + metrics.cacheReadTokens;
  return [
    `**Review Metrics** — ${metrics.turns} turns, ${metrics.toolCalls} tool calls, ${metrics.durationSeconds}s`,
    `- Tokens: in \`${tokens(totalInput)}\` | out \`${tokens(metrics.outputTokens)}\` | total \`${tokens(metrics.totalTokens)}\``,
    ...(metrics.cost > 0 ? [`- Cost: \`$${metrics.cost.toFixed(4)}\``] : []),
  ].join("\n");
}

export function printMetrics(metrics: ReviewMetrics): void {
  console.log(JSON.stringify({ event: "review_metrics", ...metrics }));
}
