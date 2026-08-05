import { Agent } from "agents";
import type { AppEnv } from "../env";
import type { AgentProgressEvent, ReviewResult } from "../reviewer/agent";
import { resolveReviewModelList } from "../reviewer/model";
import { postReviewStructured } from "../reviewer/publisher";
import {
  TelegramReviewProgress,
  type TelegramReviewProgressTarget,
} from "../telegram/review-progress";

export interface ReviewerAgentState {
  status: "idle" | "reviewing" | "complete" | "failed";
  prUrl: string | null;
  phase: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunCodeReviewInput {
  prUrl: string;
  githubToken: string;
  model?: string;
  models?: string[];
  orchestratorModel?: string;
  reasoningEffort?: string;
  full?: boolean;
  githubLogin: string;
  progress?: TelegramReviewProgressTarget;
}

export class ReviewerAgent extends Agent<AppEnv, ReviewerAgentState> {
  initialState: ReviewerAgentState = {
    status: "idle",
    prUrl: null,
    phase: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };

  private activeReview: Promise<ReviewResult> | null = null;

  async runCodeReview(input: RunCodeReviewInput): Promise<ReviewResult> {
    if (this.activeReview) {
      throw new Error("A review is already running in this review agent");
    }

    this.activeReview = this.performReview(input);
    return this.activeReview.finally(async () => {
      try {
        await this.deleteStorage();
      } finally {
        this.activeReview = null;
      }
    });
  }

  private async deleteStorage(): Promise<void> {
    try {
      await this.ctx.storage.deleteAll();
    } catch (error) {
      console.warn("Failed to delete review storage", error);
    }
  }

  private async performReview(input: RunCodeReviewInput): Promise<ReviewResult> {
    const startedAt = Date.now();
    const progress = input.progress
      ? new TelegramReviewProgress(this.env.TELEGRAM_BOT_TOKEN, input.progress)
      : null;
    let progressUpdates = Promise.resolve();
    const reportProgress = (phase: string, force = false) => {
      progressUpdates = progressUpdates
        .then(() => progress?.update(phase, force))
        .then(() => undefined)
        .catch((error) => console.warn("Failed to update Telegram review progress", error));
    };
    this.setState({
      status: "reviewing",
      prUrl: input.prUrl,
      phase: "Loading pull request",
      error: null,
      startedAt,
      finishedAt: null,
    });
    reportProgress("Loading pull request", true);

    try {
      const { reviewPr } = await import("../reviewer/agent");
      const result = await this.keepAliveWhile(async () => {
        const configuredModels = resolveReviewModelList({
          models: input.models,
          model: input.model,
          configuredModels: this.env.REVIEW_MODELS,
          fallbackModel: this.env.REVIEW_MODEL,
        });
        const generated = await reviewPr({
          prUrl: input.prUrl,
          githubToken: input.githubToken,
          llmApiKey: this.env.LLM_API_KEY,
          model: configuredModels[0],
          models: configuredModels,
          orchestratorModel: input.orchestratorModel ?? this.env.REVIEW_ORCHESTRATOR_MODEL,
          maxConcurrency: parsePositiveInteger(this.env.REVIEW_MAX_CONCURRENCY),
          reviewTimeoutMs: parsePositiveInteger(this.env.REVIEW_TIMEOUT_MS),
          reasoningEffort: input.reasoningEffort,
          full: input.full,
          onEvent: (event) => this.recordProgress(event, reportProgress),
        });
        this.setState({ ...this.state, phase: "Posting review to GitHub" });
        reportProgress("Posting review to GitHub", true);
        await progressUpdates;
        const timedOutReviewers = generated.failedModels?.filter((failure) => failure.timedOut).length ?? 0;
        const published = await postReviewStructured({
          prUrl: input.prUrl,
          review: generated.review,
          githubToken: input.githubToken,
          headSha: generated.headSha,
          notice: timedOutReviewers > 0
            ? `Skipped ${timedOutReviewers} reviewer model${timedOutReviewers === 1 ? "" : "s"} because they did not finish within the shared time budget.`
            : undefined,
        });
        if (!published.success) {
          throw new Error(published.error ?? "GitHub rejected the generated review");
        }
        await this.notifyProgress(() => progress?.complete(
          input.githubLogin,
          generated.review.findings.length,
        ));
        return generated;
      });
      this.setState({
        ...this.state,
        status: "complete",
        phase: "Review complete",
        finishedAt: Date.now(),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({
        ...this.state,
        status: "failed",
        phase: "Review failed",
        error: message,
        finishedAt: Date.now(),
      });
      await progressUpdates;
      await this.notifyProgress(() => progress?.failed(message));
      throw error;
    }
  }

  private recordProgress(
    event: AgentProgressEvent,
    report: (phase: string, force?: boolean) => void,
  ): void {
    let phase: string | null = null;
    const actor = event.model ? shortModelName(event.model) : undefined;
    if (event.type === "phase") phase = actor ? `${event.phase} (${actor})` : event.phase ?? null;
    if (event.type === "turn_start") {
      phase = event.role === "orchestrator"
        ? `Synthesizing findings${actor ? ` (${actor})` : ""}`
        : `Reviewing code${actor ? ` (${actor})` : ""}, pass ${event.turnIndex ?? 1}`;
    }
    if (event.type === "tool_start") {
      const tool = toolPhase(event.toolName);
      phase = actor ? `${tool} (${actor})` : tool;
    }
    if (!phase) return;
    this.setState({ ...this.state, phase });
    report(phase);
  }

  private async notifyProgress(action: () => Promise<void> | undefined): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.warn("Failed to update Telegram review progress", error);
    }
  }
}

function toolPhase(toolName: string | undefined): string {
  switch (toolName) {
    case "read_file": return "Reading surrounding source";
    case "search_code": return "Searching related code";
    case "get_file_diff": return "Inspecting a changed file";
    case "submit_review": return "Finalizing findings";
    default: return "Inspecting repository context";
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function shortModelName(model: string): string {
  const parts = model.split("/");
  return parts.at(-1) || model;
}
