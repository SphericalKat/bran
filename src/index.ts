import { Bot, webhookCallback } from "grammy";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubAuthorizationCode,
  fetchGitHubUser,
  refreshGitHubUserAccessToken,
  signOAuthState,
  verifyOAuthState,
  type GitHubAppOAuthConfig,
  type GitHubUserAccessToken,
} from "./auth/github";
import { ReviewerAgent, type GitHubAuthorization } from "./agents/reviewer";
import { postReviewComment } from "./reviewer/publisher";
import type { GitHubReviewEvent } from "./reviewer/github-api";

export { ReviewerAgent };

const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const OAUTH_CALLBACK_PATH = "/auth/github/callback";

export interface Env {
  ReviewerAgent: DurableObjectNamespace<ReviewerAgent>;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_OAUTH_STATE_SECRET: string;
  GITHUB_CALLBACK_URL: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === OAUTH_CALLBACK_PATH) {
      return handleGitHubOAuthCallback(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Fortagram is running", {
        headers: { "Cache-Control": "no-store" },
      });
    }

    const bot = createBot(env);
    return webhookCallback(bot, "cloudflare-mod")(request);
  },
} satisfies ExportedHandler<Env>;

function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Use /connect to authorize GitHub. Then use /comment, /approve, or /requestchanges with a pull-request URL and message.",
    );
  });

  bot.command(["connect", "login"], async (ctx) => {
    const telegramUserId = requirePrivateTelegramUser(ctx.chat?.type, ctx.chat?.id, ctx.from?.id);
    const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
    const reviewer = getReviewerAgent(env, telegramUserId);
    const nonce = await reviewer.createOAuthNonce(telegramUserId, expiresAt);
    const state = await signOAuthState({ telegramUserId, nonce, expiresAt }, env.GITHUB_OAUTH_STATE_SECRET);
    const authorizationUrl = buildGitHubAuthorizationUrl({
      clientId: env.GITHUB_APP_CLIENT_ID,
      redirectUri: env.GITHUB_CALLBACK_URL,
      state,
    });

    await ctx.reply(`Authorize Fortagram to act as your GitHub user:\n${authorizationUrl}`);
  });

  bot.command("status", async (ctx) => {
    const telegramUserId = requirePrivateTelegramUser(ctx.chat?.type, ctx.chat?.id, ctx.from?.id);
    const authorization = await getReviewerAgent(env, telegramUserId)
      .getGitHubAuthorization(telegramUserId);
    await ctx.reply(
      authorization
        ? `Connected to GitHub as @${authorization.githubLogin}.`
        : "GitHub is not connected. Use /connect first.",
    );
  });

  bot.command(["disconnect", "logout"], async (ctx) => {
    const telegramUserId = requirePrivateTelegramUser(ctx.chat?.type, ctx.chat?.id, ctx.from?.id);
    await getReviewerAgent(env, telegramUserId).deleteGitHubAuthorization(telegramUserId);
    await ctx.reply("GitHub authorization removed from Fortagram. You can also revoke the app in GitHub settings.");
  });

  registerReviewAction(bot, env, "comment", "COMMENT");
  registerReviewAction(bot, env, "approve", "APPROVE");
  registerReviewAction(bot, env, "requestchanges", "REQUEST_CHANGES");

  return bot;
}

async function handleGitHubOAuthCallback(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const state = await verifyOAuthState(stateValue, env.GITHUB_OAUTH_STATE_SECRET);
  if (!state || !code) {
    return oauthHtml("Authorization failed", "The authorization link is invalid or expired. Return to Telegram and run /connect again.", 400);
  }

  const reviewer = getReviewerAgent(env, state.telegramUserId);
  const nonceWasValid = await reviewer.consumeOAuthNonce(
    state.telegramUserId,
    state.nonce,
  );
  if (!nonceWasValid) {
    return oauthHtml("Authorization failed", "This authorization link has already been used or expired.", 400);
  }

  try {
    const token = await exchangeGitHubAuthorizationCode(oauthConfig(env), code);
    const user = await fetchGitHubUser(token.accessToken);
    await reviewer.storeGitHubAuthorization(state.telegramUserId, user, token);

    const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    try {
      await bot.api.sendMessage(
        state.telegramUserId,
        `GitHub connected as @${user.login}. Reviews will be posted as your GitHub user.`,
      );
    } catch (error) {
      console.warn(JSON.stringify({ event: "github_oauth_notification_failed", error: safeErrorMessage(error) }));
    }
    return oauthHtml("GitHub connected", `You are connected as @${user.login}. You can return to Telegram.`);
  } catch (error) {
    console.error(JSON.stringify({ event: "github_oauth_callback_failed", error: safeErrorMessage(error) }));
    return oauthHtml("Authorization failed", "GitHub authorization could not be completed. Return to Telegram and run /connect again.", 502);
  }
}

