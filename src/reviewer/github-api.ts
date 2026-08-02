import { Octokit } from "@octokit/rest";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubPullRequestRef {
  ref: string;
  sha: string;
}

export interface GitHubPullRequest {
  base: GitHubPullRequestRef;
  head: GitHubPullRequestRef & { repo?: { full_name: string } | null };
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

export interface GitHubReviewComment {
  path: string;
  body: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export interface GitHubPullRequestReview {
  body: string;
  event: GitHubReviewEvent;
  commitId?: string;
  comments?: GitHubReviewComment[];
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

export interface GitHubContent {
  type: "file" | "dir";
  path: string;
  content?: string;
  encoding?: string;
}

export interface GitHubCodeSearchResult {
  items: Array<{ path: string }>;
}

export interface GitHubComparison {
  status: "ahead" | "behind" | "diverged" | "identical";
}

export interface GitHubApi {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest>;
  getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch>;
  getPullRequestDiff(owner: string, repo: string, prNumber: number): Promise<string>;
  compareDiff(owner: string, repo: string, base: string, head: string): Promise<string>;
  compare(owner: string, repo: string, base: string, head: string): Promise<GitHubComparison>;
  getIssueComments(owner: string, repo: string, prNumber: number): Promise<GitHubComment[]>;
  getPullRequestReviews(owner: string, repo: string, prNumber: number): Promise<GitHubComment[]>;
  getContent(owner: string, repo: string, path: string, ref: string): Promise<GitHubContent | GitHubContent[]>;
  searchCode(owner: string, repo: string, query: string): Promise<GitHubCodeSearchResult>;
  submitPullRequestReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: GitHubPullRequestReview,
  ): Promise<void>;
}

export function createGitHubApi(options: {
  token: string;
  fetch?: typeof globalThis.fetch;
  apiUrl?: string;
}): GitHubApi {
  if (!options.token) {
    throw new Error("A GitHub token is required to review a pull request");
  }
  const octokit = new Octokit({
    auth: options.token,
    baseUrl: (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, ""),
    userAgent: "bran",
    request: {
      fetch: options.fetch ?? globalThis.fetch,
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  octokit.hook.before("request", (request) => {
    request.headers["x-github-api-version"] = GITHUB_API_VERSION;
  });
  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      throw readableGitHubError(error, options.token);
    }
  };

  return {
    async getPullRequest(owner, repo, prNumber) {
      const { data } = await call(() => octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }));
      return data as GitHubPullRequest;
    },
    async getBranch(owner, repo, branch) {
      const { data } = await call(() => octokit.rest.repos.getBranch({ owner, repo, branch }));
      return data;
    },
    async getPullRequestDiff(owner, repo, prNumber) {
      const { data } = await call(() => octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        headers: { accept: "application/vnd.github.diff" },
      }));
      return data as unknown as string;
    },
    async compareDiff(owner, repo, base, head) {
      const { data } = await call(() => octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
        headers: { accept: "application/vnd.github.diff" },
      }));
      return data as unknown as string;
    },
    async compare(owner, repo, base, head) {
      const { data } = await call(() => octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      }));
      return { status: data.status } as GitHubComparison;
    },
    async getIssueComments(owner, repo, prNumber) {
      const comments = await call(() => octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      }));
      return comments.map(toGitHubComment);
    },
    async getPullRequestReviews(owner, repo, prNumber) {
      const reviews = await call(() => octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }));
      return reviews.map(toGitHubComment);
    },
    async getContent(owner, repo, path, ref) {
      const { data } = await call(() => octokit.rest.repos.getContent({ owner, repo, path, ref }));
      return data as unknown as GitHubContent | GitHubContent[];
    },
    async searchCode(owner, repo, query) {
      const qualifiedQuery = `${query} repo:${owner}/${repo}`;
      const { data } = await call(() => octokit.rest.search.code({ q: qualifiedQuery, per_page: 20 }));
      return { items: data.items.map(({ path }) => ({ path })) };
    },
    async submitPullRequestReview(owner, repo, prNumber, review) {
      await call(() => octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: review.body,
        event: review.event,
        commit_id: review.commitId,
        comments: review.comments?.map((comment) => ({
          path: comment.path,
          body: comment.body,
          line: comment.line,
          side: comment.side,
          start_line: comment.startLine,
          start_side: comment.startSide,
        })),
      }));
    },
  };
}

function toGitHubComment(comment: {
  body?: string | null;
  created_at?: string;
  user?: { login: string } | null;
}): GitHubComment {
  return {
    body: comment.body ?? undefined,
    created_at: comment.created_at,
    user: comment.user ? { login: comment.user.login } : undefined,
  };
}

function readableGitHubError(error: unknown, token: string): Error {
  if (!isOctokitRequestError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const requestUrl = new URL(error.request.url);
  const path = `${requestUrl.pathname}${requestUrl.search}`;
  const requestId = error.response?.headers["x-github-request-id"];
  const status = `${error.status}${statusText(error.status) ? ` ${statusText(error.status)}` : ""}`;
  const details = githubErrorDetails(error.response?.data, token);
  return new Error(
    `GitHub API request failed for ${error.request.method} ${path} (${status})${details ? `: ${details}` : ""}${
      requestId ? ` [request ${requestId}]` : ""
    }`,
  );
}

function githubErrorDetails(data: unknown, token: string): string | null {
  if (!data || typeof data !== "object") return null;
  const response = data as Record<string, unknown>;
  const details: string[] = [];
  if (typeof response.message === "string") details.push(response.message);
  if (Array.isArray(response.errors)) {
    for (const error of response.errors) {
      if (typeof error === "string") {
        details.push(error);
      } else if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") details.push(message);
      }
    }
  }
  const sanitized = [...new Set(details.map((detail) =>
    detail.replaceAll(token, "[REDACTED]").replace(/\s+/g, " ").trim()
  ).filter(Boolean))].join(" — ");
  return sanitized ? sanitized.slice(0, 1_000) : null;
}

function isOctokitRequestError(error: unknown): error is {
  status: number;
  request: { method: string; url: string };
  response?: { headers: Record<string, string>; data?: unknown };
} {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  if (typeof value.status !== "number" || !value.request || typeof value.request !== "object") {
    return false;
  }
  const request = value.request as Record<string, unknown>;
  return typeof request.method === "string" && typeof request.url === "string";
}

function statusText(status: number): string {
  return ({
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
  } as Record<number, string>)[status] ?? "";
}
