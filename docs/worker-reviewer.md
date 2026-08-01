# Worker reviewer

Fortagram runs the Hodor review loop inside `ReviewerAgent`. It does not clone a repository or invoke `git`, `gh`, or a shell. The reviewer reads the pull request, diffs, prior reviews, and source files through GitHub's API using the connected user's OAuth token.

## Required bindings

Set these Worker secrets before deploying:

- `TELEGRAM_BOT_TOKEN`
- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_OAUTH_STATE_SECRET`
- `GITHUB_CALLBACK_URL`
- `LLM_API_KEY`

`REVIEW_MODEL` is optional. It defaults to `anthropic/claude-sonnet-4-5-20250929` and accepts a `provider/model-id` value supported by `pi-ai`.

The GitHub App must be able to read repository contents and pull requests and write pull-request reviews for every repository the bot should review.

## User flow

1. Send `/connect` to the Telegram bot and complete GitHub authorization.
2. Send `/review https://github.com/owner/repository/pull/123`.
3. Fortagram reviews the immutable pull-request head and posts the result as the connected GitHub user.

Manual `/comment`, `/approve`, and `/requestchanges` actions continue to use the same OAuth connection.
