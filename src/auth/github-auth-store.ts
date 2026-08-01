import { DurableObject } from "cloudflare:workers";
import {
  createOAuthNonce,
  refreshAccessToken,
  type AccessToken,
  type GitHubUser,
} from "./github-oauth-client";
import type { AppEnv } from "../env";

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
  [key: string]: string | number | null;
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

/** Stores one Telegram user's GitHub authorization and OAuth nonce. */
export class GitHubAuthStore extends DurableObject<AppEnv> {
  private refreshInFlight: Promise<GitHubAuthorization | null> | null = null;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
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
      );
      CREATE TABLE IF NOT EXISTS github_oauth_nonces (
        telegram_user_id TEXT PRIMARY KEY,
        nonce_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  storeAuthorization(
    telegramUserId: string,
    user: GitHubUser,
    token: AccessToken,
    now = Date.now(),
  ): void {
    requireTelegramUserId(telegramUserId);
    this.ctx.storage.sql.exec(
      `INSERT INTO github_authorizations (
        telegram_user_id, github_user_id, github_login, access_token,
        refresh_token, access_token_expires_at, refresh_token_expires_at,
        scope, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        github_user_id = excluded.github_user_id,
        github_login = excluded.github_login,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_token_expires_at = excluded.access_token_expires_at,
        refresh_token_expires_at = excluded.refresh_token_expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at`,
      telegramUserId,
      user.id,
      user.login,
      token.accessToken,
      token.refreshToken,
      toExpiryTimestamp(token.expiresIn, now),
      toExpiryTimestamp(token.refreshTokenExpiresIn, now),
      token.scope,
      now,
    );
  }

  getAuthorization(telegramUserId: string): GitHubAuthorization | null {
    requireTelegramUserId(telegramUserId);
    const row = this.ctx.storage.sql.exec<AuthorizationRow>(
      `SELECT telegram_user_id, github_user_id, github_login, access_token,
        refresh_token, access_token_expires_at, refresh_token_expires_at,
        scope, updated_at
      FROM github_authorizations
      WHERE telegram_user_id = ?`,
      telegramUserId,
    ).toArray()[0];
    return row ? authorizationFromRow(row) : null;
  }

  async getValidAuthorization(
    telegramUserId: string,
    refreshWindowMs: number,
    now = Date.now(),
  ): Promise<GitHubAuthorization | null> {
    const authorization = this.getAuthorization(telegramUserId);
    if (!authorization) return null;
    if (
      authorization.accessTokenExpiresAt === null ||
      authorization.accessTokenExpiresAt > now + refreshWindowMs
    ) {
      return authorization;
    }
    if (
      !authorization.refreshToken ||
      (authorization.refreshTokenExpiresAt !== null && authorization.refreshTokenExpiresAt <= now)
    ) {
      this.deleteAuthorization(telegramUserId);
      return null;
    }

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshAuthorization(telegramUserId, authorization, now)
        .finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  deleteAuthorization(telegramUserId: string): void {
    requireTelegramUserId(telegramUserId);
    this.ctx.storage.sql.exec(
      "DELETE FROM github_authorizations WHERE telegram_user_id = ?",
      telegramUserId,
    );
  }

  private async refreshAuthorization(
    telegramUserId: string,
    authorization: GitHubAuthorization,
    now: number,
  ): Promise<GitHubAuthorization | null> {
    const refreshed = await refreshAccessToken(
      {
        clientId: this.env.GITHUB_APP_CLIENT_ID,
        clientSecret: this.env.GITHUB_APP_CLIENT_SECRET,
        redirectUri: this.env.GITHUB_CALLBACK_URL,
      },
      authorization.refreshToken!,
    );
    const mergedToken: AccessToken = {
      ...refreshed,
      scope: refreshed.scope ?? authorization.scope,
      refreshToken: refreshed.refreshToken ?? authorization.refreshToken,
      refreshTokenExpiresIn: refreshed.refreshToken
        ? refreshed.refreshTokenExpiresIn
        : remainingSeconds(authorization.refreshTokenExpiresAt, now),
    };
    this.storeAuthorization(
      telegramUserId,
      { id: authorization.githubUserId, login: authorization.githubLogin },
      mergedToken,
      now,
    );
    return this.getAuthorization(telegramUserId);
  }

  async createAuthorizationNonce(telegramUserId: string, expiresAt: number): Promise<string> {
    requireTelegramUserId(telegramUserId);
    requireFutureExpiry(expiresAt);
    const nonce = createOAuthNonce();
    const nonceHash = await hashNonce(nonce);
    this.ctx.storage.sql.exec(
      `INSERT INTO github_oauth_nonces (telegram_user_id, nonce_hash, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         nonce_hash = excluded.nonce_hash,
         expires_at = excluded.expires_at`,
      telegramUserId,
      nonceHash,
      expiresAt,
    );
    return nonce;
  }

  async consumeAuthorizationNonce(
    telegramUserId: string,
    nonce: string,
    now = Date.now(),
  ): Promise<boolean> {
    requireTelegramUserId(telegramUserId);
    if (!nonce) return false;
    const nonceHash = await hashNonce(nonce);
    const consumed = this.ctx.storage.sql.exec<{ telegram_user_id: string }>(
      `DELETE FROM github_oauth_nonces
       WHERE telegram_user_id = ? AND nonce_hash = ? AND expires_at >= ?
       RETURNING telegram_user_id`,
      telegramUserId,
      nonceHash,
      now,
    ).toArray()[0];
    if (!consumed) {
      this.ctx.storage.sql.exec("DELETE FROM github_oauth_nonces WHERE expires_at < ?", now);
    }
    return consumed !== undefined;
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
  return expiresInSeconds === null ? null : now + expiresInSeconds * 1_000;
}

function remainingSeconds(expiresAt: number | null, now: number): number | null {
  return expiresAt === null ? null : Math.max(0, Math.floor((expiresAt - now) / 1_000));
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
