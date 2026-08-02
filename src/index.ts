import { GitHubAuthStore } from "./auth/github-auth-store";
import { ReviewerAgent } from "./agent/ReviewerAgent";
import { GitHub } from "./github";
import {
  GITHUB_CALLBACK_PATH,
  handleGitHubCallback,
} from "./auth/github-callback";
import type { AppEnv } from "./env";
import { handleTelegramWebhook, notifyGitHubConnected } from "./telegram/bot";

export { GitHubAuthStore, ReviewerAgent };

export default {
  async fetch(request, env, _context): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Bran is running", {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const github = new GitHub(env);
    if (url.pathname === GITHUB_CALLBACK_PATH) {
      return handleGitHubCallback({
        request,
        github,
        notifyConnected: (telegramUserId, githubLogin) =>
          notifyGitHubConnected(env.TELEGRAM_BOT_TOKEN, telegramUserId, githubLogin),
      });
    }

    return handleTelegramWebhook(request, {
      token: env.TELEGRAM_BOT_TOKEN,
      github,
    });
  },
} satisfies ExportedHandler<AppEnv>;
