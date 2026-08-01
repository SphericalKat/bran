import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
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
			},
		},
	},
});
