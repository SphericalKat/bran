import { Agent } from "agents";
import type { AppEnv } from "../env";
import type { AgentProgressEvent, ReviewResult } from "../reviewer/agent";
import { postReviewStructured } from "../reviewer/publisher";

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
  reasoningEffort?: string;
  full?: boolean;
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
      throw new Error("A review is already running for this user");
    }

    this.activeReview = this.performReview(input);
    return this.activeReview.finally(() => {
      this.activeReview = null;
    });
  }

  private async performReview(input: RunCodeReviewInput): Promise<ReviewResult> {
    const startedAt = Date.now();
    this.setState({
      status: "reviewing",
      prUrl: input.prUrl,
      phase: "Loading pull request",
      error: null,
      startedAt,
      finishedAt: null,
    });

    try {
      const { reviewPr } = await import("../reviewer/agent");
      const result = await this.keepAliveWhile(async () => {
        const generated = await reviewPr({
          prUrl: input.prUrl,
          githubToken: input.githubToken,
          llmApiKey: this.env.LLM_API_KEY,
          model: input.model ?? this.env.REVIEW_MODEL,
          reasoningEffort: input.reasoningEffort,
          full: input.full,
          includeMetricsFooter: true,
          onEvent: (event) => this.recordProgress(event),
        });
        this.setState({ ...this.state, phase: "Posting review to GitHub" });
        const published = await postReviewStructured({
          prUrl: input.prUrl,
          review: generated.review,
          githubToken: input.githubToken,
          event: "COMMENT",
          model: generated.model,
          metricsFooter: generated.metricsFooter,
          headSha: generated.headSha,
        });
        if (!published.success) {
          throw new Error(published.error ?? "GitHub rejected the generated review");
        }
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
      throw error;
    }
  }

  private recordProgress(event: AgentProgressEvent): void {
    let phase: string | null = null;
    if (event.type === "turn_start") phase = `Reviewing code (pass ${event.turnIndex ?? 1})`;
    if (event.type === "tool_start") phase = `Inspecting code with ${event.toolName ?? "a repository tool"}`;
    if (!phase) return;
    this.setState({ ...this.state, phase });
  }
}
