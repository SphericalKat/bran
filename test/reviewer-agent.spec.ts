import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("ReviewerAgent GitHub authorization storage", () => {
  it("stores credentials and consumes OAuth nonces once", async () => {
    const telegramUserId = `test-${crypto.randomUUID()}`;
    const agent = env.ReviewerAgent.getByName(telegramUserId);
    const expiresAt = Date.now() + 60_000;
    const nonce = await agent.createOAuthNonce(telegramUserId, expiresAt);

    await expect(agent.consumeOAuthNonce(telegramUserId, nonce)).resolves.toBe(true);
    await expect(agent.consumeOAuthNonce(telegramUserId, nonce)).resolves.toBe(false);

    await agent.storeGitHubAuthorization(
      telegramUserId,
      { id: 123, login: "octocat" },
      {
        accessToken: "user-access-token",
        tokenType: "bearer",
        scope: "",
        expiresIn: 28_800,
        refreshToken: "refresh-token",
        refreshTokenExpiresIn: 15_552_000,
      },
    );

    const authorization = await agent.getGitHubAuthorization(telegramUserId);
    expect(authorization).toMatchObject({
      telegramUserId,
      githubUserId: 123,
      githubLogin: "octocat",
      accessToken: "user-access-token",
      refreshToken: "refresh-token",
    });

    await agent.deleteGitHubAuthorization(telegramUserId);
    await expect(agent.getGitHubAuthorization(telegramUserId)).resolves.toBeNull();
  });
});
