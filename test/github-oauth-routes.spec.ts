import { describe, expect, it, vi } from "vitest";
import { handleGitHubOAuthCallback } from "../src/auth/github-oauth-routes";
import type { GitHubOAuthService } from "../src/auth/github-oauth-service";

function oauth(result: Awaited<ReturnType<GitHubOAuthService["completeAuthorization"]>>): GitHubOAuthService {
  return {
    beginAuthorization: vi.fn(),
    completeAuthorization: vi.fn().mockResolvedValue(result),
    getAuthorization: vi.fn(),
    disconnect: vi.fn(),
  };
}

function request(path = "/auth/github/callback?state=state&code=code", method = "GET") {
  return new Request(`https://bot.example${path}`, { method });
}

describe("GitHub OAuth callback route", () => {
  it("rejects methods other than GET without completing authorization", async () => {
    const service = oauth({ status: "invalid_state" });

    const response = await handleGitHubOAuthCallback({
      request: request("/auth/github/callback", "POST"),
      oauth: service,
      notifyConnected: vi.fn(),
    });

    expect(response.status).toBe(405);
    expect(service.completeAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid state", { status: "invalid_state" } as const, 400, "invalid, expired, or already used"],
    ["provider failure", { status: "provider_error", error: new Error("GitHub down") } as const, 502, "could not be completed"],
  ])("returns %i for %s", async (_label, result, expectedStatus, body) => {
    const service = oauth(result);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handleGitHubOAuthCallback({
      request: request(),
      oauth: service,
      notifyConnected: vi.fn(),
    });

    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).toContain(body);
    expect(service.completeAuthorization).toHaveBeenCalledWith("state", "code");
    error.mockRestore();
  });

  it("succeeds even when the Telegram connected notification fails", async () => {
    const service = oauth({
      status: "connected",
      telegramUserId: "123",
      user: { id: 1, login: "octocat" },
    });
    const notifyConnected = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await handleGitHubOAuthCallback({ request: request(), oauth: service, notifyConnected });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You are connected as @octocat");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(notifyConnected).toHaveBeenCalledWith("123", "octocat");
    warning.mockRestore();
  });
});