async function getValidGitHubAuthorization(
  env: Env,
  telegramUserId: string,
): Promise<GitHubAuthorization | null> {
  const reviewer = getReviewerAgent(env, telegramUserId);
  const authorization = await reviewer.getGitHubAuthorization(telegramUserId);
  if (!authorization) return null;
  if (
    authorization.accessTokenExpiresAt === null ||
    authorization.accessTokenExpiresAt > Date.now() + TOKEN_REFRESH_WINDOW_MS
  ) {
    return authorization;
  }
  if (
    !authorization.refreshToken ||
    (authorization.refreshTokenExpiresAt !== null && authorization.refreshTokenExpiresAt <= Date.now())
  ) {
    await reviewer.deleteGitHubAuthorization(telegramUserId);
    return null;
  }

  const now = Date.now();
  const refreshed = await refreshGitHubUserAccessToken(oauthConfig(env), authorization.refreshToken);
  const mergedToken: GitHubUserAccessToken = {
    ...refreshed,
    scope: refreshed.scope ?? authorization.scope,
    refreshToken: refreshed.refreshToken ?? authorization.refreshToken,
    refreshTokenExpiresIn: refreshed.refreshToken
      ? refreshed.refreshTokenExpiresIn
      : remainingSeconds(authorization.refreshTokenExpiresAt, now),
  };
  await reviewer.storeGitHubAuthorization(
    telegramUserId,
    { id: authorization.githubUserId, login: authorization.githubLogin },
    mergedToken,
    now,
  );
  return reviewer.getGitHubAuthorization(telegramUserId);
}

function registerReviewAction(
  bot: Bot,
  env: Env,
  command: string,
  event: GitHubReviewEvent,
): void {
  bot.command(command, async (ctx) => {
    const telegramUserId = requirePrivateTelegramUser(ctx.chat?.type, ctx.chat?.id, ctx.from?.id);
    const parsed = parseReviewAction(String(ctx.match ?? ""));
    if (!parsed) {
      await ctx.reply(`Usage: /${command} https://github.com/owner/repository/pull/123 Your review message`);
      return;
    }

    const authorization = await getValidGitHubAuthorization(env, telegramUserId);
    if (!authorization) {
      await ctx.reply("Connect GitHub with /connect before taking actions.");
      return;
    }

    const result = await postReviewComment({
      prUrl: parsed.prUrl,
      reviewText: parsed.message,
      githubToken: authorization.accessToken,
      event,
    });
    await ctx.reply(
      result.success
        ? `GitHub review posted as @${authorization.githubLogin}.`
        : `GitHub rejected the review: ${result.error ?? "Unknown error"}`,
    );
  });
}

function parseReviewAction(value: string): { prUrl: string; message: string } | null {
  const match = value.trim().match(/^(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prUrl: match[1], message: match[2].trim() };
}

function getReviewerAgent(env: Env, telegramUserId: string) {
  return env.ReviewerAgent.getByName(telegramUserId);
}

function oauthConfig(env: Env): GitHubAppOAuthConfig {
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    redirectUri: env.GITHUB_CALLBACK_URL,
  };
}

function requirePrivateTelegramUser(
  chatType: string | undefined,
  chatId: number | undefined,
  userId: number | undefined,
): string {
  if (userId === undefined || chatType !== "private" || chatId !== userId) {
    throw new Error("GitHub authorization and actions are only available in a private chat with the bot");
  }
  return String(userId);
}

function remainingSeconds(expiresAt: number | null, now: number): number | null {
  return expiresAt === null ? null : Math.max(0, Math.floor((expiresAt - now) / 1_000));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function oauthHtml(title: string, message: string, status = 200): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
