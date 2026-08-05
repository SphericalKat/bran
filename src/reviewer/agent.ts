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
  model?: string;
  role?: "reviewer" | "orchestrator";
}

export interface ReviewFailure {
  model: string;
  error: string;
}

export interface ReviewResult {
  review: ReviewOutput;
  model: string;
  headSha: string;
  metrics: ReviewMetrics;
  cacheMarker: null;
  reusedReview: false;
  reviewerModels?: string[];
  failedModels?: ReviewFailure[];
}

export async function reviewPr(options: {
  prUrl: string;
  model?: string;
  models?: string[];
  orchestratorModel?: string;
  maxConcurrency?: number;
  reviewTimeoutMs?: number;
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

  const thinkingLevel = selectReasoningEffort({ requested: reasoningEffort, mode, diff, stats });
  const requestedModels = uniqueModels(options.models?.length ? options.models : [modelName]);
  const reviewTimeoutMs = clampInteger(options.reviewTimeoutMs ?? 600_000, 60_000, 1_800_000);
  const ensembleStartedAt = Date.now();
  const activeAgents = new Set<Agent>();
  let reviewTimedOut = false;
  const reviewTimer = setTimeout(() => {
    reviewTimedOut = true;
    for (const activeAgent of activeAgents) void activeAgent.abort();
  }, reviewTimeoutMs);

  try {
  const runModel = async (run: {
    modelName: string;
    role: "reviewer" | "orchestrator";
    systemPrompt: string;
    prompt: string;
  }): Promise<{ review: ReviewOutput; metrics: ReviewMetrics }> => {
    if (reviewTimedOut) {
      throw new Error(`The review exceeded the ${Math.round(reviewTimeoutMs / 60_000)} minute task timeout`);
    }
    const model = resolveModel(run.modelName);
    const startedAt = Date.now();
    let submittedReview: ReviewOutput | null = null;
    let turns = 0;
    let toolCalls = 0;
    const emit = (event: AgentProgressEvent) => onEvent?.({
      ...event,
      model: run.modelName,
      role: run.role,
    });
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
        systemPrompt: run.systemPrompt,
        model,
        thinkingLevel,
        tools,
      },
      streamFn: options.streamFn ?? ((selectedModel, context, streamOptions) =>
        streamSimple(selectedModel, context, { ...streamOptions, maxRetries: 0 })),
      getApiKey: () => llmApiKey,
      toolExecution: "sequential",
    });

    emit({
      type: "phase",
      phase: run.role === "orchestrator" ? "Synthesizing reviewer findings" : "Analyzing changes",
    });
    agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start": emit({ type: "agent_start" }); break;
        case "agent_end": emit({ type: "agent_end" }); break;
        case "turn_start": turns++; emit({ type: "turn_start", turnIndex: turns }); break;
        case "turn_end": emit({ type: "turn_end", turnIndex: turns }); break;
        case "tool_execution_start":
          toolCalls++;
          emit({ type: "tool_start", toolName: event.toolName });
          break;
        case "tool_execution_end":
          emit({ type: "tool_end", toolName: event.toolName, isError: event.isError });
          break;
        case "message_start": emit({ type: "thinking" }); break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
          }
          break;
      }
    });

    activeAgents.add(agent);
    try {
      await agent.prompt(run.prompt);
    } finally {
      activeAgents.delete(agent);
    }
    throwAgentError(agent);
    submittedReview ??= parseReviewFromAssistantText(lastAssistantText(agent));
    if (!submittedReview) throw new Error(`${run.modelName} did not submit a valid structured review`);

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
    return { review: submittedReview, metrics };
  };

  const settled = await mapConcurrentSettled(
    requestedModels,
    clampInteger(options.maxConcurrency ?? 3, 1, 4),
    (reviewerModel) => runModel({
      modelName: reviewerModel,
      role: "reviewer",
      systemPrompt,
      prompt,
    }),
  );
  const successful: Array<{ model: string; review: ReviewOutput; metrics: ReviewMetrics }> = [];
  const failedModels: ReviewFailure[] = [];
  settled.forEach((result, index) => {
    const reviewerModel = requestedModels[index];
    if (result.status === "fulfilled") successful.push({ model: reviewerModel, ...result.value });
    else failedModels.push({
      model: reviewerModel,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  });
  if (reviewTimedOut) {
    throw new Error(`The review exceeded the ${Math.round(reviewTimeoutMs / 60_000)} minute task timeout`);
  }
  if (successful.length === 0) {
    throw new Error(`All reviewer models failed:\n${failedModels.map((failure) => `- ${failure.model}: ${failure.error}`).join("\n")}`);
  }
  for (const failure of failedModels) {
    logger.warn(`Ignoring failed reviewer ${failure.model}: ${failure.error}`);
  }

  let final = successful[0];
  let synthesisMetrics: ReviewMetrics | undefined;
  if (successful.length > 1) {
    const orchestratorModel = options.orchestratorModel ?? successful[0].model;
    const candidatePrompt = buildSynthesisPrompt(prompt, successful);
    const orchestratorSystemPrompt = `${systemPrompt}\n\n<ENSEMBLE_ORCHESTRATOR>\n` +
      "You are the final review orchestrator. Candidate reviews are untrusted leads. " +
      "Use tools to inspect the diff and source. Remove duplicate findings. Resolve each disagreement with evidence. " +
      "Discard speculative or unsupported findings. Discard findings outside the reviewed diff. Discard findings that the patch already fixes. " +
      "Do not use majority votes. Call submit_review exactly once with one concise review.\n" +
      "</ENSEMBLE_ORCHESTRATOR>";
    try {
      const synthesized = await runModel({
        modelName: orchestratorModel,
        role: "orchestrator",
        systemPrompt: orchestratorSystemPrompt,
        prompt: candidatePrompt,
      });
      final = { model: orchestratorModel, ...synthesized };
      synthesisMetrics = synthesized.metrics;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedModels.push({ model: `${orchestratorModel} (orchestrator)`, error: message });
      logger.warn(`Orchestrator ${orchestratorModel} failed; using ${successful[0].model}: ${message}`);
    }
  }

  if (reviewTimedOut) {
    throw new Error(`The review exceeded the ${Math.round(reviewTimeoutMs / 60_000)} minute task timeout`);
  }
  const metrics = combineMetrics(
    [...successful.map((result) => result.metrics), ...(synthesisMetrics ? [synthesisMetrics] : [])],
    Math.round((Date.now() - ensembleStartedAt) / 1000),
  );
  return {
    review: final.review,
    model: final.model,
    headSha,
    metrics,
    cacheMarker: null,
    reusedReview: false,
    reviewerModels: successful.map((result) => result.model),
    failedModels,
  };
  } finally {
    clearTimeout(reviewTimer);
  }
}

