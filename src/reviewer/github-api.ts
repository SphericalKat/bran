const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubPullRequestRef {
  ref: string;
  sha: string;
}

export interface GitHubPullRequest {
  base: GitHubPullRequestRef;
  head: GitHubPullRequestRef;
  title?: string;
  body?: string | null;
  state?: string;
  changed_files?: number;
  user?: { login: string };
  labels?: Array<{ name: string }>;
}

export interface GitHubComment {
  body?: string;
  created_at?: string;
  user?: { login: string };
}

export type GitHubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

export interface GitHubApi {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest>;
  getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
  compareDiff(owner: string, repo: string, base: string, head: string): Promise<string>;
  getIssueComments(owner: string, repo: string, prNumber: number): Promise<GitHubComment[]>;
  getPullRequestReviews(owner: string, repo: string, prNumber: number): Promise<GitHubComment[]>;
  submitPullRequestReview(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
    event?: GitHubReviewEvent,
  ): Promise<void>;
}

export function createGitHubApi(options: {
  token: string;
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
}): GitHubApi {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");

  if (!options.token) {
    throw new Error("A GitHub token is required to review a pull request");
  }

  const request = async <T>(
    path: string,
    accept: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Accept: accept,
        Authorization: `Bearer ${options.token}`,
        "User-Agent": "fortagram",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });

    if (!response.ok) {
      const requestId = response.headers.get("x-github-request-id");
      throw new Error(
        `GitHub API request failed (${response.status} ${response.statusText})${
          requestId ? ` [request ${requestId}]` : ""
        }`,
      );
    }

    if (accept === "application/vnd.github.diff") {
      return await response.text() as T;
    }
    return await response.json() as T;
  };

  const repositoryPath = (owner: string, repo: string): string =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    getPullRequest(owner, repo, prNumber) {
      return request<GitHubPullRequest>(
        `${repositoryPath(owner, repo)}/pulls/${prNumber}`,
        "application/vnd.github+json",
      );
    },
    getBranch(owner, repo, branch) {
      return request<GitHubBranch>(
        `${repositoryPath(owner, repo)}/branches/${encodeURIComponent(branch)}`,
        "application/vnd.github+json",
      );
    },
    getPullRequestDiff(owner, repo, prNumber) {
      return request<string>(
        `${repositoryPath(owner, repo)}/pulls/${prNumber}`,
        "application/vnd.github.diff",
      );
    },
    compareDiff(owner, repo, base, head) {
      return request<string>(
        `${repositoryPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        "application/vnd.github.diff",
      );
    },
    getIssueComments(owner, repo, prNumber) {
      return request<GitHubComment[]>(
        `${repositoryPath(owner, repo)}/issues/${prNumber}/comments?per_page=100`,
        "application/vnd.github+json",
      );
    },
    getPullRequestReviews(owner, repo, prNumber) {
      return request<GitHubComment[]>(
        `${repositoryPath(owner, repo)}/pulls/${prNumber}/reviews?per_page=100`,
        "application/vnd.github+json",
      );
    },
    async submitPullRequestReview(owner, repo, prNumber, body, event = "COMMENT") {
      await request<unknown>(
        `${repositoryPath(owner, repo)}/pulls/${prNumber}/reviews`,
        "application/vnd.github+json",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body, event }),
        },
      );
    },
  };
}
