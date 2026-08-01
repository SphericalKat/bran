import type { GitHubOAuthService } from "../auth/github-oauth-service";
import type { GitHubReviewEvent } from "../reviewer/github-api";
import { postReviewComment } from "../reviewer/publisher";

export type ReviewActionResult =
  | { status: "not_connected" }
  | { status: "posted"; githubLogin: string }
  | { status: "rejected"; message: string };

export interface ReviewActionService {
  execute(input: {
    telegramUserId: string;
    prUrl: string;
    message: string;
    event: GitHubReviewEvent;
  }): Promise<ReviewActionResult>;
}

export function createReviewActionService(
  oauth: GitHubOAuthService,
  publish: typeof postReviewComment = postReviewComment,
): ReviewActionService {
  return {
    async execute(input) {
      const authorization = await oauth.getAuthorization(input.telegramUserId);
      if (!authorization) return { status: "not_connected" };

      const result = await publish({
        prUrl: input.prUrl,
        reviewText: input.message,
        githubToken: authorization.accessToken,
        event: input.event,
      });
      return result.success
        ? { status: "posted", githubLogin: authorization.githubLogin }
        : { status: "rejected", message: result.error ?? "Unknown error" };
    },
  };
}
