import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createGitHubApi, type GitHubApi, type GitHubContent } from "./github-api";
import { logger } from "./utils/logger";
import { printMetrics } from "./metrics";
import { resolveModel, selectReasoningEffort } from "./model";
import { parsePrUrl } from "./platform";
import { buildPrReviewPrompt } from "./prompt";
import {
  filterEmbeddedDiff,
  getChangedFiles,
  getDiffStats,
  latestReviewSha,
  type ReviewDiffMode,
} from "./review-diff";
import {
  loadDefaultReviewInstructions,
  validateReviewInstructions,
} from "./review-instructions";
import {
  lastAssistantText,
  parseReviewFromAssistantText,
} from "./review-recovery";
import { SUBMIT_REVIEW_SCHEMA, validateReviewOutput } from "./review";
import { buildReviewSystemPrompt } from "./system-prompt";
import type { MrMetadata, ReviewMetrics, ReviewOutput } from "./types";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5-20250929";
const MAX_FILE_BYTES = 200_000;
const MAX_FILE_LINES = 400;
const MAX_DIFF_CHARS = 120_000;
const READ_FILE_SCHEMA = Type.Object({
  path: Type.String({ minLength: 1 }),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  endLine: Type.Optional(Type.Integer({ minimum: 1 })),
});
const SEARCH_CODE_SCHEMA = Type.Object({ query: Type.String({ minLength: 2, maxLength: 200 }) });
const FILE_DIFF_SCHEMA = Type.Object({ path: Type.String({ minLength: 1 }) });

export interface AgentProgressEvent {
  type: "phase" | "tool_start" | "tool_end" | "thinking" | "turn_start" | "turn_end" | "agent_start" | "agent_end" | "text_delta" | "thinking_delta";
  phase?: string;
  toolName?: string;
  isError?: boolean;
  turnIndex?: number;
  delta?: string;
}

export interface ReviewResult {
  review: ReviewOutput;
  model: string;
  headSha: string;
  metrics: ReviewMetrics;
  cacheMarker: null;
  reusedReview: false;
}

