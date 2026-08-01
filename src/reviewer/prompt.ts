import type { MrMetadata } from "./types";
import type { ReviewDiffMode } from "./review-diff";

export function buildPrReviewPrompt(options: {
  prUrl: string;
  targetBranch: string;
  mrMetadata: MrMetadata | null;
  embeddedDiff: string;
  previousReviewSha: string | null;
  reviewDiffMode: ReviewDiffMode;
  changedFiles: string[];
}): string {
  const metadata = options.mrMetadata;
  const notes = metadata?.Notes?.slice(-20).map((note) => note.body).filter(Boolean).join("\n---\n");
  return `# Code Review Task

Review ${options.prUrl} against ${options.targetBranch}.
Mode: ${options.reviewDiffMode}${options.previousReviewSha ? ` from ${options.previousReviewSha}` : ""}
Changed files: ${options.changedFiles.join(", ") || "none"}

## Pull request
Title: ${metadata?.title ?? ""}
Description: ${metadata?.description ?? ""}
Author: ${metadata?.author?.username ?? ""}
Labels: ${metadata?.labels?.map((label) => typeof label === "string" ? label : label.name).join(", ") ?? ""}

## Existing discussion
${notes || "No existing discussion."}

## Diff
\`\`\`diff
${options.embeddedDiff}
\`\`\`

Use read_file for bounded source context and search_code for directly relevant definitions or callers. Then call submit_review exactly once.`;
}
