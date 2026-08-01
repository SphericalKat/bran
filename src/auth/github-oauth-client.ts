const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const textEncoder = new TextEncoder();

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface AuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  login?: string;
  allowSignup?: boolean;
}

export interface AccessToken {
  accessToken: string;
  tokenType: string;
  scope: string | null;
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url?: string;
  name?: string | null;
}

export interface OAuthStatePayload {
  telegramUserId: string;
  nonce: string;
  expiresAt: number;
}

export class GitHubOAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

/** Creates the GitHub OAuth authorization URL. */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  requireNonEmpty(options.clientId, "GitHub client ID");
  requireNonEmpty(options.redirectUri, "GitHub redirect URI");
  requireNonEmpty(options.state, "OAuth state");

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  if (options.scopes?.length) url.searchParams.set("scope", options.scopes.join(" "));
  if (options.login) url.searchParams.set("login", options.login);
  if (options.allowSignup !== undefined) {
    url.searchParams.set("allow_signup", String(options.allowSignup));
  }
  return url.toString();
}

/** Generates a URL-safe, cryptographically random OAuth nonce. */
export function createOAuthNonce(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error("OAuth nonce must contain at least 16 random bytes");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** HMAC-signs a short-lived state that binds the callback to a Telegram user. */
export async function signOAuthState(
  payload: OAuthStatePayload,
  secret: string,
): Promise<string> {
  validateStatePayload(payload);
  requireNonEmpty(secret, "OAuth state secret");

  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify({
    v: 1,
    u: payload.telegramUserId,
    n: payload.nonce,
    e: payload.expiresAt,
  })));
  const signature = await hmacSha256(secret, `v1.${encodedPayload}`);
  return `v1.${encodedPayload}.${base64UrlEncode(signature)}`;
}

/** Verifies an HMAC-signed state and rejects expired or malformed values. */
export async function verifyOAuthState(
  state: string,
  secret: string,
  now = Date.now(),
): Promise<OAuthStatePayload | null> {
  requireNonEmpty(secret, "OAuth state secret");
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;

  let signature: Uint8Array;
  let rawPayload: Uint8Array;
  try {
    rawPayload = base64UrlDecode(parts[1]);
    signature = base64UrlDecode(parts[2]);
  } catch {
    return null;
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secret),
      signature,
      textEncoder.encode(`v1.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawPayload));
  } catch {
    return null;
  }
  if (!isStatePayload(parsed) || parsed.v !== 1 || parsed.e <= now) return null;
  return {
    telegramUserId: parsed.u,
    nonce: parsed.n,
    expiresAt: parsed.e,
  };
}

/** Exchanges a GitHub OAuth callback code for an access token. */
export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AccessToken> {
  requireNonEmpty(code, "GitHub authorization code");
  return requestToken(config, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  }, fetchImpl);
}

/** Fetches the GitHub account for a user access token. */
export async function fetchCurrentUser(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GitHubUser> {
  requireNonEmpty(accessToken, "GitHub access token");
  const response = await fetchImpl(`${GITHUB_API_URL}/user`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "fortagram",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    throw new GitHubOAuthError("GitHub user request failed", response.status);
  }

  const user = await response.json() as unknown;
  if (!isGitHubUser(user)) {
    throw new GitHubOAuthError("GitHub returned an invalid user response");
  }
  return user;
}

async function requestToken(
  config: OAuthConfig,
  fields: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<AccessToken> {
  requireNonEmpty(config.clientId, "GitHub client ID");
  requireNonEmpty(config.clientSecret, "GitHub client secret");
  requireNonEmpty(config.redirectUri, "GitHub redirect URI");

  const response = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
  if (!response.ok) {
    throw new GitHubOAuthError("GitHub token request failed", response.status);
  }

  const body = await response.json() as unknown;
  if (!isTokenResponse(body)) {
    throw new GitHubOAuthError("GitHub returned an invalid token response");
  }
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "bearer",
    scope: body.scope ?? null,
  };
}

function requireNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required`);
}

function validateStatePayload(payload: OAuthStatePayload): void {
  requireNonEmpty(payload.telegramUserId, "Telegram user ID");
  requireNonEmpty(payload.nonce, "OAuth nonce");
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= 0) {
    throw new Error("OAuth state expiry must be a valid timestamp");
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    textEncoder.encode(value),
  );
  return new Uint8Array(signature);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function isStatePayload(value: unknown): value is { v: number; u: string; n: string; e: number } {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return payload.v === 1 && typeof payload.u === "string" && payload.u.length > 0 &&
    typeof payload.n === "string" && payload.n.length > 0 &&
    Number.isSafeInteger(payload.e) && (payload.e as number) > 0;
}

function isTokenResponse(value: unknown): value is {
  access_token: string;
  token_type?: string;
  scope?: string;
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.access_token === "string" && body.access_token.length > 0 &&
    (body.token_type === undefined || typeof body.token_type === "string") &&
    (body.scope === undefined || typeof body.scope === "string");
}

function isGitHubUser(value: unknown): value is GitHubUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "number" && Number.isSafeInteger(user.id) &&
    typeof user.login === "string" && user.login.length > 0;
}
