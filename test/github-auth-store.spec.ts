import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GitHubAuthStore", () => {
  it("stores credentials and consumes OAuth nonces once", async () => {
    const telegramUserId = `test-${crypto.randomUUID()}`;
    const store = env.GITHUB_AUTH_STORE.getByName(telegramUserId);
    const expiresAt = Date.now() + 60_000;
    const nonce = await store.createAuthorizationNonce(telegramUserId, expiresAt);

    await expect(store.consumeAuthorizationNonce(telegramUserId, nonce)).resolves.toBe(true);
    await expect(store.consumeAuthorizationNonce(telegramUserId, nonce)).resolves.toBe(false);

    await store.storeAuthorization(
      telegramUserId,
      { id: 123, login: "octocat" },
      {
        accessToken: "user-access-token",
        tokenType: "bearer",
        scope: "repo",
      },
    );

    const authorization = await store.getAuthorization(telegramUserId);
    expect(authorization).toMatchObject({
      telegramUserId,
      githubUserId: 123,
      githubLogin: "octocat",
      accessToken: "user-access-token",
      scope: "repo",
    });

    await store.deleteAuthorization(telegramUserId);
    await expect(store.getAuthorization(telegramUserId)).resolves.toBeNull();
  });
});
