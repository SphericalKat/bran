import type { GitHub } from "../github";

export const GITHUB_CALLBACK_PATH = "/auth/github/callback";

export async function handleGitHubCallback(options: {
  request: Request;
  github: Pick<GitHub, "finishConnection">;
  notifyConnected: (telegramUserId: string, githubLogin: string) => Promise<void>;
}): Promise<Response> {
  if (options.request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(options.request.url);
  const result = await options.github.finishConnection(
    url.searchParams.get("state") ?? "",
    url.searchParams.get("code") ?? "",
  );

  if (result.status === "invalid_state") {
    return oauthHtml(
      "Authorization failed",
      "The authorization link is invalid, expired, or already used. Return to Telegram and run /connect again.",
      400,
    );
  }
  if (result.status === "provider_error") {
    console.error(JSON.stringify({
      event: "github_oauth_callback_failed",
      error: safeErrorMessage(result.error),
    }));
    return oauthHtml(
      "Authorization failed",
      "GitHub authorization could not be completed. Return to Telegram and run /connect again.",
      502,
    );
  }

  try {
    await options.notifyConnected(result.telegramUserId, result.githubLogin);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "github_oauth_notification_failed",
      error: safeErrorMessage(error),
    }));
  }
  return oauthHtml(
    "GitHub connected",
    `You are connected as @${result.githubLogin}. You can return to Telegram.`,
  );
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

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
