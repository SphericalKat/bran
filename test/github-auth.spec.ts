import { describe, expect, it, vi } from "vitest";
import { verifyOAuthState } from "../src/auth/github-oauth-client";
import {
  GitHubAuthClient,
  type AuthStore,
} from "../src/auth/github-auth";
import type { GitHubAuthorization } from "../src/auth/github-auth-store";

const now = 1_000_000;
const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://bot.example/auth/github/callback",
};

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

function createStore(current: GitHubAuthorization | null = null): AuthStore {
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
        accessTokenExpiresAt: accessToken.expiresIn === null ? null : storedAt! + accessToken.expiresIn * 1_000,
        refreshTokenExpiresAt: accessToken.refreshTokenExpiresIn === null
          ? null
          : storedAt! + accessToken.refreshTokenExpiresIn * 1_000,
        scope: accessToken.scope,
        updatedAt: storedAt!,
      });
    }),
    getAuthorization: vi.fn().mockImplementation(async () => current),
    getValidAuthorization: vi.fn().mockImplementation(async () => current),
    deleteAuthorization: vi.fn().mockImplementation(async () => { current = null; }),
  };
}

function createAuth(store: AuthStore, fetch = vi.fn<typeof globalThis.fetch>()) {
  return new GitHubAuthClient({
    config,
    stateSecret: "state-secret",
    getStore: () => store,
    fetch,
    now: () => now,
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("GitHub auth", () => {
  it("begins authorization with a nonce-bound, short-lived state", async () => {
    const store = createStore();
    const auth = createAuth(store);

    const url = new URL(await auth.getConnectionUrl("123"));
    const state = await verifyOAuthState(url.searchParams.get("state")!, "state-secret", now);

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(state).toEqual({ telegramUserId: "123", nonce: "nonce", expiresAt: now + 600_000 });
    expect(store.createAuthorizationNonce).toHaveBeenCalledWith("123", now + 600_000);
  });

  it("completes an authorization once and rejects its replay", async () => {
    const store = createStore();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(token()))
      .mockResolvedValueOnce(json({ id: 42, login: "octocat" }));
    const auth = createAuth(store, fetch);
    const callbackUrl = new URL(await auth.getConnectionUrl("123"));
    const state = callbackUrl.searchParams.get("state")!;
    vi.mocked(store.consumeAuthorizationNonce).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(auth.connect(state, "code")).resolves.toEqual({
      status: "connected",
      telegramUserId: "123",
      user: { id: 42, login: "octocat" },
    });
    await expect(auth.connect(state, "code")).resolves.toEqual({ status: "invalid_state" });

    expect(store.storeAuthorization).toHaveBeenCalledWith(
      "123",
      { id: 42, login: "octocat" },
      expect.objectContaining({ accessToken: "access-token" }),
      now,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("delegates valid-token and refresh coordination to the per-user store", async () => {
    const refreshed = authorization({ accessToken: "refreshed-token" });
    const store = createStore();
    vi.mocked(store.getValidAuthorization).mockResolvedValue(refreshed);
    const auth = createAuth(store);

    await expect(auth.getConnection("123")).resolves.toEqual(refreshed);
    expect(store.getValidAuthorization).toHaveBeenCalledWith("123", 300_000, now);
  });

  it("returns null when the store determines that authorization expired", async () => {
    const store = createStore();
    vi.mocked(store.getValidAuthorization).mockResolvedValue(null);
    const auth = createAuth(store);

    await expect(auth.getConnection("123")).resolves.toBeNull();
  });
});