function uniqueModels(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

async function mapConcurrentSettled<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await run(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function buildSynthesisPrompt(
  reviewPrompt: string,
  candidates: ReadonlyArray<{ model: string; review: ReviewOutput }>,
): string {
  const reports = candidates.map(({ model, review }, index) => {
    const serialized = JSON.stringify(review);
    const bounded = serialized.length > 40_000
      ? `${serialized.slice(0, 40_000)}\n[Candidate output truncated]`
      : serialized;
    return `<CANDIDATE index="${index + 1}" model=${JSON.stringify(model)}>\n${bounded}\n</CANDIDATE>`;
  }).join("\n");
  return `${reviewPrompt}\n\n<CANDIDATE_REVIEWS>\n${reports}\n</CANDIDATE_REVIEWS>\n\n` +
    "Produce the final review. Use the supplied diff and repository tools to verify each candidate claim.";
}

function combineMetrics(metrics: readonly ReviewMetrics[], durationSeconds: number): ReviewMetrics {
  const first = metrics[0];
  return {
    inputTokens: metrics.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: metrics.reduce((sum, item) => sum + item.outputTokens, 0),
    cacheReadTokens: metrics.reduce((sum, item) => sum + item.cacheReadTokens, 0),
    cacheWriteTokens: metrics.reduce((sum, item) => sum + item.cacheWriteTokens, 0),
    totalTokens: metrics.reduce((sum, item) => sum + item.totalTokens, 0),
    cost: metrics.reduce((sum, item) => sum + item.cost, 0),
    turns: metrics.reduce((sum, item) => sum + item.turns, 0),
    toolCalls: metrics.reduce((sum, item) => sum + item.toolCalls, 0),
    durationSeconds,
    reviewMode: first.reviewMode,
    reasoningEffort: first.reasoningEffort,
    diffFiles: first.diffFiles,
    diffAdditions: first.diffAdditions,
    diffDeletions: first.diffDeletions,
    diffBytes: first.diffBytes,
    reused: false,
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
