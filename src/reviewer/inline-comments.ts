import type { GitHubReviewComment } from "./github-api";
import type { ReviewFinding, ReviewOutput } from "./types";

interface DiffHunk {
  path: string;
  start: number;
  end: number;
  additions: Set<number>;
}

export function buildInlineComments(
  review: ReviewOutput,
  diff: string,
): { comments: GitHubReviewComment[]; skipped: ReviewFinding[] } {
  const hunks = parseRightSideHunks(diff);
  const comments: GitHubReviewComment[] = [];
  const skipped: ReviewFinding[] = [];

  for (const finding of review.findings) {
    const path = finding.code_location.path;
    const requested = finding.code_location.line_range;
    const hunk = hunks.find((candidate) =>
      candidate.path === path
      && candidate.end >= requested.start
      && candidate.start <= requested.end
      && [...candidate.additions].some((line) => line >= requested.start && line <= requested.end)
    );
    if (!hunk) {
      skipped.push(finding);
      continue;
    }

    const startLine = Math.max(requested.start, hunk.start);
    const line = Math.min(requested.end, hunk.end);
    comments.push({
      path,
      body: renderInlineFinding(finding),
      line,
      side: "RIGHT",
      ...(startLine < line ? { startLine, startSide: "RIGHT" as const } : {}),
    });
  }

  return { comments, skipped };
}

function parseRightSideHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  let hunk: DiffHunk | null = null;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const file = line.match(/^\+\+\+ b\/(.+)$/);
    if (file) {
      path = file[1];
      hunk = null;
      continue;
    }
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header && path) {
      newLine = Number(header[1]);
      hunk = { path, start: newLine, end: newLine - 1, additions: new Set() };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.additions.add(newLine);
      hunk.end = newLine++;
    } else if (line.startsWith(" ")) {
      hunk.end = newLine++;
    }
  }

  return hunks;
}

function renderInlineFinding(finding: ReviewFinding): string {
  let body = `**${finding.title}**\n\n${finding.body}`;
  if (finding.suggestion) body += `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  return body;
}
