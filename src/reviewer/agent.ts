import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { logger } from "./utils/logger";
import { createGitHubApi, type GitHubApi } from "./github-api.js";
import { buildPrReviewPrompt } from "./prompt.js";
import {
  getDefaultReasoningEffortForModel,
  parseModelString,
  selectReasoningEffort,
} from "./model.js";
import { formatMetricsMarkdown, printMetrics } from "./metrics.js";
import { SUBMIT_REVIEW_SCHEMA, validateReviewOutput } from "./review.js";
import { buildReviewSystemPrompt } from "./system-prompt.js";
import {
  loadDefaultReviewInstructions,
  validateReviewInstructions,
} from "./review-instructions.js";
import { parsePrUrl } from "./platform";
import {
  filterEmbeddedDiff,
  findLatestReviewBase,
  getChangedFiles,
  getDiffStats,
  type DiffStats,
  type ReviewDiffMode,
} from "./review-diff.js";
import {
  buildReviewCacheMarker,
  findCachedReview,
  getReviewCacheKey,
} from "./review-cache.js";
import {
  buildSubmitReviewRecoveryPrompt,
  parseReviewFromAssistantText,
  SUBMIT_REVIEW_RECOVERY_ATTEMPTS,
  summarizeLastAssistantMessage,
} from "./review-recovery.js";
export { detectPlatform, parsePrUrl } from "./platform.js";
export { filterEmbeddedDiff, getHodorReviewShaCandidates } from "./review-diff.js";
export { buildSubmitReviewRecoveryPrompt, parseReviewFromAssistantText } from "./review-recovery.js";
export {
  postGitlabReviewCommitStatus,
  postReviewComment,
  postReviewStructured,
} from "./publisher.js";
import type {
  Platform,
  ReviewMetrics,
  MrMetadata,
  ReviewOutput,
} from "./types";

export interface AgentProgressEvent {
  type: "tool_start" | "tool_end" | "thinking" | "turn_start" | "turn_end" | "agent_start" | "agent_end" | "text_delta" | "thinking_delta" | "tool_result";
  toolName?: string;
  toolArgs?: string;
  isError?: boolean;
  turnIndex?: number;
  delta?: string;
  result?: string;
}


