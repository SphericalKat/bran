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

  const requestPage = async <T>(
    path: string,
    accept: string,
    init: RequestInit = {},
  ): Promise<{ value: T; nextPath: string | null }> => {
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
      return { value: await response.text() as T, nextPath: null };
    }
    return {
      value: await response.json() as T,
      nextPath: nextPagePath(response.headers, apiUrl),
    };
  };

  const request = async <T>(
    path: string,
    accept: string,
    init: RequestInit = {},
  ): Promise<T> => (await requestPage<T>(path, accept, init)).value;

  const paginate = async <T>(path: string): Promise<T[]> => {
    const values: T[] = [];
    const visited = new Set<string>();
    while (path) {
      if (visited.has(path)) throw new Error("GitHub pagination returned a loop");
      visited.add(path);
      const page = await requestPage<T[]>(path, "application/vnd.github+json");
      values.push(...page.value);
      path = page.nextPath ?? "";
    }
    return values;
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
    compare(owner, repo, base, head) {
      return request<GitHubComparison>(
        `${repositoryPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        "application/vnd.github+json",
      );
    },
    getIssueComments(owner, repo, prNumber) {
      return paginate<GitHubComment>(
        `${repositoryPath(owner, repo)}/issues/${prNumber}/comments?per_page=100`,
      );
    },
    getPullRequestReviews(owner, repo, prNumber) {
      return paginate<GitHubComment>(
        `${repositoryPath(owner, repo)}/pulls/${prNumber}/reviews?per_page=100`,
      );
    },
    getContent(owner, repo, path, ref) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      return request<GitHubContent | GitHubContent[]>(
        `${repositoryPath(owner, repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        "application/vnd.github+json",
      );
    },
    searchCode(owner, repo, query) {
      const qualifiedQuery = `${query} repo:${owner}/${repo}`;
      return request<GitHubCodeSearchResult>(
        `/search/code?q=${encodeURIComponent(qualifiedQuery)}&per_page=20`,
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

function nextPagePath(headers: Headers, apiUrl: string): string | null {
  const next = headers.get("link")
    ?.split(",")
    .map((link) => link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/))
    .find((match) => match?.[2] === "next")?.[1];
  if (!next) return null;

  const pageUrl = new URL(next, apiUrl);
  if (pageUrl.origin !== new URL(apiUrl).origin) {
    throw new Error("GitHub pagination returned an unexpected origin");
  }
  return `${pageUrl.pathname}${pageUrl.search}`;
}
