import { describe, expect, it, vi } from "vitest";
import type { GitHubApi, GitHubPullRequestReview } from "../src/reviewer/github-api";
import { postReviewStructured } from "../src/reviewer/publisher";
import type { ReviewOutput } from "../src/reviewer/types";

describe("structured review publishing", () => {
  it("posts findings inline and requests changes", async () => {
    let submitted: GitHubPullRequestReview | undefined;
    const githubApi = {
      getPullRequestDiff: vi.fn(async () => [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -8,4 +8,5 @@",
        " context",
        "+unsafeCall();",
        "+moreCode();",
        " context",
      ].join("\n")),
      async submitPullRequestReview(_owner, _repo, _number, review) {
        submitted = review;
      },
    } as GitHubApi;
    const review: ReviewOutput = {
      findings: [{
        title: "[P1] Validate input before calling",
        body: "Untrusted input reaches the unsafe call.",
        priority: 1,
        code_location: {
          absolute_file_path: "/workspace/src/example.ts",
          line_range: { start: 9, end: 10 },
        },
        suggestion: "safeCall();",
      }],
      overall_correctness: "patch is incorrect",
      overall_explanation: "The new call is unsafe.",
    };

    await expect(postReviewStructured({
      prUrl: "https://github.com/octo/repo/pull/42",
      review,
      githubApi,
      headSha: "head-sha",
    })).resolves.toMatchObject({
      success: true,
      inlineCreated: 1,
      inlineFailed: 0,
    });

    expect(submitted).toMatchObject({
      event: "REQUEST_CHANGES",
      commitId: "head-sha",
      comments: [{
        path: "src/example.ts",
        line: 10,
        side: "RIGHT",
        startLine: 9,
        startSide: "RIGHT",
      }],
    });
    expect(submitted?.comments?.[0]?.body).toContain("[P1] Validate input before calling");
    expect(submitted?.comments?.[0]?.body).toContain("```suggestion\nsafeCall();\n```");
  });

  it("keeps unresolvable findings out of the inline payload", async () => {
    let submitted: GitHubPullRequestReview | undefined;
    const githubApi = {
      getPullRequestDiff: vi.fn(async () => [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1 @@",
        "+changed();",
      ].join("\n")),
      async submitPullRequestReview(_owner, _repo, _number, review) {
        submitted = review;
      },
    } as GitHubApi;
    const review: ReviewOutput = {
      findings: [{
        title: "[P2] Fix another file",
        body: "This location is not in the diff.",
        priority: 2,
        code_location: {
          absolute_file_path: "/workspace/src/other.ts",
          line_range: { start: 5, end: 5 },
        },
      }],
      overall_correctness: "patch is incorrect",
      overall_explanation: "A finding could not be placed inline.",
    };

    await expect(postReviewStructured({
      prUrl: "https://github.com/octo/repo/pull/42",
      review,
      githubApi,
      workspacePath: "/workspace",
    })).resolves.toMatchObject({ inlineCreated: 0, inlineFailed: 1 });
    expect(submitted?.comments).toBeUndefined();
    expect(submitted?.event).toBe("REQUEST_CHANGES");
    expect(submitted?.body).toContain("This location is not in the diff.");
  });

  it("approves when there are no findings", async () => {
    let submitted: GitHubPullRequestReview | undefined;
    const githubApi = {
      getPullRequestDiff: vi.fn(async () => ""),
      async submitPullRequestReview(_owner, _repo, _number, review) {
        submitted = review;
      },
    } as GitHubApi;

    await postReviewStructured({
      prUrl: "https://github.com/octo/repo/pull/42",
      review: {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No issues found.",
      },
      githubApi,
    });

    expect(submitted?.event).toBe("APPROVE");
    expect(submitted?.comments).toBeUndefined();
  });
});
