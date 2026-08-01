import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubAuthorizationCode,
  fetchGitHubUser,
  refreshGitHubUserAccessToken,
  signOAuthState,
  verifyOAuthState,
} from "../src/auth/github-oauth-client";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("GitHub App OAuth helpers", () => {
  it("builds a GitHub authorization URL with a signed state", () => {
    const url = new URL(buildGitHubAuthorizationUrl({
      clientId: "client-id",
      redirectUri: "https://bot.example/auth/github/callback",
      state: "signed-state",
      login: "octocat",
      allowSignup: false,
    }));

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      redirect_uri: "https://bot.example/auth/github/callback",
      state: "signed-state",
      login: "octocat",
      allow_signup: "false",
    });
  });

  it("verifies state bound to a Telegram user and rejects tampering and expiry", async () => {
    const state = await signOAuthState({
      telegramUserId: "123456789",
      nonce: "nonce",
      expiresAt: 2_000,
    }, "state-secret");

    await expect(verifyOAuthState(state, "state-secret", 1_999)).resolves.toEqual({
      telegramUserId: "123456789",
      nonce: "nonce",
      expiresAt: 2_000,
    });
    await expect(verifyOAuthState(`${state}x`, "state-secret", 1_999)).resolves.toBeNull();
    await expect(verifyOAuthState(state, "state-secret", 2_001)).resolves.toBeNull();
  });

  it("exchanges and refreshes expiring GitHub App user tokens", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({
        access_token: "access-token",
        token_type: "bearer",
        scope: "",
        expires_in: 28_800,
        refresh_token: "refresh-token",
        refresh_token_expires_in: 15_552_000,
      }))
      .mockResolvedValueOnce(response({ access_token: "new-access", expires_in: 28_800 }));
    const config = {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://bot.example/auth/github/callback",
    };

    await expect(exchangeGitHubAuthorizationCode(config, "code", fetch)).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    await expect(refreshGitHubUserAccessToken(config, "refresh-token", fetch)).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: null,
    });

    expect(fetch.mock.calls[0]?.[0]).toBe("https://github.com/login/oauth/access_token");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining("code=code"),
    });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      body: expect.stringContaining("grant_type=refresh_token"),
    });
  });

  it("fetches the authenticated GitHub user without exposing token details in errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ id: 1, login: "octocat" }));
    await expect(fetchGitHubUser("access-token", fetch)).resolves.toEqual({ id: 1, login: "octocat" });
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
    }));
  });
});
