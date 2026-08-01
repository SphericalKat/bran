import { describe, expect, it } from "vitest";
import {
  parsePullRequestUrl,
  parseReviewAction,
  privateTelegramUserId,
} from "../src/telegram/command-utils";

describe("command utilities", () => {
  it("parses a pull request URL without requiring a message", () => {
    expect(parsePullRequestUrl(" HTTPS://github.com/octo/repo/pull/42/ ")).toBe(
      "HTTPS://github.com/octo/repo/pull/42",
    );
    expect(parsePullRequestUrl("https://github.com/octo/repo/issues/42")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/octo/repo/pull/42 extra")).toBeNull();
  });

  it("parses a GitHub PR URL and preserves a multiline review message", () => {
    expect(parseReviewAction("  HTTPS://github.com/octo/repo/pull/42   First line\nSecond line  ")).toEqual({
      prUrl: "HTTPS://github.com/octo/repo/pull/42",
      message: "First line\nSecond line",
    });
  });

  it.each([
    "https://github.com/octo/repo/issues/42 message",
    "https://github.com/octo/repo/pull/42",
    "https://github.com/octo/repo/pull/nope message",
    "https://example.com/octo/repo/pull/42 message",
  ])("rejects an invalid action: %s", (value) => {
    expect(parseReviewAction(value)).toBeNull();
  });

  it("returns an ID only for a private chat belonging to the sender", () => {
    expect(privateTelegramUserId({ chatType: "private", chatId: 123, userId: 123 })).toBe("123");
    expect(privateTelegramUserId({ chatType: "group", chatId: 123, userId: 123 })).toBeNull();
    expect(privateTelegramUserId({ chatType: "private", chatId: 999, userId: 123 })).toBeNull();
    expect(privateTelegramUserId({ chatType: "private", chatId: 123 })).toBeNull();
  });
});
