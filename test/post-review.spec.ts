import { describe, expect, it, vi } from "vitest";
import { postReview } from "../src/actions/post-review";
import type { GitHubAuth } from "../src/auth/github-auth";

const input = {
  telegramUserId: "123",
  prUrl: "https://github.com/octo/repo/pull/42",
  message: "Please review this",
  event: "REQUEST_CHANGES" as const,
};

function github(connection: Awaited<ReturnType<GitHubAuth["getConnection"]>>): GitHubAuth {
  return {
    getConnectionUrl: vi.fn(),
    connect: vi.fn(),
    getConnection: vi.fn().mockResolvedValue(connection),
    disconnect: vi.fn(),
  };
}

describe("postReview", () => {
  it("does not publish for a user without a GitHub connection", async () => {
    const publish = vi.fn();
    await expect(postReview(github(null), input, publish)).resolves.toEqual({ status: "not_connected" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("posts using the connected user's token", async () => {
    const publish = vi.fn().mockResolvedValue({ success: true, platform: "github", prNumber: 42 });
    const auth = github({
      telegramUserId: "123",
      githubUserId: 1,
      githubLogin: "octocat",
      accessToken: "user-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      updatedAt: 1,
    });

    await expect(postReview(auth, input, publish)).resolves.toEqual({ status: "posted", githubLogin: "octocat" });
    expect(publish).toHaveBeenCalledWith({
      prUrl: input.prUrl,
      reviewText: input.message,
      githubToken: "user-token",
      event: "REQUEST_CHANGES",
    });
  });

  it("returns the publisher rejection to the caller", async () => {
    const publish = vi.fn().mockResolvedValue({ success: false, platform: "github", error: "Review rejected" });
    const auth = github({
      telegramUserId: "123",
      githubUserId: 1,
      githubLogin: "octocat",
      accessToken: "user-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      updatedAt: 1,
    });

    await expect(postReview(auth, input, publish)).resolves.toEqual({ status: "rejected", message: "Review rejected" });
  });
});
