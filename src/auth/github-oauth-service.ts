import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubAuthorizationCode,
  fetchGitHubUser,
  signOAuthState,
  verifyOAuthState,
  type GitHubAppOAuthConfig,
  type GitHubUser,
  type GitHubUserAccessToken,
} from "./github-oauth-client";
import type { GitHubAuthorization } from "./github-auth-store";
import type { AppEnv } from "../env";

const STATE_TTL_MS = 10 * 60 * 1_000;
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

export interface GitHubAuthorizationStore {
  createAuthorizationNonce(userId: string, expiresAt: number): Promise<string>;
  consumeAuthorizationNonce(userId: string, nonce: string, now?: number): Promise<boolean>;
  storeAuthorization(userId: string, user: GitHubUser, token: GitHubUserAccessToken, now?: number): Promise<void>;
  getAuthorization(userId: string): Promise<GitHubAuthorization | null>;
  getValidAuthorization(
    userId: string,
    refreshWindowMs: number,
    now?: number,
  ): Promise<GitHubAuthorization | null>;
  deleteAuthorization(userId: string): Promise<void>;
}

export type OAuthCompletion =
  | { status: "connected"; telegramUserId: string; user: GitHubUser }
  | { status: "invalid_state" }
  | { status: "provider_error"; error: unknown };

export interface GitHubOAuthService {
  beginAuthorization(telegramUserId: string): Promise<string>;
  completeAuthorization(state: string, code: string): Promise<OAuthCompletion>;
  getAuthorization(telegramUserId: string): Promise<GitHubAuthorization | null>;
  disconnect(telegramUserId: string): Promise<void>;
}

export function createGitHubOAuthService(options: {
  config: GitHubAppOAuthConfig;
  stateSecret: string;
  storeForUser: (telegramUserId: string) => GitHubAuthorizationStore;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): GitHubOAuthService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  return {
    async beginAuthorization(telegramUserId) {
      const expiresAt = now() + STATE_TTL_MS;
      const nonce = await options.storeForUser(telegramUserId)
        .createAuthorizationNonce(telegramUserId, expiresAt);
      const state = await signOAuthState(
        { telegramUserId, nonce, expiresAt },
        options.stateSecret,
      );
      return buildGitHubAuthorizationUrl({
        clientId: options.config.clientId,
        redirectUri: options.config.redirectUri,
        state,
      });
    },

    async completeAuthorization(stateValue, code) {
      const state = await verifyOAuthState(stateValue, options.stateSecret, now());
      if (!state || !code) return { status: "invalid_state" };

      const store = options.storeForUser(state.telegramUserId);
      if (!await store.consumeAuthorizationNonce(state.telegramUserId, state.nonce, now())) {
        return { status: "invalid_state" };
      }

      try {
        const token = await exchangeGitHubAuthorizationCode(options.config, code, fetchImpl);
        const user = await fetchGitHubUser(token.accessToken, fetchImpl);
        await store.storeAuthorization(state.telegramUserId, user, token, now());
        return { status: "connected", telegramUserId: state.telegramUserId, user };
      } catch (error) {
        return { status: "provider_error", error };
      }
    },

    getAuthorization(telegramUserId) {
      return options.storeForUser(telegramUserId)
        .getValidAuthorization(telegramUserId, REFRESH_WINDOW_MS, now());
    },

    disconnect(telegramUserId) {
      return options.storeForUser(telegramUserId).deleteAuthorization(telegramUserId);
    },
  };
}

export function createGitHubOAuthServiceFromEnv(env: AppEnv): GitHubOAuthService {
  return createGitHubOAuthService({
    config: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      redirectUri: env.GITHUB_CALLBACK_URL,
    },
    stateSecret: env.GITHUB_OAUTH_STATE_SECRET,
    storeForUser: (telegramUserId) => env.GITHUB_AUTH_STORE.getByName(telegramUserId),
  });
}