export async function reviewPr(options: {
  prUrl: string;
  model?: string;
  reasoningEffort?: string;
  reviewInstructions?: string | null;
  additionalInstructions?: string | null;
  full?: boolean;
  targetBranchOverride?: string;
  githubToken?: string;
  githubApi?: GitHubApi;
  llmApiKey: string;
  streamFn?: StreamFn;
  onEvent?: (event: AgentProgressEvent) => void;
}): Promise<ReviewResult> {
  const {
    prUrl,
    model: modelName = DEFAULT_MODEL,
    reasoningEffort,
    full = false,
    targetBranchOverride,
    llmApiKey,
    onEvent,
  } = options;
  if (!llmApiKey) throw new Error("An LLM API key is required");

  onEvent?.({ type: "phase", phase: "Loading pull request" });
  const { owner, repo, prNumber } = parsePrUrl(prUrl);
  const github = options.githubApi ?? createGitHubApi({ token: options.githubToken ?? "" });
  const pullRequest = await github.getPullRequest(owner, repo, prNumber);
  onEvent?.({ type: "phase", phase: "Loading discussion and changed files" });
  const commentsAndReviews = await Promise.all([
    github.getIssueComments(owner, repo, prNumber),
    github.getPullRequestReviews(owner, repo, prNumber),
  ]);
  const metadata = pullRequestMetadata(pullRequest, commentsAndReviews.flat());
  const headSha = pullRequest.head.sha;
  const [headOwner = owner, headRepo = repo] = (pullRequest.head.repo?.full_name ?? `${owner}/${repo}`).split("/");

  let targetBranch = pullRequest.base.ref;
  let baseSha = pullRequest.base.sha;
  if (targetBranchOverride) {
    const branch = await github.getBranch(owner, repo, targetBranchOverride);
    targetBranch = branch.name;
    baseSha = branch.commit.sha;
  }

  const previousSha = full ? null : latestReviewSha(metadata.Notes);
  const fullDiff = () => targetBranchOverride
    ? github.compareDiff(
        owner,
        repo,
        baseSha,
        pullRequest.head.repo?.full_name !== `${owner}/${repo}`
          ? `${headOwner}:${pullRequest.head.ref}`
          : headSha,
      )
    : github.getPullRequestDiff(owner, repo, prNumber);
  let mode: ReviewDiffMode = "full";
  let rawDiff: string;
  if (previousSha) {
    try {
      const comparison = await github.compare(owner, repo, previousSha, headSha);
      if (comparison.status === "ahead" || comparison.status === "identical") {
        rawDiff = await github.compareDiff(owner, repo, previousSha, headSha);
        mode = "incremental";
      } else {
        rawDiff = await fullDiff();
      }
    } catch {
      rawDiff = await fullDiff();
    }
  } else {
    rawDiff = await fullDiff();
  }

  const { filtered: diff, skippedFiles } = filterEmbeddedDiff(rawDiff);
  if (skippedFiles.length) logger.info(`Skipped generated or documentation files: ${skippedFiles.join(", ")}`);
  const changedFiles = getChangedFiles(diff);
  const stats = getDiffStats(diff);
  const reviewInstructions = options.reviewInstructions == null
    ? loadDefaultReviewInstructions()
    : validateReviewInstructions(options.reviewInstructions);
  const systemPrompt = buildReviewSystemPrompt({
    reviewInstructions,
    additionalInstructions: options.additionalInstructions == null
      ? null
      : validateReviewInstructions(options.additionalInstructions, "additional instructions"),
  });
  const prompt = buildPrReviewPrompt({
    prUrl,
    targetBranch,
    mrMetadata: metadata,
    embeddedDiff: diff.slice(0, MAX_DIFF_CHARS),
    previousReviewSha: previousSha,
    reviewDiffMode: mode,
    changedFiles,
  });

  const model = resolveModel(modelName);
  const thinkingLevel = selectReasoningEffort({ requested: reasoningEffort, mode, diff, stats });
  const startedAt = Date.now();
  let submittedReview: ReviewOutput | null = null;
  let turns = 0;
  let toolCalls = 0;

  const tools = repositoryTools({
    github,
    owner: headOwner,
    repo: headRepo,
    ref: headSha,
    diff,
    changedFiles,
    submit(review) {
      if (submittedReview) return false;
      submittedReview = validateReviewOutput(review);
      return true;
    },
  });
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    streamFn: options.streamFn ?? streamSimple,
    getApiKey: () => llmApiKey,
    toolExecution: "sequential",
  });

  onEvent?.({ type: "phase", phase: "Analyzing changes" });
  agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start": onEvent?.({ type: "agent_start" }); break;
      case "agent_end": onEvent?.({ type: "agent_end" }); break;
      case "turn_start": turns++; onEvent?.({ type: "turn_start", turnIndex: turns }); break;
      case "turn_end": onEvent?.({ type: "turn_end", turnIndex: turns }); break;
      case "tool_execution_start":
        toolCalls++;
        onEvent?.({ type: "tool_start", toolName: event.toolName });
        break;
      case "tool_execution_end":
        onEvent?.({ type: "tool_end", toolName: event.toolName, isError: event.isError });
        break;
      case "message_start": onEvent?.({ type: "thinking" }); break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          onEvent?.({ type: "text_delta", delta: event.assistantMessageEvent.delta });
        }
        break;
    }
  });

  await agent.prompt(prompt);
  throwAgentError(agent);
  submittedReview ??= parseReviewFromAssistantText(lastAssistantText(agent));
  if (!submittedReview) throw new Error("The reviewer did not submit a valid structured review");

  const metrics = collectMetrics(agent.state.messages, {
    turns,
    toolCalls,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    reviewMode: mode,
    reasoningEffort: thinkingLevel,
    diffFiles: stats.files,
    diffAdditions: stats.additions,
    diffDeletions: stats.deletions,
    diffBytes: stats.bytes,
  });
  printMetrics(metrics);
  return {
    review: submittedReview,
    model: modelName,
    headSha,
    metrics,
    cacheMarker: null,
    reusedReview: false,
  };
}

