import { describe, expect, it, vi } from "vitest";
import { ReviewerAgent, type RunCodeReviewInput } from "../src/agent/ReviewerAgent";
import type { ReviewResult } from "../src/reviewer/agent";

const input: RunCodeReviewInput = {
  prUrl: "https://github.com/octo/repo/pull/42",
  githubToken: "github-token",
  githubLogin: "octocat",
};

const result = {
  review: {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "No blocking problems found.",
  },
} as ReviewResult;

function createAgent(review: Promise<ReviewResult>, deleteAll = vi.fn().mockResolvedValue(undefined)) {
  const agent = Object.create(ReviewerAgent.prototype) as ReviewerAgent;
  Object.assign(agent, {
    activeReview: null,
    ctx: { storage: { deleteAll } },
    performReview: vi.fn().mockReturnValue(review),
  });
  return { agent, deleteAll };
}

describe("ReviewerAgent storage cleanup", () => {
  it("deletes storage after a successful review", async () => {
    const { agent, deleteAll } = createAgent(Promise.resolve(result));

    await expect(agent.runCodeReview(input)).resolves.toBe(result);

    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it("deletes storage after a failed review", async () => {
    const failure = new Error("Review failed");
    const { agent, deleteAll } = createAgent(Promise.reject(failure));

    await expect(agent.runCodeReview(input)).rejects.toBe(failure);

    expect(deleteAll).toHaveBeenCalledOnce();
  });

  it("preserves a successful result when storage cleanup fails", async () => {
    const cleanupFailure = new Error("Storage unavailable");
    const deleteAll = vi.fn().mockRejectedValue(cleanupFailure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { agent } = createAgent(Promise.resolve(result), deleteAll);

    await expect(agent.runCodeReview(input)).resolves.toBe(result);

    expect(warn).toHaveBeenCalledWith("Failed to delete review storage", cleanupFailure);
  });
});