export async function reviewPr(opts: {
  prUrl?: string;
  model?: string;
  reasoningEffort?: string;
  reviewInstructions?: string | null;
  additionalInstructions?: string | null;
  cleanup?: boolean;
  workspaceDir?: string | null;
  includeMetricsFooter?: boolean;
  onEvent?: (event: AgentProgressEvent) => void;
  bedrockTags?: Record<string, string> | null;
  localMode?: boolean;
  diffAgainst?: string;
  full?: boolean;
  targetBranchOverride?: string;
  githubToken?: string;
  githubApi?: GitHubApi;
  llmApiKey?: string;
}): Promise<{
  review: ReviewOutput;
  metricsFooter: string | null;
  headSha: string | null;
  metrics: ReviewMetrics;
  workspacePath: string;
  cacheMarker: string | null;
  reusedReview: boolean;
}> {
  const {
    prUrl,
    model = "anthropic/claude-sonnet-4-5-20250929",
    reasoningEffort,
    reviewInstructions,
    additionalInstructions,
    cleanup = true,
    workspaceDir,
    includeMetricsFooter = false,
    onEvent,
    bedrockTags,
    localMode = false,
    diffAgainst,
    full = false,
    targetBranchOverride,
    githubToken,
    githubApi: providedGitHubApi,
    llmApiKey,
  } = opts;

  const effectiveReviewInstructions = reviewInstructions == null
    ? loadDefaultReviewInstructions()
    : validateReviewInstructions(reviewInstructions, "review instructions");
  const effectiveAdditionalInstructions = additionalInstructions == null
    ? null
    : validateReviewInstructions(additionalInstructions, "additional instructions");
  const composedSystemPrompt = buildReviewSystemPrompt({
    reviewInstructions: effectiveReviewInstructions,
    additionalInstructions: effectiveAdditionalInstructions,
  });

  logger.info(`Starting PR review for: ${localMode ? "local diff" : prUrl}`);

  if (localMode) {
    throw new Error("Local review mode is not available in Cloudflare Workers");
  }
  if (!prUrl) {
    throw new Error("A GitHub pull request URL is required");
  }

  const urlParsed = parsePrUrl(prUrl);
  const owner = urlParsed.owner;
  const repo = urlParsed.repo;
  const prNumber = urlParsed.prNumber;
  const host = urlParsed.host;

  const platform: Platform = "github";
  logger.info(`Platform: ${platform}, Repo: ${owner}/${repo}, PR: ${prNumber}, Host: ${host}`);

  const githubApi = providedGitHubApi ?? createGitHubApi({ token: githubToken ?? "" });

  // --- Preflight: validate model + credentials before any expensive I/O ---
  const parsed = parseModelString(model);

  // Snapshot env vars we may mutate, restore in finally block.
  const envSnapshot: Record<string, string | undefined> = {
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const runtimeApiKey = llmApiKey ?? process.env.LLM_API_KEY;
  if (runtimeApiKey) {
    await modelRuntime.setRuntimeApiKey(parsed.provider, runtimeApiKey);
  }

  // Resolve model — use registry for known models, construct manually for custom ARNs
  let piModel = modelRuntime.getModel(parsed.provider, parsed.modelId) as Model<Api> | undefined;
  if (parsed.modelId.startsWith("arn:")) {
    // Custom bedrock ARN (inference profile, cross-region, etc.)
    // Extract region from ARN: arn:aws:bedrock:<region>:<account>:...
    const arnParts = parsed.modelId.split(":");
    const region = arnParts.length >= 4 ? arnParts[3] : "us-east-1";
    // Set AWS_REGION so the BedrockRuntimeClient uses the correct endpoint
    if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
      process.env.AWS_REGION = region;
    }
    piModel = {
      id: parsed.modelId,
      name: parsed.modelId,
      api: "bedrock-converse-stream",
      provider: "amazon-bedrock",
      baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    } as Model<Api>;
    logger.info(`Custom bedrock ARN model — region: ${region}`);
  } else if (!piModel) {
    if (parsed.provider === "openrouter") {
      piModel = {
        id: parsed.modelId,
        name: parsed.modelId,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 256000,
        maxTokens: 65536,
      } as Model<Api>;
      logger.warn(`Using best-effort unregistered OpenRouter model — ${parsed.modelId}`);
    } else {
      throw new Error(
        `Unsupported model "${model}". Provider "${parsed.provider}" is recognized by pi-ai, but model "${parsed.modelId}" was not found in the installed registry.`,
      );
    }
  }
  const modelDefaultThinkingLevel = getDefaultReasoningEffortForModel(piModel);

  // Note: For bedrock, don't preflight-check AWS credentials because the SDK
  // resolves them from many sources (env vars, IMDS, ECS task role, IRSA,
  // ~/.aws/credentials, etc.) and we can't reliably detect all of them.
  if (parsed.provider !== "amazon-bedrock") {
    const resolvedKey = await modelRuntime.getAuth(piModel);
    if (!resolvedKey) {
      throw new Error(
        `No API key found for provider "${parsed.provider}". Set the provider-specific environment variable, configure pi auth, or set LLM_API_KEY.`,
      );
    }
  }
  logger.info("Preflight OK — model and credentials validated");

  // --- End preflight ---

  // Cloudflare Workers have no checkout or subprocess support. Resolve all refs
  // and diffs through GitHub, while retaining a cwd only for the agent runtime.
  const workspacePath = workspaceDir ?? "/";
  const pullRequest = await githubApi.getPullRequest(owner, repo, prNumber);
  const headSha = pullRequest.head.sha;
  let targetBranch = pullRequest.base.ref;
  let diffBaseSha: string | null = pullRequest.base.sha;
  let targetOverrideSha: string | null = null;

  if (full && targetBranchOverride) {
    logger.info(`Full review: overriding target branch to '${targetBranchOverride}'`);
    try {
      const branch = await githubApi.getBranch(owner, repo, targetBranchOverride);
      targetBranch = branch.name;
      targetOverrideSha = branch.commit.sha;
      diffBaseSha = branch.commit.sha;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to resolve --target-branch '${targetBranchOverride}' through GitHub: ${msg}`);
    }
  }

  let activeSession: AgentSession | undefined;

  try {
    let mrMetadata: MrMetadata | null = null;
    try {
      const [comments, reviews] = await Promise.all([
        githubApi.getIssueComments(owner, repo, prNumber),
        githubApi.getPullRequestReviews(owner, repo, prNumber),
      ]);
      mrMetadata = {
        title: pullRequest.title,
        description: pullRequest.body ?? undefined,
        source_branch: pullRequest.head.ref,
        target_branch: pullRequest.base.ref,
        changes_count: pullRequest.changed_files,
        labels: pullRequest.labels?.map((label) => label.name),
        author: pullRequest.user ? { username: pullRequest.user.login } : undefined,
        state: pullRequest.state,
        Notes: [...comments, ...reviews].map((entry) => ({
          body: entry.body,
          author: entry.user ? { username: entry.user.login } : undefined,
          created_at: entry.created_at,
        })),
      };
    } catch (err) {
      logger.warn(`Failed to fetch GitHub comments and reviews: ${err}`);
    }

    // A successful Hodor summary contains a compressed, validated copy of the
    // structured result. Reuse it for an identical review identity so pipeline
    // retries can regenerate artifacts and retry delivery without another LLM
    // invocation. Explicit --full reviews always bypass this fast path.
    let reviewCacheKey: string | null = null;
    if (!localMode && !full && headSha) {
      reviewCacheKey = getReviewCacheKey({
        headSha,
        model,
        requestedReasoningEffort: reasoningEffort,
        reviewInstructions: effectiveReviewInstructions,
        additionalInstructions: effectiveAdditionalInstructions,
      });
      const cachedReview = findCachedReview(mrMetadata?.Notes, reviewCacheKey);
      if (cachedReview) {
        logger.info(`Reusing cached Hodor review for HEAD ${headSha.slice(0, 8)}`);
        const metrics: ReviewMetrics = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
          turns: 0,
          toolCalls: 0,
          durationSeconds: 0,
          reviewMode: "reused",
          reasoningEffort: reasoningEffort ?? "auto",
          diffFiles: 0,
          diffAdditions: 0,
          diffDeletions: 0,
          diffBytes: 0,
          reused: true,
        };
        logger.info(`Review telemetry: ${JSON.stringify({
          reviewMode: metrics.reviewMode,
          reasoningEffort: metrics.reasoningEffort,
          reused: true,
          headSha: headSha.slice(0, 12),
          findings: cachedReview.findings.length,
        })}`);
        printMetrics(metrics);
        return {
          review: cachedReview,
          metricsFooter: includeMetricsFooter ? formatMetricsMarkdown(metrics) : null,
          headSha,
          metrics,
          workspacePath,
          cacheMarker: null,
          reusedReview: true,
        };
      }
    }

    // Prefer the latest reviewed commit. Preserve three-dot semantics while it
    // is an ancestor; after a force-push/rebase, use a direct snapshot delta.
    const previousReviewBase = full || localMode
      ? null
      : await findLatestReviewBase(mrMetadata?.Notes, workspacePath);
    const previousReviewSha = previousReviewBase?.sha ?? null;
    let reviewMode: ReviewDiffMode = localMode
      ? "local"
      : previousReviewBase?.mode ?? "full";
    if (full) {
      reviewMode = "full";
      logger.info("Full review mode: ignoring previous hodor reviews, diffing entire source-vs-target range");
    } else if (previousReviewBase) {
      logger.info(`${previousReviewBase.mode === "snapshot" ? "Snapshot delta" : "Incremental"} mode: previous review at ${previousReviewSha?.slice(0, 8)}`);
    }

    // Pre-fetch the diff through GitHub so no checkout or git executable is needed.
    let embeddedDiff: string | null = null;
    let reviewDiff: string | null = null;
    let diffStats: DiffStats | null = null;
    let changedFiles: string[] = [];
    try {
      let rawDiff: string;
      if (targetOverrideSha) {
        rawDiff = await githubApi.compareDiff(owner, repo, targetOverrideSha, headSha);
      } else if (previousReviewSha && previousReviewBase?.mode !== "snapshot") {
        rawDiff = await githubApi.compareDiff(owner, repo, previousReviewSha, headSha);
      } else {
        // GitHub's compare endpoint always uses merge-base semantics and cannot
        // reproduce `git diff old HEAD` after a rebase. Review the full PR rather
        // than silently producing the wrong snapshot delta.
        if (previousReviewBase?.mode === "snapshot") {
          reviewMode = "full";
          logger.info("Snapshot delta is unavailable through GitHub REST; reviewing the full PR diff");
        }
        rawDiff = await githubApi.compareDiff(owner, repo, pullRequest.base.sha, headSha);
      }
      const { filtered: filteredDiff, skippedFiles } = filterEmbeddedDiff(rawDiff);
      if (skippedFiles.length > 0) {
        logger.info(`Filtered ${skippedFiles.length} file(s) from embedded diff: ${skippedFiles.join(", ")}`);
      }
      reviewDiff = filteredDiff;
      diffStats = getDiffStats(filteredDiff);
      changedFiles = getChangedFiles(filteredDiff);
      embeddedDiff = filteredDiff;
      const filteredBytes = new TextEncoder().encode(filteredDiff).byteLength;
      const rawBytes = new TextEncoder().encode(rawDiff).byteLength;
      logger.info(`Embedding GitHub diff in prompt (${filteredBytes} bytes, raw: ${rawBytes} bytes)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch the pull request diff from GitHub: ${message}`);
    }

    const thinkingLevel = selectReasoningEffort({
      requested: reasoningEffort,
      modelDefault: modelDefaultThinkingLevel,
      mode: reviewMode,
      forcedFull: full,
      diff: reviewDiff,
      stats: diffStats,
    });
    if (thinkingLevel) {
      logger.info(`Reasoning effort for ${piModel.name}: ${thinkingLevel}${reasoningEffort ? " (explicit)" : " (adaptive)"}`);
    }

    // Build the dynamic review task sent as the first user message.
    const prompt = buildPrReviewPrompt({
      prUrl: prUrl ?? `local diff (against ${targetBranch})`,
      platform,
      targetBranch,
      diffBaseSha,
      mrMetadata,
      embeddedDiff,
      previousReviewSha,
      reviewDiffMode: reviewMode,
      changedFiles,
      localMode,
    });

    const startTime = Date.now();
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspacePath,
      agentDir: getAgentDir(),
      settingsManager,
      systemPromptOverride: () => composedSystemPrompt,
      appendSystemPromptOverride: () => [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await resourceLoader.reload();
    const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
    if (skills.length > 0) {
      logger.info(`Discovered ${skills.length} repository skill(s)`);
      for (const skill of skills) {
        logger.info(`Found skill: ${skill.name} (${skill.filePath})`);
      }
    }
    for (const diagnostic of skillDiagnostics) {
      const path = diagnostic.path ? ` (${diagnostic.path})` : "";
      logger.warn(`Skill diagnostic: ${diagnostic.message}${path}`);
    }

    let submittedReview: ReviewOutput | null = null;
    let submitReviewCalls = 0;
    const submitReviewTool: ToolDefinition = {
      name: "submit_review",
      label: "Submit Review",
      description: "Submit the final structured review after the analysis is complete.",
      promptSnippet: "Submit the final structured review (call exactly once when done)",
      parameters: SUBMIT_REVIEW_SCHEMA,
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        submitReviewCalls++;
        if (submittedReview) {
          logger.warn("Agent called submit_review more than once; ignoring duplicate submission");
          return {
            content: [{
              type: "text",
              text: "Review already submitted. Do not call submit_review again.",
            }],
            details: { ignoredDuplicate: true },
          };
        }

        try {
          const reviewOutput = validateReviewOutput(params as ReviewOutput);
          submittedReview = reviewOutput;
          logger.info(
            `Received structured review via submit_review (${reviewOutput.findings.length} finding(s))`,
          );
        } catch (err) {
          logger.warn(`Invalid submit_review payload: ${err instanceof Error ? err.message : err}`);
          throw err;
        }
        return {
          content: [{
            type: "text",
            text: "Review received. Do not output the review as normal text.",
          }],
          details: {},
          terminate: true,
        };
      },
    };

    const { session } = await createAgentSession({
      cwd: workspacePath,
      model: piModel,
      thinkingLevel,
      // pi v0.74 filters customTools through the same allowlist as built-ins
      // (see _refreshToolRegistry in @earendil-works/pi-coding-agent's
      // agent-session.ts). The submit_review custom tool must be named here
      // or the LLM never sees it and the agent loop exits without calling it.
      tools: ["submit_review"],
      customTools: [submitReviewTool],
      modelRuntime,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
    });
    activeSession = session;

    // Inject Bedrock cost allocation tags into stream requests
    if (bedrockTags && parsed.provider === "amazon-bedrock") {
      type AgentWithStream = { agent: { streamFn: (...args: unknown[]) => unknown } };
      const agent = (session as unknown as AgentWithStream).agent;
      const originalStreamFn = agent.streamFn;
      agent.streamFn = (...args: unknown[]) => {
        const options = (args[2] ?? {}) as Record<string, unknown>;
        return originalStreamFn(args[0], args[1], { ...options, requestMetadata: bedrockTags });
      };
      logger.info(`Bedrock cost allocation tags: ${JSON.stringify(bedrockTags)}`);
    }

    // Subscribe to agent events for progress + metrics tracking
    let turnCount = 0;
    let toolCallCount = 0;

    /** Extract human-readable summary from tool args */
    function formatToolArgs(_toolName: string, args: unknown): string {
      if (typeof args === "string") return args.slice(0, 200);
      const obj = args as Record<string, unknown> | undefined;
      if (!obj) return "";
      // grep/find: show pattern + path
      if (obj.pattern) {
        const path = obj.path ? ` in ${obj.path}` : "";
        return `${obj.pattern}${path}`;
      }
      // read/ls: show the path
      if (obj.path || obj.file_path) return String(obj.path ?? obj.file_path);
      return JSON.stringify(obj).slice(0, 200);
    }

    /** Extract text content from tool result */
    function formatToolResult(result: unknown): string {
      if (typeof result === "string") return result;
      const obj = result as Record<string, unknown> | undefined;
      if (!obj) return "";
      // pi-sdk wraps results as {content: [{type: "text", text: "..."}]}
      const content = obj.content as Array<{ type?: string; text?: string }> | undefined;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }
      return JSON.stringify(result)?.slice(0, 500) ?? "";
    }

    session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          onEvent?.({ type: "agent_start" });
          break;
        case "agent_end":
          onEvent?.({ type: "agent_end" });
          break;
        case "turn_start":
          turnCount++;
          onEvent?.({ type: "turn_start", turnIndex: turnCount });
          break;
        case "turn_end":
          onEvent?.({ type: "turn_end", turnIndex: turnCount });
          break;
        case "tool_execution_start":
          toolCallCount++;
          onEvent?.({
            type: "tool_start",
            toolName: event.toolName,
            toolArgs: formatToolArgs(event.toolName, event.args),
          });
          break;
        case "tool_execution_end":
          onEvent?.({
            type: "tool_end",
            toolName: event.toolName,
            isError: event.isError,
            result: formatToolResult(event.result),
          });
          break;
        case "message_start":
          onEvent?.({ type: "thinking" });
          break;
        case "message_update": {
          const msgEvent = (event as Record<string, unknown>).assistantMessageEvent as
            { type: string; delta?: string } | undefined;
          if (!msgEvent?.delta) break;
          if (msgEvent.type === "text_delta") {
            onEvent?.({ type: "text_delta", delta: msgEvent.delta });
          } else if (msgEvent.type === "thinking_delta") {
            onEvent?.({ type: "thinking_delta", delta: msgEvent.delta });
          }
          break;
        }
      }
    });

    const throwIfAgentErrored = (): void => {
      // pi-agent-core stores failed/aborted assistant turns in state.errorMessage.
      const agentError = session.state.errorMessage;
      if (agentError) {
        throw new Error(`LLM request failed: ${agentError}`);
      }
    };

    const recoverReviewFromAssistantText = (source: string): boolean => {
      const rawText = session.getLastAssistantText() ?? "";
      if (!rawText.trim()) return false;

      const parsedReview = parseReviewFromAssistantText(rawText);
      if (!parsedReview) return false;

      submittedReview = parsedReview;
      logger.warn(
        `Recovered structured review from assistant text after ${source}; model did not call submit_review`,
      );
      return true;
    };

    logger.info("Sending prompt to agent...");
    await session.prompt(prompt);
    throwIfAgentErrored();

    if (!submittedReview) {
      recoverReviewFromAssistantText("initial agent run");
    }

    for (
      let attempt = 1;
      !submittedReview && attempt <= SUBMIT_REVIEW_RECOVERY_ATTEMPTS;
      attempt++
    ) {
      logger.warn(
        `Agent ended without a valid submit_review (${summarizeLastAssistantMessage(session)}); ` +
        `requesting recovery ${attempt}/${SUBMIT_REVIEW_RECOVERY_ATTEMPTS}`,
      );
      await session.prompt(buildSubmitReviewRecoveryPrompt(attempt, SUBMIT_REVIEW_RECOVERY_ATTEMPTS));
      throwIfAgentErrored();
      recoverReviewFromAssistantText(`recovery attempt ${attempt}`);
    }

    if (!submittedReview) {
      const diagnostic = summarizeLastAssistantMessage(session);
      if (submitReviewCalls > 0) {
        throw new Error(
          `Agent called submit_review but did not provide a valid review payload after ` +
          `${SUBMIT_REVIEW_RECOVERY_ATTEMPTS} recovery attempt(s): ${diagnostic}`,
        );
      }
      throw new Error(
        `Agent did not call submit_review after ${SUBMIT_REVIEW_RECOVERY_ATTEMPTS} recovery attempt(s): ${diagnostic}`,
      );
    }

    const rawReview = submittedReview as ReviewOutput;
    if (submitReviewCalls > 1) {
      logger.warn(`Agent called submit_review ${submitReviewCalls} times; using the first valid submission`);
    }

    // There is no checked-out filesystem in a Worker. Findings retain the
    // line ranges validated against the embedded GitHub diff by the model.
    const review = rawReview;

    logger.info(
      `Captured ${review.findings.length} finding(s), verdict: ${review.overall_correctness}`,
    );

    const durationSeconds = (Date.now() - startTime) / 1000;
    logger.info(`Review complete (${review.findings.length} finding(s))`);

    // Aggregate usage from all assistant messages
    interface MsgUsage {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: { total: number };
    }
    interface AssistantMsg {
      role: string;
      usage?: MsgUsage;
    }

    const allMessages = session.messages as AssistantMsg[];

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let cost = 0;

    for (const msg of allMessages) {
      if (msg.role === "assistant" && msg.usage) {
        inputTokens += msg.usage.input ?? 0;
        outputTokens += msg.usage.output ?? 0;
        cacheReadTokens += msg.usage.cacheRead ?? 0;
        cacheWriteTokens += msg.usage.cacheWrite ?? 0;
        totalTokens += msg.usage.totalTokens ?? 0;
        cost += msg.usage.cost?.total ?? 0;
      }
    }

    const metrics: ReviewMetrics = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      cost,
      turns: turnCount,
      toolCalls: toolCallCount,
      durationSeconds: Math.round(durationSeconds),
      reviewMode,
      reasoningEffort: thinkingLevel ?? "none",
      diffFiles: diffStats?.files ?? 0,
      diffAdditions: diffStats?.additions ?? 0,
      diffDeletions: diffStats?.deletions ?? 0,
      diffBytes: diffStats?.bytes ?? 0,
      reused: false,
    };
    logger.info(`Review telemetry: ${JSON.stringify({
      reviewMode: metrics.reviewMode,
      reasoningEffort: metrics.reasoningEffort,
      reused: false,
      diffFiles: metrics.diffFiles,
      diffAdditions: metrics.diffAdditions,
      diffDeletions: metrics.diffDeletions,
      diffBytes: metrics.diffBytes,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      inputTokens: metrics.inputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      outputTokens: metrics.outputTokens,
      cost: metrics.cost,
      findings: review.findings.length,
    })}`);
    printMetrics(metrics);

    let metricsFooter: string | null = null;
    if (includeMetricsFooter) {
      metricsFooter = formatMetricsMarkdown(metrics);
    }

    const cacheMarker = reviewCacheKey
      ? buildReviewCacheMarker(reviewCacheKey, review, workspacePath)
      : null;

    return {
      review,
      metricsFooter,
      headSha,
      metrics,
      workspacePath,
      cacheMarker,
      reusedReview: false,
    };
  } finally {
    activeSession?.dispose();

    // Restore mutated env vars
    for (const [key, val] of Object.entries(envSnapshot)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }

  }
}