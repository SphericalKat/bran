import { describe, expect, it, vi } from "vitest";
import { createReviewActionService } from "../src/actions/review-action-service";
import type { GitHubOAuthService } from "../src/auth/github-oauth-service";

const input = {
  telegramUserId: "123",
  prUrl: "https://github.com/octo/repo/pull/42",
  message: "Please review this",
  event: "REQUEST_CHANGES" as const,
};

function oauth(authorization: Awaited<ReturnType<GitHubOAuthService["getAuthorization"]>>): GitHubOAuthService {
  return {
    beginAuthorization: vi.fn(),
    completeAuthorization: vi.fn(),
    getAuthorization: vi.fn().mockResolvedValue(authorization),
    disconnect: vi.fn(),
  };
}

describe("ReviewActionService", () => {
  it("does not publish for a user without a GitHub connection", async () => {
    const publish = vi.fn();
    const service = createReviewActionService(oauth(null), publish);

    await expect(service.execute(input)).resolves.toEqual({ status: "not_connected" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("posts using the connected user's token", async () => {
    const publish = vi.fn().mockResolvedValue({ success: true, platform: "github", prNumber: 42 });
    const service = createReviewActionService(oauth({
      telegramUserId: "123",
      githubUserId: 1,
      githubLogin: "octocat",
      accessToken: "user-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      updatedAt: 1,
    }), publish);

    await expect(service.execute(input)).resolves.toEqual({ status: "posted", githubLogin: "octocat" });
    expect(publish).toHaveBeenCalledWith({
      prUrl: input.prUrl,
      reviewText: input.message,
      githubToken: "user-token",
      event: "REQUEST_CHANGES",
    });
  });

  it("returns the publisher rejection to the caller", async () => {
    const publish = vi.fn().mockResolvedValue({ success: false, platform: "github", error: "Review rejected" });
    const service = createReviewActionService(oauth({
      telegramUserId: "123",
      githubUserId: 1,
      githubLogin: "octocat",
      accessToken: "user-token",
      refreshToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      updatedAt: 1,
    }), publish);

    await expect(service.execute(input)).resolves.toEqual({ status: "rejected", message: "Review rejected" });
  });
});
