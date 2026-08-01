import { Agent } from "agents";
import { createOAuthNonce, type GitHubUser, type GitHubUserAccessToken } from "../auth/github";

export interface GitHubAuthorization {
  telegramUserId: string;
  githubUserId: number;
  githubLogin: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scope: string | null;
  updatedAt: number;
}

interface AuthorizationRow {
  telegram_user_id: string;
  github_user_id: number;
  github_login: string;
  access_token: string;
  refresh_token: string | null;
  access_token_expires_at: number | null;
  refresh_token_expires_at: number | null;
  scope: string | null;
  updated_at: number;
}

/**
 * Per-Telegram-user persistence. Credentials intentionally live only in this
 * Durable Object's SQLite database, never in Agent state (which is synced to
 * connected clients by the Agents SDK).
 */
export class ReviewerAgent extends Agent<Env> {
  private ensureAuthTables(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS github_authorizations (
        telegram_user_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        github_login TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        access_token_expires_at INTEGER,
        refresh_token_expires_at INTEGER,
        scope TEXT,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS github_oauth_nonces (
        telegram_user_id TEXT PRIMARY KEY,
        nonce_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `;
  }

  /** Stores (or replaces) a user's GitHub token pair and account identity. */
  storeGitHubAuthorization(
    telegramUserId: string,
    user: GitHubUser,
    token: GitHubUserAccessToken,
    now = Date.now(),
  ): void {
    requireTelegramUserId(telegramUserId);
    this.ensureAuthTables();
    this.sql`
      INSERT INTO github_authorizations (
        telegram_user_id, github_user_id, github_login, access_token,
        refresh_token, access_token_expires_at, refresh_token_expires_at,
        scope, updated_at
      ) VALUES (
        ${telegramUserId}, ${user.id}, ${user.login}, ${token.accessToken},
        ${token.refreshToken},
        ${toExpiryTimestamp(token.expiresIn, now)},
        ${toExpiryTimestamp(token.refreshTokenExpiresIn, now)},
        ${token.scope}, ${now}
      )
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        github_user_id = excluded.github_user_id,
        github_login = excluded.github_login,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `;
  }

  /** Returns the user's credentials for server-side GitHub calls only. */
  getGitHubAuthorization(telegramUserId: string): GitHubAuthorization | null {
    requireTelegramUserId(telegramUserId);
    this.ensureAuthTables();
    const row = this.sql<AuthorizationRow>`
      SELECT telegram_user_id, github_user_id, github_login, access_token,
        refresh_token, access_token_expires_at, refresh_token_expires_at,
        scope, updated_at
      FROM github_authorizations
      WHERE telegram_user_id = ${telegramUserId}
    `[0];
    return row ? authorizationFromRow(row) : null;
  }

  deleteGitHubAuthorization(telegramUserId: string): void {
    requireTelegramUserId(telegramUserId);
    this.ensureAuthTables();
    this.sql`DELETE FROM github_authorizations WHERE telegram_user_id = ${telegramUserId}`;
  }

  /** Creates a single active, short-lived nonce for a Telegram user. */
  async createOAuthNonce(
    telegramUserId: string,
    expiresAt: number,
  ): Promise<string> {
    requireTelegramUserId(telegramUserId);
    requireFutureExpiry(expiresAt);
    this.ensureAuthTables();
    const nonce = createOAuthNonce();
    const nonceHash = await hashNonce(nonce);
    this.sql`
      INSERT INTO github_oauth_nonces (telegram_user_id, nonce_hash, expires_at)
      VALUES (${telegramUserId}, ${nonceHash}, ${expiresAt})
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        nonce_hash = excluded.nonce_hash,
        expires_at = excluded.expires_at
    `;
    return nonce;
  }

  /** Atomically consumes a nonce after state verification. It cannot be reused. */
  async consumeOAuthNonce(
    telegramUserId: string,
    nonce: string,
    now = Date.now(),
  ): Promise<boolean> {
    requireTelegramUserId(telegramUserId);
    if (!nonce) return false;
    this.ensureAuthTables();
    const nonceHash = await hashNonce(nonce);
    const matching = this.sql<{ telegram_user_id: string }>`
      SELECT telegram_user_id
      FROM github_oauth_nonces
      WHERE telegram_user_id = ${telegramUserId}
        AND nonce_hash = ${nonceHash}
        AND expires_at >= ${now}
    `[0];
    if (!matching) {
      this.sql`DELETE FROM github_oauth_nonces WHERE expires_at < ${now}`;
      return false;
    }
    this.sql`DELETE FROM github_oauth_nonces WHERE telegram_user_id = ${telegramUserId}`;
    return true;
  }
}

function authorizationFromRow(row: AuthorizationRow): GitHubAuthorization {
  return {
    telegramUserId: row.telegram_user_id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

function toExpiryTimestamp(expiresInSeconds: number | null, now: number): number | null {
  if (expiresInSeconds === null) return null;
  return now + expiresInSeconds * 1_000;
}

function requireTelegramUserId(telegramUserId: string): void {
  if (!telegramUserId) throw new Error("Telegram user ID is required");
}

function requireFutureExpiry(expiresAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("OAuth nonce expiry must be in the future");
  }
}

async function hashNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
