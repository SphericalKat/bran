import type { GitHubAuthStore } from "./auth/github-auth-store";
import type { ReviewerAgent } from "./agent/ReviewerAgent";

export interface RuntimeSecrets {
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_STATE_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  LLM_API_KEY: string;
  REVIEW_MODEL?: string;
  REVIEW_MODELS?: string;
  REVIEW_ORCHESTRATOR_MODEL?: string;
  REVIEW_MAX_CONCURRENCY?: string;
  REVIEW_TIMEOUT_MS?: string;
}

export type AppEnv = Cloudflare.Env & RuntimeSecrets & {
  GITHUB_AUTH_STORE: DurableObjectNamespace<GitHubAuthStore>;
  REVIEWER_AGENT: DurableObjectNamespace<ReviewerAgent>;
};
