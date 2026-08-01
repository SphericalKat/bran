import { createReviewActionService } from "./actions/review-action-service";
import { GitHubAuthStore } from "./auth/github-auth-store";
import {
  createGitHubOAuthServiceFromEnv,
} from "./auth/github-oauth-service";
import {
  GITHUB_OAUTH_CALLBACK_PATH,
  handleGitHubOAuthCallback,
} from "./auth/github-oauth-routes";
import type { AppEnv } from "./env";
import { handleTelegramWebhook, notifyGitHubConnected } from "./telegram/bot";

export { GitHubAuthStore };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === GITHUB_OAUTH_CALLBACK_PATH) {
      const oauth = createGitHubOAuthServiceFromEnv(env);
      return handleGitHubOAuthCallback({
        request,
        oauth,
        notifyConnected: (telegramUserId, githubLogin) =>
          notifyGitHubConnected(env.TELEGRAM_BOT_TOKEN, telegramUserId, githubLogin),
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Fortagram is running", {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const oauth = createGitHubOAuthServiceFromEnv(env);
    return handleTelegramWebhook(request, {
      token: env.TELEGRAM_BOT_TOKEN,
      oauth,
      reviewActions: createReviewActionService(oauth),
    });
  },
} satisfies ExportedHandler<AppEnv>;
