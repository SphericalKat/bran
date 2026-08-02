# Hodor inline review research

Upstream inspected: [`mr-karan/hodor` at `e35234faef7aa28996245cef4e51b5afa508bc7f`](https://github.com/mr-karan/hodor/tree/e35234faef7aa28996245cef4e51b5afa508bc7f).

## Conclusion

Hodor does **not** publish inline comments on GitHub and does **not** choose between `COMMENT` and `REQUEST_CHANGES` there. Its GitHub publisher always invokes `gh pr review ... --comment --body <rendered review>`, so GitHub receives one summary review with the `COMMENT` event regardless of Hodor's correctness verdict ([publisher](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/publisher.ts#L68-L99)). The upstream documentation states this explicitly: “GitHub posting currently uses a summary PR comment” ([automated review docs](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/docs/AUTOMATED_REVIEWS.md#L112-L128)).

Hodor's inline publisher is GitLab-only. There are still useful pieces to copy for a GitHub implementation: its structured finding type, deterministic verdict correction, snippet-based line resolver, and per-finding publishing loop.

## Structured review types

Each `ReviewFinding` contains:

- `title` and `body`
- numeric priority `0 | 1 | 2 | 3`
- `code_location.absolute_file_path`
- an inclusive `code_location.line_range` with `start` and `end`
- optional `existing_code`, containing the exact source snippet used to repair model-produced line numbers
- optional `suggestion`, containing exact replacement text

The complete output contains `findings`, `overall_correctness` (`"patch is correct"` or `"patch is incorrect"`), and `overall_explanation` ([types](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/types.ts#L64-L80), [TypeBox schema](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review.ts#L12-L48)).

The system prompt tells the model to copy the exact contiguous source into `existing_code` and to provide `suggestion` only when it can supply the exact replacement for the flagged range ([system prompt](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/system-prompt.ts#L7-L30)).

Validation enforces absolute paths, ordered ranges, and matching `[P0]` through `[P3]` title/priority values. It also makes the verdict deterministic: any finding changes the verdict to `patch is incorrect`; no findings changes it to `patch is correct` ([validation](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/review.ts#L50-L90)). This gives a natural source for a GitHub review event, but Hodor itself never maps the verdict to `REQUEST_CHANGES`.

## Location resolution

Hodor does not trust the model's line numbers alone. After the agent submits its structured review, it runs `resolveReviewLocations` before returning the review ([agent integration](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/agent.ts#L706-L721)).

The resolver:

1. Normalizes `existing_code` and the checked-out file by trimming whitespace, dropping blank lines, and removing an accidental leading diff marker.
2. Finds all exact normalized snippet matches in the file.
3. Uses the sole match when unique.
4. For repeated snippets, prefers a match overlapping new-side lines in the unified diff, then the match closest to the model's proposed start line.
5. Corrects both `start` and `end` when a match is found.
6. Keeps the model's original range if the snippet is missing/unmatched or the file cannot be read. It also refuses to read outside the workspace and skips files over 2 MiB.

The matching and tie-breaking logic is in [`resolveLineRange`](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/resolve-location.ts#L36-L159); unified-diff new-side line parsing is in [`parseChangedLines`](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/resolve-location.ts#L161-L208); workspace-safe file resolution is in [`resolveReviewLocations`](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/resolve-location.ts#L210-L304).

Tests cover exact, corrected, ambiguous, diff-overlap, no-snippet, unreadable-file, outside-workspace, and path-traversal cases ([resolver tests](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/tests/resolve-location.test.ts)).

## What the inline publisher actually does

`postReviewStructured` immediately falls back to the summary publisher whenever the platform is not GitLab or the selected style is `summary` ([platform gate](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/publisher.ts#L131-L168)). Therefore GitHub never reaches the inline loop.

For GitLab, Hodor:

1. Fetches the merge request diff refs; if this fails it falls back to a summary.
2. Fingerprints each finding from its repo-relative path and normalized title, then avoids duplicating an already-open Hodor discussion.
3. Converts the absolute file path to a repo-relative path.
4. Builds a separate draft note for every finding.
5. Anchors the note at the resolved range's **start line only**.
6. If a replacement exists, adds a GitLab `suggestion` block whose span is derived from `end - start`.
7. Bulk-publishes the draft notes, then optionally posts a summary in `hybrid` mode.

The per-finding loop is in the [publisher](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/publisher.ts#L217-L308). `createGitlabDraftNote` builds a GitLab position using `base_sha`, `head_sha`, `start_sha`, the same old/new path, and `new_line`; it has no range fields ([GitLab API wrapper](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/gitlab.ts#L363-L408)). Thus Hodor preserves a range in its internal model, but the ordinary inline note is anchored to one line; the range is materially used for replacement suggestions.

## CLI options and defaults

- `--post` defaults to off.
- `--review-style` accepts `summary`, `inline`, or `hybrid`, defaults to `hybrid`, and is described as GitLab-specific.
- `--commit-status` defaults to off and is also GitLab-specific.
- `--fail-on-priority` controls the process exit code, not the GitHub review event.

The declarations and validation are in the [CLI options](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/cli.ts#L41-L85) and [option handling](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/cli.ts#L114-L165). At delivery time, structured publication is selected only when `platform === "gitlab" && reviewStyle !== "summary"`; all GitHub runs call the summary publisher ([CLI delivery branch](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/src/cli.ts#L372-L408)).

## Tests relevant to copying behavior

- Review schema tests verify optional `existing_code`, title/priority agreement, absolute paths, and ordered ranges ([review tests](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/tests/review.test.ts)).
- Resolver tests verify corrected ranges and safe fallback behavior ([resolver tests](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/tests/resolve-location.test.ts)).
- Publisher tests cover GitLab inline deduplication and discussion reconciliation, not GitHub inline comments or review event selection ([publisher tests](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/tests/publisher.test.ts)).
- The only GitHub publisher test checks that the model and metrics are appended to the single review body; it does not test inline comments or `REQUEST_CHANGES` ([agent publisher test](https://github.com/mr-karan/hodor/blob/e35234faef7aa28996245cef4e51b5afa508bc7f/tests/agent.test.ts#L208-L229)).

## Implication for Fortagram

Copy the structured finding contract and snippet-based range repair. Implement the GitHub publisher independently with GitHub's [create-review API](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request) so all findings can be submitted in one review with inline `comments`. Select `REQUEST_CHANGES` from an explicit blocking policy based on the normalized review output; Hodor provides no GitHub policy to copy. Its current all-findings-imply-incorrect rule may be too broad if Fortagram treats P2/P3 findings as non-blocking, so the event mapping should be a deliberate Fortagram rule rather than an accidental consequence of Hodor's verdict normalization.
