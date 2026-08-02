import { describe, expect, it, vi } from "vitest";
import type { GitHub } from "../src/github";

describe("Telegram review failure", () => {
  it("acknowledges an update when the bot was kicked from the chat", async () => {
    const telegramFetch = vi.fn(async () => Response.json(
      {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was kicked from the group chat",
      },
      { status: 403 },
    ));
    const { handleTelegramWebhook } = await import("../src/telegram/bot");
    const request = new Request("https://bot.example/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: -42, type: "group", title: "Former group" },
          from: { id: 42, is_bot: false, first_name: "Kat" },
          text: "/start",
          entities: [{ offset: 0, length: 6, type: "bot_command" }],
        },
      }),
    });

    const response = await handleTelegramWebhook(request, {
      token: "token",
      github: {} as GitHub,
      fetch: telegramFetch as typeof globalThis.fetch,
      botInfo: { id: 1, is_bot: true, first_name: "Bran", username: "bran_bot" },
    });

    expect(response.status).toBe(200);
  });

  it("acknowledges an update when the review runner already reported its failure", async () => {
    let nextMessageId = 100;
    let edits = 0;
    const telegramFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = new URL(url).pathname.split("/").at(-1);
      if (method === "sendMessage") {
        return Response.json({
          ok: true,
          result: {
            message_id: nextMessageId++,
            date: 1,
            chat: { id: 42, type: "private" },
            text: "queued",
          },
        });
      }
      if (method === "editMessageText") {
        edits++;
        if (edits > 1) {
          return Response.json(
            { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
            { status: 400 },
          );
        }
        return Response.json({
          ok: true,
          result: { message_id: 100, date: 1, chat: { id: 42, type: "private" }, text: "failed" },
        });
      }
      throw new Error(`Unexpected Telegram method: ${method} ${init?.body ?? ""}`);
    });
    const { handleTelegramWebhook } = await import("../src/telegram/bot");
    const { TelegramReviewProgress } = await import("../src/telegram/review-progress");

    const github = {
      async reviewPullRequest(input: Parameters<GitHub["reviewPullRequest"]>[0]) {
        await new TelegramReviewProgress("token", input.progress!, async () => { edits++; }).failed(
          "GitHub API request failed (404 Not Found)",
        );
        return { status: "rejected", message: "GitHub API request failed (404 Not Found)" } as const;
      },
    } as GitHub;
    const request = new Request("https://bot.example/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 42, type: "private" },
          from: { id: 42, is_bot: false, first_name: "Kat" },
          text: "/review https://github.com/fortahealth/core-ui/pull/3104",
          entities: [{ offset: 0, length: 7, type: "bot_command" }],
        },
      }),
    });

    await expect(handleTelegramWebhook(request, {
      token: "token",
      github,
      fetch: telegramFetch as typeof globalThis.fetch,
      botInfo: { id: 1, is_bot: true, first_name: "Bran", username: "bran_bot" },
    })).resolves.toMatchObject({ status: 200 });
    expect(edits).toBe(1);
  });
});
