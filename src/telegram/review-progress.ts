import { Bot } from "grammy";

export interface TelegramReviewProgressTarget {
  chatId: number;
  messageId: number;
  requesterId: number;
  requesterName: string;
  prUrl: string;
}

export class TelegramReviewProgress {
  private readonly editMessage: (text: string) => Promise<unknown>;
  private lastUpdateAt = 0;
  private lastPhase = "";

  constructor(
    token: string,
    private readonly target: TelegramReviewProgressTarget,
    editMessage?: (text: string) => Promise<unknown>,
    private readonly minUpdateIntervalMs = 1_500,
  ) {
    const bot = new Bot(token);
    this.editMessage = editMessage ?? ((text) => bot.api.editMessageText(
      target.chatId,
      target.messageId,
      text,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    ));
  }

  async update(phase: string, force = false): Promise<void> {
    const now = Date.now();
    if (phase === this.lastPhase || (!force && now - this.lastUpdateAt < this.minUpdateIntervalMs)) return;
    this.lastPhase = phase;
    this.lastUpdateAt = now;
    await this.edit([
      `⏳ Reviewing ${pullRequestLink(this.target.prUrl)}`,
      `<b>Status:</b> ${escapeHtml(phase)}`,
      `Requested by ${escapeHtml(this.target.requesterName)}`,
    ].join("\n"));
  }

  complete(githubLogin: string, findings: number): Promise<void> {
    const findingLabel = findings === 1 ? "finding" : "findings";
    return this.editTerminal([
      `✅ ${requesterMention(this.target)}, your review is complete`,
      `Posted to GitHub as @${escapeHtml(githubLogin)} with ${findings} ${findingLabel}`,
      pullRequestLink(this.target.prUrl),
    ].join("\n"));
  }

  failed(message: string): Promise<void> {
    return this.editTerminal([
      `❌ ${requesterMention(this.target)}, the review failed`,
      escapeHtml(message.slice(0, 500)),
      pullRequestLink(this.target.prUrl),
    ].join("\n"));
  }

  private async edit(text: string): Promise<void> {
    await this.editMessage(text);
    this.lastUpdateAt = Date.now();
  }

  private async editTerminal(text: string): Promise<void> {
    const waitMs = this.minUpdateIntervalMs - (Date.now() - this.lastUpdateAt);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    await this.edit(text);
  }
}

export function initialReviewProgressText(input: {
  prUrl: string;
  requesterId: number;
  requesterName: string;
}): string {
  return [
    `⏳ Queued review for ${pullRequestLink(input.prUrl)}`,
    "<b>Status:</b> Starting",
    `Requested by ${escapeHtml(input.requesterName)}`,
  ].join("\n");
}

function requesterMention(input: { requesterId: number; requesterName: string }): string {
  return `<a href="tg://user?id=${input.requesterId}">${escapeHtml(input.requesterName)}</a>`;
}

function pullRequestLink(prUrl: string): string {
  const match = prUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i);
  const label = match ? `${match[1]}/${match[2]}#${match[3]}` : "pull request";
  return `<a href="${escapeHtml(prUrl)}">${escapeHtml(label)}</a>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
