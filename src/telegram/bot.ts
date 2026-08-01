import { Bot, webhookCallback, type Context } from "grammy";
import { postReview } from "../actions/post-review";
import type { GitHubAuth } from "../auth/github-auth";
import type { GitHubReviewEvent } from "../reviewer/github-api";
import { parseReviewAction, privateTelegramUserId } from "./command-utils";

export interface TelegramBotDependencies {
  token: string;
  github: GitHubAuth;
}

export function handleTelegramWebhook(
  request: Request,
  dependencies: TelegramBotDependencies,
): Promise<Response> {
  return webhookCallback(createTelegramBot(dependencies), "cloudflare-mod")(request);
}

export async function notifyGitHubConnected(
  token: string,
  telegramUserId: string,
  githubLogin: string,
): Promise<void> {
  await new Bot(token).api.sendMessage(
    telegramUserId,
    `GitHub connected as @${githubLogin}. Reviews will be posted as your GitHub user.`,
  );
}

function createTelegramBot(dependencies: TelegramBotDependencies): Bot {
  const bot = new Bot(dependencies.token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Use /connect to authorize GitHub. Then use /comment, /approve, or /requestchanges with a pull-request URL and message.",
    );
  });

  bot.command(["connect", "login"], async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const authorizationUrl = await dependencies.github.getConnectionUrl(userId);
    await ctx.reply(`Authorize Fortagram to act as your GitHub user:\n${authorizationUrl}`);
  });

  bot.command("status", async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const connection = await dependencies.github.getConnection(userId);
    await ctx.reply(
      connection
        ? `Connected to GitHub as @${connection.githubLogin}.`
        : "GitHub is not connected. Use /connect first.",
    );
  });

  bot.command(["disconnect", "logout"], async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    await dependencies.github.disconnect(userId);
    await ctx.reply(
      "GitHub authorization removed from Fortagram. You can also revoke the app in GitHub settings.",
    );
  });

  registerReviewAction(bot, dependencies.github, "comment", "COMMENT");
  registerReviewAction(bot, dependencies.github, "approve", "APPROVE");
  registerReviewAction(bot, dependencies.github, "requestchanges", "REQUEST_CHANGES");
  return bot;
}

function registerReviewAction(
  bot: Bot,
  github: GitHubAuth,
  command: string,
  event: GitHubReviewEvent,
): void {
  bot.command(command, async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const parsed = parseReviewAction(String(ctx.match ?? ""));
    if (!parsed) {
      await ctx.reply(
        `Usage: /${command} https://github.com/owner/repository/pull/123 Your review message`,
      );
      return;
    }

    const result = await postReview(github, {
      telegramUserId: userId,
      prUrl: parsed.prUrl,
      message: parsed.message,
      event,
    });
    if (result.status === "not_connected") {
      await ctx.reply("Connect GitHub with /connect before taking actions.");
    } else if (result.status === "posted") {
      await ctx.reply(`GitHub review posted as @${result.githubLogin}.`);
    } else {
      await ctx.reply(`GitHub rejected the review: ${result.message}`);
    }
  });
}

async function requirePrivateUser(ctx: Context): Promise<string | null> {
  const userId = privateTelegramUserId({
    chatType: ctx.chat?.type,
    chatId: ctx.chat?.id,
    userId: ctx.from?.id,
  });
  if (!userId) {
    await ctx.reply("GitHub authorization and actions are only available in a private chat with the bot.");
  }
  return userId;
}
