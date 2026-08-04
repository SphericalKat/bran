import { describe, expect, it } from "vitest";
import { SUBMIT_REVIEW_SCHEMA } from "../src/reviewer/review";
import { buildReviewSystemPrompt } from "../src/reviewer/system-prompt";

describe("review system prompt", () => {
  it("includes the Simple English rules and review protocol", () => {
    const prompt = buildReviewSystemPrompt({ reviewInstructions: "Find concrete bugs." });

    expect(prompt).toContain("<SIMPLE_ENGLISH_RULES>");
    expect(prompt).toContain("ASD-STE100 Simplified Technical English");
    expect(prompt).toContain("maximum 20 words per sentence");
    expect(prompt).toContain("<HODOR_REVIEW_PROTOCOL>");
    expect(prompt).toContain("Describe the affected product behavior before implementation details");
    expect(prompt).toContain("Do not use ambiguous terms, unexplained domain terms, or jargon");
    expect(prompt).toContain("Name each actor by what it does");
    expect(prompt).toContain("Explain what stored state records instead of calling it a marker or flag");
    expect(prompt).toContain("repository-relative file path with no leading slash");
    expect(prompt).not.toContain("/workspace");
    expect(prompt).toContain("Call submit_review exactly once");
  });

  it("requires suggestions to contain exact replacement code", () => {
    const prompt = buildReviewSystemPrompt({ reviewInstructions: "Find concrete bugs." });

    expect(prompt).toContain("suggestion must contain only the exact replacement source code");
    expect(prompt).toContain("Do not put instructions, explanations, or Markdown fences in suggestion");
    expect(prompt).toContain("omit suggestion");
    expect(JSON.stringify(SUBMIT_REVIEW_SCHEMA)).toContain(
      "Exact replacement source code for the full line range",
    );
  });
});
