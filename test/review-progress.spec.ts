import { describe, expect, it, vi } from "vitest";
import {
  initialReviewProgressText,
  TelegramReviewProgress,
} from "../src/telegram/review-progress";

describe("Telegram review progress", () => {
  it("links the pull request and safely mentions the requester", () => {
    expect(initialReviewProgressText({
      prUrl: "https://github.com/octo/repo/pull/42",
      requesterId: 123,
      requesterName: "Amogh <admin>",
    })).toBe([
      '⏳ Queued review for <a href="https://github.com/octo/repo/pull/42">octo/repo#42</a>',
      "<b>Status:</b> Starting",
      "Requested by Amogh &lt;admin&gt;",
    ].join("\n"));
  });

  it("edits one status message and mentions the requester on completion", async () => {
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const progress = new TelegramReviewProgress("bot-token", {
      chatId: -1001,
      messageId: 77,
      requesterId: 123,
      requesterName: "Amogh",
      prUrl: "https://github.com/octo/repo/pull/42",
    }, editMessage, 0);

    await progress.update("Analyzing changes", true);
    await progress.complete("octocat", 1);

    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(editMessage.mock.calls[0]?.[0]).toContain("Status:</b> Analyzing changes");
    expect(editMessage.mock.calls[1]?.[0]).toContain(
      '<a href="tg://user?id=123">Amogh</a>, your review is complete',
    );
  });
});
