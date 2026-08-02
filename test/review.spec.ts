import { describe, expect, it } from "vitest";
import { validateReviewOutput } from "../src/reviewer/review";

function reviewWithPath(path: string) {
  return {
    findings: [{
      title: "[P2] Handle the failure",
      body: "The function drops the failed record.",
      priority: 2,
      code_location: { path, line_range: { start: 10, end: 12 } },
    }],
    overall_correctness: "patch is incorrect",
    overall_explanation: "The failed record is lost.",
  };
}

describe("review output", () => {
  it("accepts a repository-relative finding path", () => {
    expect(validateReviewOutput(reviewWithPath("src/reviewer/review.ts")))
      .toMatchObject({ findings: [{ code_location: { path: "src/reviewer/review.ts" } }] });
  });

  it.each(["/workspace/src/reviewer/review.ts", "../review.ts", "src\\review.ts"])(
    "rejects the non-relative path %s",
    (path) => {
      expect(() => validateReviewOutput(reviewWithPath(path))).toThrow(
        "must use a repository-relative path",
      );
    },
  );
});
