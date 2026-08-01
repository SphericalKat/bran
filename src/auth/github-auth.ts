import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchCurrentUser,
  signOAuthState,
  verifyOAuthState,
  type AccessToken,
  type GitHubUser,
  type OAuthConfig,
} from "./github-oauth-client";
import type { GitHubAuthorization } from "./github-auth-store";
import type { AppEnv } from "../env";

const STATE_TTL_MS = 10 * 60 * 1_000;
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

export interface AuthStore {
  createAuthorizationNonce(userId: string, expiresAt: number): Promise<string>;
  consumeAuthorizationNonce(userId: string, nonce: string, now?: number): Promise<boolean>;
  storeAuthorization(userId: string, user: GitHubUser, token: AccessToken, now?: number): Promise<void>;
  getValidAuthorization(
    userId: string,
    refreshWindowMs: number,
    now?: number,
  ): Promise<GitHubAuthorization | null>;
  deleteAuthorization(userId: string): Promise<void>;
}

export type ConnectionResult =
  | { status: "connected"; telegramUserId: string; user: GitHubUser }
  | { status: "invalid_state" }
  | { status: "provider_error"; error: unknown };

export interface GitHubAuth {
  getConnectionUrl(telegramUserId: string): Promise<string>;
  connect(state: string, code: string): Promise<ConnectionResult>;
  getConnection(telegramUserId: string): Promise<GitHubAuthorization | null>;
  disconnect(telegramUserId: string): Promise<void>;
}

export interface GitHubAuthOptions {
  config: OAuthConfig;
  stateSecret: string;
  getStore: (telegramUserId: string) => AuthStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createGitHubAuth(env: AppEnv): GitHubAuth {
  return new GitHubAuthClient({
    config: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      redirectUri: env.GITHUB_CALLBACK_URL,
    },
    stateSecret: env.GITHUB_OAUTH_STATE_SECRET,
    getStore: (telegramUserId) => env.GITHUB_AUTH_STORE.getByName(telegramUserId),
  });
}

export class GitHubAuthClient implements GitHubAuth {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly options: GitHubAuthOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async getConnectionUrl(telegramUserId: string): Promise<string> {
    const expiresAt = this.now() + STATE_TTL_MS;
    const nonce = await this.options.getStore(telegramUserId)
      .createAuthorizationNonce(telegramUserId, expiresAt);
    const state = await signOAuthState(
      { telegramUserId, nonce, expiresAt },
      this.options.stateSecret,
    );
    return buildAuthorizationUrl({
      clientId: this.options.config.clientId,
      redirectUri: this.options.config.redirectUri,
      state,
    });
  }

  async connect(stateValue: string, code: string): Promise<ConnectionResult> {
    const state = await verifyOAuthState(stateValue, this.options.stateSecret, this.now());
    if (!state || !code) return { status: "invalid_state" };

    const store = this.options.getStore(state.telegramUserId);
    if (!await store.consumeAuthorizationNonce(state.telegramUserId, state.nonce, this.now())) {
      return { status: "invalid_state" };
    }

    try {
      const token = await exchangeAuthorizationCode(this.options.config, code, this.fetch);
      const user = await fetchCurrentUser(token.accessToken, this.fetch);
      await store.storeAuthorization(state.telegramUserId, user, token, this.now());
      return { status: "connected", telegramUserId: state.telegramUserId, user };
    } catch (error) {
      return { status: "provider_error", error };
    }
  }

  getConnection(telegramUserId: string): Promise<GitHubAuthorization | null> {
    return this.options.getStore(telegramUserId)
      .getValidAuthorization(telegramUserId, REFRESH_WINDOW_MS, this.now());
  }

  disconnect(telegramUserId: string): Promise<void> {
    return this.options.getStore(telegramUserId).deleteAuthorization(telegramUserId);
  }
}
