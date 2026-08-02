import { describe, expect, it } from "vitest";
import { buildReviewSystemPrompt } from "../src/reviewer/system-prompt";

describe("review system prompt", () => {
  it("includes the Simple English rules and review protocol", () => {
    const prompt = buildReviewSystemPrompt({ reviewInstructions: "Find concrete bugs." });

    expect(prompt).toContain("<SIMPLE_ENGLISH_RULES>");
    expect(prompt).toContain("ASD-STE100 Simplified Technical English");
    expect(prompt).toContain("maximum 20 words per sentence");
    expect(prompt).toContain("<HODOR_REVIEW_PROTOCOL>");
    expect(prompt).toContain("repository-relative file path with no leading slash");
    expect(prompt).not.toContain("/workspace");
    expect(prompt).toContain("Call submit_review exactly once");
  });
});
