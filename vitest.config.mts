import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				durableObjects: {
					GITHUB_AUTH_STORE: {
						className: "GitHubAuthStore",
						useSQLite: true,
					},
					REVIEWER_AGENT: {
						className: "ReviewerAgent",
						useSQLite: true,
					},
				},
			},
		}),
	],
});
