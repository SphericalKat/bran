import { describe, expect, it, vi } from "vitest";
import type { GitHubAuthorization } from "../src/auth/github-auth-store";
import { verifyOAuthState } from "../src/auth/github-oauth-client";
import type { AppEnv } from "../src/env";
import { GitHub } from "../src/github";
import type { ReviewResult as GeneratedReview } from "../src/reviewer/agent";
import type { postReviewComment } from "../src/reviewer/publisher";
import type { TelegramReviewProgressTarget } from "../src/telegram/review-progress";

const now = 1_000_000;
const env = {
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_CALLBACK_URL: "https://bot.example/auth/github/callback",
  GITHUB_OAUTH_STATE_SECRET: "state-secret",
  TELEGRAM_BOT_TOKEN: "telegram-token",
} as AppEnv;

function token(overrides = {}) {
  return {
    access_token: "access-token",
    token_type: "bearer",
    scope: "repo",
    expires_in: 28_800,
    refresh_token: "refresh-token",
    refresh_token_expires_in: 15_552_000,
    ...overrides,
  };
}

function authorization(overrides: Partial<GitHubAuthorization> = {}): GitHubAuthorization {
  return {
    telegramUserId: "123",
    githubUserId: 1,
    githubLogin: "octocat",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpiresAt: now + 600_001,
    refreshTokenExpiresAt: now + 1_000_000,
    scope: "repo",
    updatedAt: now - 1,
    ...overrides,
  };
}

function createStore(current: GitHubAuthorization | null = null) {
  return {
    createAuthorizationNonce: vi.fn().mockResolvedValue("nonce"),
    consumeAuthorizationNonce: vi.fn().mockResolvedValue(true),
    storeAuthorization: vi.fn().mockImplementation(async (userId, user, accessToken, storedAt) => {
      current = authorization({
        telegramUserId: userId,
        githubUserId: user.id,
        githubLogin: user.login,
        accessToken: accessToken.accessToken,
        refreshToken: accessToken.refreshToken,
        accessTokenExpiresAt: accessToken.expiresIn === null
          ? null
          : storedAt + accessToken.expiresIn * 1_000,
        refreshTokenExpiresAt: accessToken.refreshTokenExpiresIn === null
          ? null
          : storedAt + accessToken.refreshTokenExpiresIn * 1_000,
        scope: accessToken.scope,
        updatedAt: storedAt,
      });
    }),
    getValidAuthorization: vi.fn().mockImplementation(async () => current),
    deleteAuthorization: vi.fn().mockImplementation(async () => { current = null; }),
  };
}

function createGitHub(
  store = createStore(),
  options: {
    fetch?: typeof globalThis.fetch;
    publish?: typeof postReviewComment;
    runReview?: (input: {
      telegramUserId: string;
      prUrl: string;
      githubToken: string;
      githubLogin: string;
      progress?: TelegramReviewProgressTarget;
    }) => Promise<GeneratedReview>;
  } = {},
) {
  return new GitHub(env, {
    getStore: () => store,
    fetch: options.fetch,
    publish: options.publish,
    runReview: options.runReview,
    now: () => now,
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("GitHub", () => {
  it("creates a nonce-bound, short-lived connection URL", async () => {
    const store = createStore();
    const github = createGitHub(store);

    const url = new URL(await github.connectionUrl("123"));
    const state = await verifyOAuthState(url.searchParams.get("state")!, "state-secret", now);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(state).toEqual({ telegramUserId: "123", nonce: "nonce", expiresAt: now + 600_000 });
    expect(store.createAuthorizationNonce).toHaveBeenCalledWith("123", now + 600_000);
  });

  it("finishes a connection once and rejects its replay", async () => {
    const store = createStore();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(token()))
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }));
    const github = createGitHub(store, { fetch });
    const callbackUrl = new URL(await github.connectionUrl("123"));
    const state = callbackUrl.searchParams.get("state")!;
    store.consumeAuthorizationNonce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(github.finishConnection(state, "code")).resolves.toEqual({
      status: "connected",
      telegramUserId: "123",
      githubLogin: "octocat",
    });
    await expect(github.finishConnection(state, "code")).resolves.toEqual({ status: "invalid_state" });
    expect(store.storeAuthorization).toHaveBeenCalledWith(
      "123",
      { id: 42, login: "octocat" },
      expect.objectContaining({ accessToken: "access-token" }),
      now,
    );
  });

  it("reports connection status without exposing credentials", async () => {
    const store = createStore(authorization());
    const github = createGitHub(store);

    await expect(github.connectedLogin("123")).resolves.toBe("octocat");
    expect(store.getValidAuthorization).toHaveBeenCalledWith("123", 300_000, now);
  });

  it("does not publish a review without a connection", async () => {
    const publish = vi.fn();
    const github = createGitHub(createStore(null), { publish });

    await expect(github.review({
      telegramUserId: "123",
      prUrl: "https://github.com/octo/repo/pull/42",
      message: "Please review this",
      event: "COMMENT",
    })).resolves.toEqual({ status: "not_connected" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("posts a review using the stored connection", async () => {
    const publish = vi.fn().mockResolvedValue({ success: true, platform: "github", prNumber: 42 });
    const github = createGitHub(createStore(authorization()), { publish });

    await expect(github.review({
      telegramUserId: "123",
      prUrl: "https://github.com/octo/repo/pull/42",
      message: "Please review this",
      event: "REQUEST_CHANGES",
    })).resolves.toEqual({ status: "posted", githubLogin: "octocat" });
    expect(publish).toHaveBeenCalledWith({
      prUrl: "https://github.com/octo/repo/pull/42",
      reviewText: "Please review this",
      githubToken: "access-token",
      event: "REQUEST_CHANGES",
    });
  });

  it("runs an automated review job using the OAuth token", async () => {
    const generated: GeneratedReview = {
      review: {
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No blocking problems found.",
      },
      model: "anthropic/test-model",
      metricsFooter: "metrics",
      headSha: "head-sha",
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        cost: 0.01,
        turns: 1,
        toolCalls: 1,
        durationSeconds: 2,
        reused: false,
      },
      workspacePath: "/workspace",
      cacheMarker: null,
      reusedReview: false,
    };
    const runReview = vi.fn().mockResolvedValue(generated);
    const github = createGitHub(createStore(authorization()), {
      runReview,
    });

    await expect(github.reviewPullRequest({
      telegramUserId: "123",
      prUrl: "https://github.com/octo/repo/pull/42",
    })).resolves.toEqual({ status: "posted", githubLogin: "octocat", findings: 0 });
    expect(runReview).toHaveBeenCalledWith({
      telegramUserId: "123",
      prUrl: "https://github.com/octo/repo/pull/42",
      githubToken: "access-token",
      githubLogin: "octocat",
      progress: undefined,
    });
  });

  it("does not run an automated review without a GitHub connection", async () => {
    const runReview = vi.fn();
    const github = createGitHub(createStore(null), { runReview });

    await expect(github.reviewPullRequest({
      telegramUserId: "123",
      prUrl: "https://github.com/octo/repo/pull/42",
    })).resolves.toEqual({ status: "not_connected" });
    expect(runReview).not.toHaveBeenCalled();
  });
});
