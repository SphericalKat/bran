import { describe, expect, it, vi } from "vitest";
import { handleGitHubCallback } from "../src/auth/github-callback";
import type { GitHub } from "../src/github";

function github(
  result: Awaited<ReturnType<GitHub["finishConnection"]>>,
): Pick<GitHub, "finishConnection"> {
  return { finishConnection: vi.fn().mockResolvedValue(result) };
}

function request(path = "/auth/github/callback?state=state&code=code", method = "GET") {
  return new Request(`https://bot.example${path}`, { method });
}

describe("GitHub OAuth callback route", () => {
  it("rejects methods other than GET", async () => {
    const auth = github({ status: "invalid_state" });
    const response = await handleGitHubCallback({
      request: request("/auth/github/callback", "POST"),
      github: auth,
      notifyConnected: vi.fn(),
    });

    expect(response.status).toBe(405);
    expect(auth.finishConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid state", { status: "invalid_state" } as const, 400, "invalid, expired, or already used"],
    ["provider failure", { status: "provider_error", error: new Error("GitHub down") } as const, 502, "could not be completed"],
  ])("returns %i for %s", async (_label, result, expectedStatus, body) => {
    const auth = github(result);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleGitHubCallback({
      request: request(),
      github: auth,
      notifyConnected: vi.fn(),
    });

    expect(response.status).toBe(expectedStatus);
    expect(await response.text()).toContain(body);
    expect(auth.finishConnection).toHaveBeenCalledWith("state", "code");
    error.mockRestore();
  });

  it("succeeds even when the Telegram notification fails", async () => {
    const auth = github({
      status: "connected",
      telegramUserId: "123",
      githubLogin: "octocat",
    });
    const notifyConnected = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleGitHubCallback({ request: request(), github: auth, notifyConnected });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("You are connected as @octocat");
    expect(notifyConnected).toHaveBeenCalledWith("123", "octocat");
    warning.mockRestore();
  });
});
