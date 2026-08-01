import { describe, expect, it, vi } from "vitest";
import { createGitHubApi } from "../src/reviewer/github-api";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, ...init },
  );
}

describe("GitHub API", () => {
  it("loads pull request refs with Worker-native fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      base: { ref: "main", sha: "base-sha" },
      head: { ref: "feature", sha: "head-sha" },
    }));
    const api = createGitHubApi({ token: "secret", fetch });

    await expect(api.getPullRequest("octo", "repo", 42)).resolves.toEqual({
      base: { ref: "main", sha: "base-sha" },
      head: { ref: "feature", sha: "head-sha" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/pulls/42",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          Authorization: "Bearer secret",
        }),
      }),
    );
  });

  it("requests PR and compare diffs using GitHub's diff media type", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response("pr diff"))
      .mockResolvedValueOnce(response("compare diff"));
    const api = createGitHubApi({ token: "secret", fetch });

    await expect(api.getPullRequestDiff("octo", "repo", 42)).resolves.toBe("pr diff");
    await expect(api.compareDiff("octo", "repo", "old/sha", "new-sha")).resolves.toBe("compare diff");

    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({
      Accept: "application/vnd.github.diff",
    }));
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/octo/repo/compare/old%2Fsha...new-sha",
    );
  });

  it("submits a pull request review as the token owner", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ id: 1 }));
    const api = createGitHubApi({ token: "user-token", fetch });

    await api.submitPullRequestReview("octo", "repo", 42, "Looks good", "APPROVE");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer user-token" }),
        body: JSON.stringify({ body: "Looks good", event: "APPROVE" }),
      }),
    );
  });

  it("resolves target branches and URL-encodes branch names", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({
      name: "release/v2",
      commit: { sha: "release-sha" },
    }));
    const api = createGitHubApi({ token: "secret", fetch });

    await api.getBranch("octo", "repo", "release/v2");

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/octo/repo/branches/release%2Fv2",
    );
  });

  it("reports GitHub failures without exposing the token or response body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(
      { message: "token secret" },
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "x-github-request-id": "request-123" },
      },
    ));
    const api = createGitHubApi({ token: "secret", fetch });

    await expect(api.getPullRequest("octo", "repo", 42)).rejects.toThrow(
      "GitHub API request failed (403 Forbidden) [request request-123]",
    );
  });

  it("requires an explicitly supplied token", () => {
    expect(() => createGitHubApi({ token: "" })).toThrow(
      "A GitHub token is required",
    );
  });
});
