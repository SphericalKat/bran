import type { Agent } from "@earendil-works/pi-agent-core";
import { validateReviewOutput } from "./review";
import type { ReviewOutput } from "./types";

export function parseReviewFromAssistantText(text: string): ReviewOutput | null {
  const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1])];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return validateReviewOutput(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  return null;
}

export function lastAssistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find((entry) => entry.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}