function repositoryTools(options: {
  github: GitHubApi;
  owner: string;
  repo: string;
  ref: string;
  diff: string;
  changedFiles: string[];
  submit: (review: unknown) => boolean;
}): AgentTool[] {
  const readFile: AgentTool<typeof READ_FILE_SCHEMA> = {
    name: "read_file",
    label: "Read file",
    description: "Read bounded source lines from the pull request head commit.",
    parameters: READ_FILE_SCHEMA,
    async execute(_id, input) {
      const path = safePath(input.path);
      const content = await options.github.getContent(options.owner, options.repo, path, options.ref);
      if (Array.isArray(content) || content.type !== "file" || !content.content) {
        throw new Error(`Not a readable file: ${path}`);
      }
      const text = decodeGitHubContent(content);
      if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
        throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      }
      const lines = text.split("\n");
      const start = input.startLine ?? 1;
      const end = Math.min(input.endLine ?? start + MAX_FILE_LINES - 1, start + MAX_FILE_LINES - 1, lines.length);
      return {
        content: [{ type: "text", text: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n") }],
        details: { path, startLine: start, endLine: end },
      };
    },
  };

  const searchCode: AgentTool<typeof SEARCH_CODE_SCHEMA> = {
    name: "search_code",
    label: "Search code",
    description: "Search the repository for a symbol or exact code fragment.",
    parameters: SEARCH_CODE_SCHEMA,
    async execute(_id, input) {
      const result = await options.github.searchCode(options.owner, options.repo, input.query);
      return {
        content: [{ type: "text", text: result.items.map((item) => item.path).join("\n") || "No matches" }],
        details: { matches: result.items.length },
      };
    },
  };

  const fileDiff: AgentTool<typeof FILE_DIFF_SCHEMA> = {
    name: "get_file_diff",
    label: "Get file diff",
    description: "Read the changed diff section for one pull request file.",
    parameters: FILE_DIFF_SCHEMA,
    async execute(_id, input) {
      const path = safePath(input.path);
      if (!options.changedFiles.includes(path)) throw new Error(`File is not changed: ${path}`);
      const section = diffSection(options.diff, path);
      return { content: [{ type: "text", text: section }], details: { path } };
    },
  };

  const submit: AgentTool<typeof SUBMIT_REVIEW_SCHEMA> = {
    name: "submit_review",
    label: "Submit review",
    description: "Submit the final structured review exactly once.",
    parameters: SUBMIT_REVIEW_SCHEMA,
    async execute(_id, input) {
      const accepted = options.submit(input);
      return {
        content: [{ type: "text", text: accepted ? "Review accepted" : "Review was already submitted" }],
        details: { accepted },
        terminate: true,
      };
    },
  };

  return [readFile, searchCode, fileDiff, submit];
}

function pullRequestMetadata(
  pullRequest: Awaited<ReturnType<GitHubApi["getPullRequest"]>>,
  notes: Array<{ body?: string; created_at?: string; user?: { login: string } }>,
): MrMetadata {
  return {
    title: pullRequest.title,
    description: pullRequest.body ?? undefined,
    source_branch: pullRequest.head.ref,
    target_branch: pullRequest.base.ref,
    changes_count: pullRequest.changed_files,
    labels: pullRequest.labels?.map((label) => label.name),
    author: pullRequest.user ? { username: pullRequest.user.login } : undefined,
    state: pullRequest.state,
    Notes: notes.map((note) => ({
      body: note.body,
      created_at: note.created_at,
      author: note.user ? { username: note.user.login } : undefined,
    })),
  };
}

function decodeGitHubContent(content: GitHubContent): string {
  if (content.encoding !== "base64") throw new Error(`Unsupported GitHub content encoding: ${content.encoding}`);
  const binary = atob((content.content ?? "").replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function safePath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) throw new Error("Invalid repository path");
  return normalized;
}

function diffSection(diff: string, path: string): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections.find((section) => section.startsWith(`diff --git a/${path} b/${path}`))?.slice(0, MAX_DIFF_CHARS)
    ?? `No textual diff is available for ${path}`;
}

function throwAgentError(agent: Agent): void {
  if (agent.state.errorMessage) throw new Error(`LLM request failed: ${agent.state.errorMessage}`);
}

function collectMetrics(
  messages: Agent["state"]["messages"],
  details: Omit<ReviewMetrics, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens" | "cost" | "reused">,
): ReviewMetrics {
  const metrics: ReviewMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    reused: false,
    ...details,
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    metrics.inputTokens += message.usage.input;
    metrics.outputTokens += message.usage.output;
    metrics.cacheReadTokens += message.usage.cacheRead;
    metrics.cacheWriteTokens += message.usage.cacheWrite;
    metrics.totalTokens += message.usage.totalTokens;
    metrics.cost += message.usage.cost.total;
  }
  return metrics;
}

export { parsePrUrl } from "./platform";
