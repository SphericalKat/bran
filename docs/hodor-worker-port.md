# Porting Hodor's reviewer to Cloudflare Workers

Research target: upstream Hodor `main` at [`e35234f`](https://github.com/mr-karan/hodor/tree/e35234faef7aa28996245cef4e51b5afa508bc7f), compared with this repository's incomplete `src/reviewer/agent.ts`.

## Conclusion

This is a repository-port refactor, not a `gh`-to-`fetch` substitution. Hodor's review loop assumes a checked-out repository twice: the orchestration uses Git and GitHub CLI commands, and the model explores the checkout with `read`, `bash`, `grep`, `find`, and `ls`. A Worker-native port should keep Hodor's pure prompt, schema, recovery, rendering, cache, and metrics logic, while replacing its entire workspace boundary with authenticated GitHub API operations and bounded, API-backed tools.

The local draft has already replaced much of the orchestration with `GitHubApi`, but it currently gives the model only `submit_review`. That works only when the entire useful diff fits in one prompt. It does not preserve upstream Hodor's ability to inspect surrounding source, follow symbols into unchanged files, or handle large diffs through tools.

## What upstream `reviewPr` does

1. Loads review instructions and templates from disk, parses the PR URL, creates the model runtime, and discovers credentials through `process.env` ([`agent.ts` lines 87-230](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L87-L230)).
2. Creates or reuses a filesystem workspace and checks out the PR. The GitHub path runs `git fetch`, `gh repo clone`, and `gh pr checkout` ([`agent.ts` lines 234-286](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L234-L286), [`workspace.ts` lines 142-209](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/workspace.ts#L142-L209)).
3. Fetches metadata with `gh pr view --json`, then reads the checked-out head with `git rev-parse HEAD` ([`github.ts` lines 11-52](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/github.ts#L11-L52), [`agent.ts` lines 290-322](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L290-L322)).
4. Finds the last reviewed commit by reading Hodor markers from prior comments, then runs `git cat-file`, `git fetch <sha>`, and `git merge-base --is-ancestor` ([`review-diff.ts` lines 21-96](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review-diff.ts#L21-L96)).
5. Generates a full, incremental, or snapshot diff with local `git diff`. It embeds the diff only below 200 KiB; larger reviews fall back to commands the model can run itself ([`agent.ts` lines 378-426](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L378-L426), [`prompt.ts` lines 164-198](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/prompt.ts#L164-L198)).
6. Scans `.agents/skills` and creates a coding-agent session with local `read`, `bash`, `grep`, `find`, and `ls` tools ([`agent.ts` lines 454-541](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L454-L541)).
7. Validates the structured `submit_review` result and resolves reported locations by opening absolute paths in the checkout ([`resolve-location.ts` lines 215-304](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/resolve-location.ts#L215-L304), [`review.ts` lines 64-90](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review.ts#L64-L90)).
8. Recovers structured output from assistant text when needed, gathers usage metrics, builds a compressed cache marker, and removes a temporary workspace ([`agent.ts` lines 584-833](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L584-L833), [`review-cache.ts`](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review-cache.ts)).

## Runtime-dependent dependency map

| Upstream area | Dependency | Worker-native replacement |
| --- | --- | --- |
| `utils/exec.ts` | `node:child_process` via `spawn` and `execFile` for every CLI call ([source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/utils/exec.ts)) | Remove from the Worker import graph. Use `fetch` against GitHub REST. |
| `workspace.ts` | Temporary directories, repository clones, checkout state, `git`, `gh`, and `glab` ([source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/workspace.ts)) | No workspace. Represent a review as `{ owner, repo, pullNumber, baseSha, headSha, headRepo }`. |
| `github.ts` | `gh pr view --json` ([source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/github.ts#L11-L52)) | `GET /repos/{owner}/{repo}/pulls/{pull_number}` plus paginated issue comments and reviews. |
| `review-diff.ts` | Local Git object existence and ancestry checks ([source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review-diff.ts#L50-L96)) | Keep marker parsing pure. Use GitHub compare for an ancestor delta; if ancestry cannot be established after a rebase, review the current full PR diff. |
| `agent.ts` and `prompt.ts` | Local `git diff`; command-mode fallback for large diffs | Fetch diff text through GitHub. For large reviews, give the model API-backed file/diff tools instead of command strings. |
| `pi-coding-agent` integration | Filesystem resource discovery and local coding tools | Disable repository resources and built-ins. Register only GitHub-backed custom tools and `submit_review`. |
| `resolve-location.ts` | Reads absolute file paths | Require repository-relative paths; pass fetched head-file text into a pure line-range resolver. |
| `publisher.ts` | `gh pr review` ([source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/publisher.ts#L68-L111)) | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`. |
| templates/instructions | `readFileSync` and paths ([prompt source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/prompt.ts#L34-L39), [instruction source](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review-instructions.ts)) | Bundle static text through TypeScript imports or Wrangler text modules; accept user instructions as values. |
| cache/metrics | Node `crypto`, `zlib`, `Buffer`, and `process.stderr` | Node crypto/zlib are supported under compatibility mode, but Web Crypto, `CompressionStream`, `TextEncoder`, and `console` make the boundary portable. |

GitLab, Gitea, local-mode, CLI, and publisher barrels should not be reachable from the Worker entrypoint. Re-exporting publisher functions from `agent.ts` currently makes it easier for bundling to retain those unrelated paths.

## GitHub API surface

Define one narrow, injected repository port. Its implementation should attach the stored OAuth user token to every call.

```ts
interface PullRequestRepository {
  getPull(owner: string, repo: string, number: number): Promise<PullRequest>;
  getFullDiff(pull: PullRequest): Promise<string>;
  compare(owner: string, repo: string, base: string, head: string): Promise<string>;
  listPriorReviewNotes(owner: string, repo: string, number: number): Promise<ReviewNote[]>;
  listFiles(owner: string, repo: string, ref: string): Promise<string[]>;
  readFile(owner: string, repo: string, path: string, ref: string): Promise<string>;
  submitReview(owner: string, repo: string, number: number, review: PublishedReview): Promise<void>;
}
```

The primary endpoints are:

- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) for title/body/state, base/head refs and SHAs, and repository identity.
- [List pull-request files](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files) for a paginated changed-file index, and the PR endpoint with the diff media type for unified diff text.
- [Compare two commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits) for an incremental ancestor delta.
- [Get repository content](https://docs.github.com/en/rest/repos/contents#get-repository-content) with `ref=<head sha>` for on-demand source reads, or [Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree) for a recursive path index.
- [List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) and [list PR reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) for previous Hodor markers and the review cache.
- [Create a PR review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) for publishing the summary and optional inline comments.

Important details:

- Paginate comments, reviews, and changed files. The local draft currently asks for only the first 100 comments/reviews, so older Hodor markers can be missed.
- Read source at the immutable `head.sha`, never a moving branch name.
- For fork PRs, use `head.repo.full_name` from the PR response when reading head files. Reading every path from the base repository fails for fork-only commits.
- GitHub compare uses merge-base semantics. It is suitable when the prior reviewed SHA is an ancestor. It cannot reproduce upstream's direct `git diff <old> HEAD` snapshot after a force-push. Falling back to the full current PR diff is correct and explicit; pretending compare is a snapshot is not.
- Diff and contents responses have size/truncation limits. Large-review behavior must be explicit: paginate file metadata, cap tool output, fetch files lazily, and fail with a useful limit error rather than sending an unbounded prompt.
- The OAuth grant must use the `repo` scope to read private-repository contents and pull requests and publish reviews as the connected user. See GitHub's [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## Model tools in a Worker

Register a small set of custom tools instead of pi's local coding tools:

- `read_file({ path, startLine?, endLine? })`: fetch the file from the PR head repository at `head.sha`, enforce byte and line caps, and return numbered text.
- `list_files({ prefix? })`: return a bounded path list from a cached Git tree or the changed-file index.
- `search_code({ query, paths? })`: search only already-fetched or bounded candidate files. GitHub's code-search API has separate indexing, permissions, and rate-limit behavior, so it should not be treated as a transparent replacement for local `grep`.
- `get_file_diff({ path })`: return the selected diff section without repeatedly sending the whole PR diff.
- `submit_review(...)`: validate exactly as upstream does and terminate the loop after the first valid call.

The prompt must name these tools and must not emit shell or Git commands. Findings should carry repository-relative paths. File reads, tree listings, and diff slices can be memoized in request-local maps; durable review status and retry identity belong in the surrounding Cloudflare Agent/Durable Object state.

## Cloudflare and pi runtime constraints

- `nodejs_compat` makes many Node APIs available, but some modules are import-only stubs whose methods throw. `node:child_process` is explicitly a non-functional stub, so no Worker design can execute `git` or `gh` ([Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)).
- Workers now provide a memory-backed virtual filesystem: `/bundle` is read-only and `/tmp` is request-local, non-persistent, and counts toward the 128 MB isolate memory limit. This can load bundled templates, but it is not a repository checkout and cannot provide Git semantics ([Cloudflare filesystem API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)).
- `process.env` is isolate-global mutable state. Bindings can populate it under compatibility mode, but changing AWS region variables around an `await` can race with another request in the same isolate. Pass credentials and region into model/provider configuration instead of snapshotting and mutating globals ([Cloudflare process API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/)).
- Workers have a 128 MB per-isolate memory limit and six simultaneous outbound connections waiting for headers. Paid Workers default to 30 seconds of CPU and can be configured up to five minutes; network wait does not count as CPU ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Buffering a large diff, tree, source files, agent transcript, and SDK bundle together must stay within the same isolate budget.
- Cloudflare Agents are Durable Objects. Their documented compute budget is 30 seconds per incoming request/message while wall-clock waiting can be longer ([Agents limits](https://developers.cloudflare.com/agents/platform/limits/)). For multi-minute LLM/tool loops, `keepAliveWhile()` is the recommended active-work primitive; in-memory variables and open fetches do not survive eviction, while fibers/workflows provide stronger recovery ([long-running Agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)).

`@earendil-works/pi-coding-agent@0.83.0` declares Node `>=22.19.0` and its root entrypoint re-exports CLI, interactive UI, bash, filesystem tools, resource loaders, and SDK APIs from one barrel ([package](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/package.json), [root exports](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/index.ts)). Even in-memory session/settings managers do not make that barrel Worker-native: `AgentSession`, `DefaultResourceLoader`, and related modules statically import filesystem and bash infrastructure ([agent session](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/core/agent-session.ts), [resource loader](https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/core/resource-loader.ts)). `nodejs_compat` may let the bundle load, but any reached subprocess path will fail and the broad barrel increases bundle/startup risk.

The safest choices are, in order:

1. Use `@earendil-works/pi-agent-core` plus `@earendil-works/pi-ai` directly and implement the small tool loop needed here.
2. Ask pi for a Worker/browser-safe SDK export that excludes CLI, TUI, filesystem, package-manager, and bash modules.
3. If retaining `pi-coding-agent`, keep only in-memory managers and custom tools, disable all project resources, prove `wrangler deploy --dry-run` succeeds, and add an actual Worker-runtime integration test that performs a model turn. A successful bundle alone does not prove no stubbed Node path executes.

## Recommended implementation order

1. Import the missing pure Hodor modules and templates, keeping them free of CLI/workspace imports.
2. Finish `GitHubApi` as the injected repository port, including pagination, fork-head reads, file/tree access, and review publishing.
3. Replace absolute-path location resolution with repository-relative validation against fetched head-file text.
4. Add the GitHub-backed model tools and update the prompt so there is no command-mode fallback.
5. Run the agent inside the existing `ReviewerAgent` Durable Object with explicit lifecycle/status handling for long model calls.
6. Validate with unit tests for API pagination, fork PRs, rebases, large diffs, and tool caps, followed by a Miniflare/Workers integration test and a deployment dry run.
