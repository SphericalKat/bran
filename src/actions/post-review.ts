import type { GitHubAuth } from "../auth/github-auth";
import type { GitHubReviewEvent } from "../reviewer/github-api";
import { postReviewComment } from "../reviewer/publisher";

export type ReviewActionResult =
  | { status: "not_connected" }
  | { status: "posted"; githubLogin: string }
  | { status: "rejected"; message: string };

export interface ReviewAction {
  telegramUserId: string;
  prUrl: string;
  message: string;
  event: GitHubReviewEvent;
}

export async function postReview(
  github: GitHubAuth,
  input: ReviewAction,
  publish: typeof postReviewComment = postReviewComment,
): Promise<ReviewActionResult> {
  const connection = await github.getConnection(input.telegramUserId);
  if (!connection) return { status: "not_connected" };

  const result = await publish({
    prUrl: input.prUrl,
    reviewText: input.message,
    githubToken: connection.accessToken,
    event: input.event,
  });
  return result.success
    ? { status: "posted", githubLogin: connection.githubLogin }
    : { status: "rejected", message: result.error ?? "Unknown error" };
}
