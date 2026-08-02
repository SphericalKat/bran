# Worker reviewer

Bran runs the Hodor review loop inside `ReviewerAgent`. It does not clone a repository or invoke `git`, `gh`, or a shell. The reviewer reads the pull request, diffs, prior reviews, and source files through GitHub's API using the connected user's OAuth or personal access token.

## Required bindings

Set these Worker secrets before deploying:

- `TELEGRAM_BOT_TOKEN`
- `LLM_API_KEY`

`REVIEW_MODEL` is optional. It defaults to `anthropic/claude-sonnet-4-5-20250929` and accepts a `provider/model-id` value supported by `pi-ai`.

OAuth is optional. Enable `/connect` with `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_STATE_SECRET`, and `GITHUB_CALLBACK_URL`.

## User flow

1. In a private chat, use `/connect` for OAuth or `/token github_personal_access_token` to store a token directly. Bran deletes `/token` messages after reading them.
2. Send `/review https://github.com/owner/repository/pull/123`.
3. Bran edits one Telegram status message as the review moves through loading, analysis, repository inspection, and publishing.
4. Bran posts the result as the connected GitHub user and tags the requester in the completed status message.

`/review` can be sent from a group. GitHub authorization still happens privately, and the review always uses the requester's stored connection.

Manual `/comment`, `/approve`, and `/requestchanges` actions use the same stored connection.
