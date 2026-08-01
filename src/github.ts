import type { AppEnv } from "./env";
import type { GitHubAuthorization } from "./auth/github-auth-store";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchCurrentUser,
  signOAuthState,
  verifyOAuthState,
  type AccessToken,
  type GitHubUser,
} from "./auth/github-oauth-client";
import type { GitHubReviewEvent } from "./reviewer/github-api";
import type { ReviewResult as GeneratedReview } from "./reviewer/agent";
import { postReviewComment } from "./reviewer/publisher";
import type { TelegramReviewProgressTarget } from "./telegram/review-progress";

const STATE_TTL_MS = 10 * 60 * 1_000;
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

interface AuthStore {
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

type ConnectionResult =
  | { status: "connected"; telegramUserId: string; githubLogin: string }
  | { status: "invalid_state" }
  | { status: "provider_error"; error: unknown };

export type ReviewResult =
  | { status: "not_connected" }
  | { status: "posted"; githubLogin: string }
  | { status: "rejected"; message: string };

export type AutomatedReviewResult =
  | { status: "not_connected" }
  | { status: "posted"; githubLogin: string; findings: number }
  | { status: "rejected"; message: string };

type ReviewRunner = (input: {
  telegramUserId: string;
  prUrl: string;
  githubToken: string;
  githubLogin: string;
  progress?: TelegramReviewProgressTarget;
}) => Promise<GeneratedReview>;

interface Dependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  publish?: typeof postReviewComment;
  runReview?: ReviewRunner;
  getStore?: (telegramUserId: string) => AuthStore;
}

export class GitHub {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly publish: typeof postReviewComment;
  private readonly runReview: ReviewRunner;
  private readonly getStore: (telegramUserId: string) => AuthStore;

  constructor(private readonly env: AppEnv, dependencies: Dependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.publish = dependencies.publish ?? postReviewComment;
    this.runReview = dependencies.runReview ?? ((input) =>
      env.REVIEWER_AGENT.getByName(input.telegramUserId).runCodeReview({
        prUrl: input.prUrl,
        githubToken: input.githubToken,
        githubLogin: input.githubLogin,
        progress: input.progress,
      }));
    this.getStore = dependencies.getStore ?? ((userId) => env.GITHUB_AUTH_STORE.getByName(userId));
  }

  async connectionUrl(telegramUserId: string): Promise<string> {
    const expiresAt = this.now() + STATE_TTL_MS;
    const nonce = await this.getStore(telegramUserId)
      .createAuthorizationNonce(telegramUserId, expiresAt);
    const state = await signOAuthState(
      { telegramUserId, nonce, expiresAt },
      this.env.GITHUB_OAUTH_STATE_SECRET,
    );
    return buildAuthorizationUrl({
      clientId: this.env.GITHUB_APP_CLIENT_ID,
      redirectUri: this.env.GITHUB_CALLBACK_URL,
      state,
    });
  }

  async finishConnection(stateValue: string, code: string): Promise<ConnectionResult> {
    const state = await verifyOAuthState(
      stateValue,
      this.env.GITHUB_OAUTH_STATE_SECRET,
      this.now(),
    );
    if (!state || !code) return { status: "invalid_state" };

    const store = this.getStore(state.telegramUserId);
    if (!await store.consumeAuthorizationNonce(state.telegramUserId, state.nonce, this.now())) {
      return { status: "invalid_state" };
    }

    try {
      const token = await exchangeAuthorizationCode(this.oauthConfig(), code, this.fetch);
      const user = await fetchCurrentUser(token.accessToken, this.fetch);
      await store.storeAuthorization(state.telegramUserId, user, token, this.now());
      return {
        status: "connected",
        telegramUserId: state.telegramUserId,
        githubLogin: user.login,
      };
    } catch (error) {
      return { status: "provider_error", error };
    }
  }

  async connectedLogin(telegramUserId: string): Promise<string | null> {
    return (await this.connection(telegramUserId))?.githubLogin ?? null;
  }

  disconnect(telegramUserId: string): Promise<void> {
    return this.getStore(telegramUserId).deleteAuthorization(telegramUserId);
  }

  async review(input: {
    telegramUserId: string;
    prUrl: string;
    message: string;
    event: GitHubReviewEvent;
  }): Promise<ReviewResult> {
    const connection = await this.connection(input.telegramUserId);
    if (!connection) return { status: "not_connected" };

    const result = await this.publish({
      prUrl: input.prUrl,
      reviewText: input.message,
      githubToken: connection.accessToken,
      event: input.event,
    });
    return result.success
      ? { status: "posted", githubLogin: connection.githubLogin }
      : { status: "rejected", message: result.error ?? "Unknown error" };
  }

  async reviewPullRequest(input: {
    telegramUserId: string;
    prUrl: string;
    progress?: TelegramReviewProgressTarget;
  }): Promise<AutomatedReviewResult> {
    const connection = await this.connection(input.telegramUserId);
    if (!connection) return { status: "not_connected" };

    try {
      const generated = await this.runReview({
        telegramUserId: input.telegramUserId,
        prUrl: input.prUrl,
        githubToken: connection.accessToken,
        githubLogin: connection.githubLogin,
        progress: input.progress,
      });
      return {
        status: "posted",
        githubLogin: connection.githubLogin,
        findings: generated.review.findings.length,
      };
    } catch (error) {
      return {
        status: "rejected",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private connection(telegramUserId: string): Promise<GitHubAuthorization | null> {
    return this.getStore(telegramUserId)
      .getValidAuthorization(telegramUserId, REFRESH_WINDOW_MS, this.now());
  }

  private oauthConfig() {
    return {
      clientId: this.env.GITHUB_APP_CLIENT_ID,
      clientSecret: this.env.GITHUB_APP_CLIENT_SECRET,
      redirectUri: this.env.GITHUB_CALLBACK_URL,
    };
  }
}
