import { Bot, webhookCallback, type Context } from "grammy";
import type { GitHub } from "../github";
import type { GitHubReviewEvent } from "../reviewer/github-api";
import { parsePullRequestUrl, parseReviewAction, privateTelegramUserId } from "./command-utils";

export interface TelegramBotDependencies {
  token: string;
  github: GitHub;
}

export function handleTelegramWebhook(
  request: Request,
  dependencies: TelegramBotDependencies,
): Promise<Response> {
  return webhookCallback(createTelegramBot(dependencies), "cloudflare-mod", {
    onTimeout: "return",
    timeoutMilliseconds: 9_000,
  })(request);
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
      "Use /connect to authorize GitHub. Then use /review with a pull-request URL. You can also use /comment, /approve, or /requestchanges with a URL and message.",
    );
  });

  bot.command(["connect", "login"], async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const authorizationUrl = await dependencies.github.connectionUrl(userId);
    await ctx.reply(`Authorize Fortagram to act as your GitHub user:\n${authorizationUrl}`);
  });

  bot.command("status", async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const githubLogin = await dependencies.github.connectedLogin(userId);
    await ctx.reply(
      githubLogin
        ? `Connected to GitHub as @${githubLogin}.`
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

  bot.command("review", async (ctx) => {
    const userId = await requirePrivateUser(ctx);
    if (!userId) return;
    const prUrl = parsePullRequestUrl(String(ctx.match ?? ""));
    if (!prUrl) {
      await ctx.reply("Usage: /review https://github.com/owner/repository/pull/123");
      return;
    }

    await ctx.reply("Review started. I’ll post the result to GitHub when it is ready.");
    const result = await dependencies.github.reviewPullRequest({
      telegramUserId: userId,
      prUrl,
    });
    if (result.status === "not_connected") {
      await ctx.reply("Connect GitHub with /connect before reviewing a pull request.");
    } else if (result.status === "posted") {
      const findingLabel = result.findings === 1 ? "finding" : "findings";
      await ctx.reply(
        `Review posted as @${result.githubLogin} with ${result.findings} ${findingLabel}.`,
      );
    } else {
      await ctx.reply(`Review failed: ${result.message}`);
    }
  });

  registerReviewAction(bot, dependencies.github, "comment", "COMMENT");
  registerReviewAction(bot, dependencies.github, "approve", "APPROVE");
  registerReviewAction(bot, dependencies.github, "requestchanges", "REQUEST_CHANGES");
  return bot;
}

function registerReviewAction(
  bot: Bot,
  github: GitHub,
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

    const result = await github.review({
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
