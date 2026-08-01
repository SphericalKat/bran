export interface ParsedReviewAction {
  prUrl: string;
  message: string;
}

export function parseReviewAction(value: string): ParsedReviewAction | null {
  const match = value.trim().match(
    /^(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)\s+([\s\S]+)$/i,
  );
  if (!match) return null;
  return { prUrl: match[1], message: match[2].trim() };
}

export function privateTelegramUserId(input: {
  chatType?: string;
  chatId?: number;
  userId?: number;
}): string | null {
  return input.userId !== undefined && input.chatType === "private" && input.chatId === input.userId
    ? String(input.userId)
    : null;
}
