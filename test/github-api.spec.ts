import { describe, expect, it, vi } from "vitest";
import { createGitHubApi } from "../src/reviewer/github-api";

function response(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", typeof body === "string" ? "text/plain" : "application/json");
  }
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status: 200, ...init, headers },
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
          accept: "application/vnd.github.v3+json",
          authorization: "token secret",
          "x-github-api-version": "2022-11-28",
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
      accept: "application/vnd.github.diff",
    }));
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/octo/repo/compare/old%2Fsha...new-sha",
    );
  });

  it("submits a pull request review as the token owner", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ id: 1 }));
    const api = createGitHubApi({ token: "user-token", fetch });

    await api.submitPullRequestReview("octo", "repo", 42, {
      body: "Looks good",
      event: "APPROVE",
      commitId: "head-sha",
      comments: [{
        path: "src/index.ts",
        body: "Handle this case",
        line: 12,
        side: "RIGHT",
        startLine: 10,
        startSide: "RIGHT",
      }],
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/octo/repo/pulls/42/reviews",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "token user-token" }),
        body: JSON.stringify({
          body: "Looks good",
          event: "APPROVE",
          commit_id: "head-sha",
          comments: [{
            path: "src/index.ts",
            body: "Handle this case",
            line: 12,
            side: "RIGHT",
            start_line: 10,
            start_side: "RIGHT",
          }],
        }),
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

  it("reads files and searches code without a local checkout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({
        type: "file",
        path: "src/review agent.ts",
        encoding: "base64",
        content: "Y29udGVudA==",
      }))
      .mockResolvedValueOnce(response({ items: [{ path: "src/review agent.ts" }] }));
    const api = createGitHubApi({ token: "secret", fetch });

    await api.getContent("octo", "repo", "src/review agent.ts", "head/sha");
    await api.searchCode("octo", "repo", "ReviewAgent");

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/octo/repo/contents/src%2Freview%20agent.ts?ref=head%2Fsha",
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/search/code?q=ReviewAgent%20repo%3Aocto%2Frepo&per_page=20",
    );
  });

  it("checks commit ancestry before using an incremental diff", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ status: "diverged" }));
    const api = createGitHubApi({ token: "secret", fetch });

    await expect(api.compare("octo", "repo", "old", "head")).resolves.toEqual({
      status: "diverged",
    });
  });

  it("paginates prior comments so older review markers are not lost", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(
        [{ body: "first page" }],
        {
          headers: {
            Link: '<https://api.github.com/repos/octo/repo/issues/42/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/octo/repo/issues/42/comments?per_page=100&page=2>; rel="last"',
          },
        },
      ))
      .mockResolvedValueOnce(response([{ body: "second page" }]));
    const api = createGitHubApi({ token: "secret", fetch });

    await expect(api.getIssueComments("octo", "repo", 42)).resolves.toEqual([
      { body: "first page" },
      { body: "second page" },
    ]);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/octo/repo/issues/42/comments?per_page=100&page=2",
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
      "GitHub API request failed for GET /repos/octo/repo/pulls/42 (403 Forbidden) [request request-123]",
    );
  });

  it("requires an explicitly supplied token", () => {
    expect(() => createGitHubApi({ token: "" })).toThrow(
      "A GitHub token is required",
    );
  });
});
