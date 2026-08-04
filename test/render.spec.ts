import { describe, expect, it } from "vitest";
import { renderSummaryMarkdown } from "../src/reviewer/render";
import type { ReviewOutput } from "../src/reviewer/types";

function review(findings: ReviewOutput["findings"]): ReviewOutput {
  return {
    findings,
    overall_correctness: findings.length === 0 ? "patch is correct" : "patch is incorrect",
    overall_explanation: findings.length === 0 ? "The patch is correct." : "The patch has an issue.",
  };
}

describe("review summary", () => {
  it("omits the category table for an approval", () => {
    const markdown = renderSummaryMarkdown(review([]));

    expect(markdown).not.toContain("| Category | Count |");
    expect(markdown).toContain("**Overall verdict**: Patch is correct");
  });

  it("omits empty categories when findings exist", () => {
    const markdown = renderSummaryMarkdown(review([{
      title: "[P2] Keep the saved value",
      body: "The update removes the saved value.",
      priority: 2,
      code_location: { path: "src/value.ts", line_range: { start: 10, end: 10 } },
    }]));

    expect(markdown).toContain("| Important (P2) | 1 |");
    expect(markdown).not.toContain("Critical (P0/P1)");
    expect(markdown).not.toContain("Minor (P3)");
  });
});
