import type { GitHubAuthStore } from "./auth/github-auth-store";

export interface RuntimeSecrets {
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_OAUTH_STATE_SECRET: string;
  GITHUB_CALLBACK_URL: string;
}

export type AppEnv = Cloudflare.Env & RuntimeSecrets & {
  GITHUB_AUTH_STORE: DurableObjectNamespace<GitHubAuthStore>;
};
