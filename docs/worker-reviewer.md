# Worker reviewer

Bran runs the Hodor review loop inside `ReviewerAgent`. It does not clone a repository or invoke `git`, `gh`, or a shell. The reviewer reads the pull request, diffs, prior reviews, and source files through GitHub's API using the connected user's OAuth or personal access token.

## Required bindings

Set these Worker secrets before deploying:

- `TELEGRAM_BOT_TOKEN`
- `LLM_API_KEY`

`REVIEW_MODEL` is the optional fallback for one model. It defaults to `anthropic/claude-sonnet-4-5-20250929`.

For ensemble reviews, set:

```dotenv
REVIEW_MODELS=purroxy-kimi/kimi-k3,purroxy-glm/glm-5.2,purroxy/vertex/gemini-3.6-flash,purroxy/openai/gpt-5.6-sol,purroxy-alibaba/qwen3.8-max
REVIEW_ORCHESTRATOR_MODEL=purroxy/openai/gpt-5.6-sol
REVIEW_MAX_CONCURRENCY=3
REVIEW_TIMEOUT_MS=600000
```

You can use a local Pi provider named `purroxy-<route>`. Bran maps this name to the matching Purroxy route.

Bran uses OpenAI-compatible completions for unknown routes. A known route can use a specialized API.

The default ensemble includes all five routes above. Bran ignores an unavailable reviewer when another reviewer succeeds.

Bran loads GitHub metadata and the diff once. All reviewers use the same immutable head SHA.

Bran runs a limited number of reviewers concurrently. Reviewer requests do not retry provider failures.

`REVIEW_TIMEOUT_MS` limits the complete task. The limit includes all reviewers and the orchestrator.

The orchestrator treats successful reviews as untrusted leads. It uses the same source and diff tools to verify each claim.

The orchestrator removes duplicate findings and merges supported findings. Bran publishes only this final review.

If the orchestrator fails, Bran uses the first successful review.

OAuth is optional. Enable `/connect` with `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_STATE_SECRET`, and `GITHUB_CALLBACK_URL`.

## User flow

1. In a private chat, use `/connect` for OAuth or `/token github_personal_access_token` to store a token directly. Bran deletes `/token` messages after reading them.
2. Send `/review https://github.com/owner/repository/pull/123`.
3. Bran edits one Telegram status message as the review moves through loading, analysis, repository inspection, and publishing.
4. Bran posts the result as the connected GitHub user and tags the requester in the completed status message.

`/review` can be sent from a group. GitHub authorization still happens privately, and the review always uses the requester's stored connection.

Manual `/comment`, `/approve`, and `/requestchanges` actions use the same stored connection.
