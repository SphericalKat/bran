import type { NoteEntry } from "./types";

const REVIEW_SHA = /^\s*<!--\s*(?:fortagram|hodor):sha:([a-f0-9]{40})\s*-->/i;

export type ReviewDiffMode = "full" | "incremental";

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
  bytes: number;
}

export function latestReviewSha(notes: NoteEntry[] | undefined): string | null {
  if (!notes) return null;
  return [...notes]
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
    .map((note) => note.body?.match(REVIEW_SHA)?.[1])
    .find((sha): sha is string => Boolean(sha)) ?? null;
}

export function getDiffStats(diff: string): DiffStats {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { files, additions, deletions, bytes: new TextEncoder().encode(diff).byteLength };
}

export function getChangedFiles(diff: string): string[] {
  return [...new Set(
    [...diff.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].map((match) => match[2]),
  )];
}

const SKIP = [
  /(?:^|\/)testdata\//,
  /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/,
  /\.mdx?$/,
];

export function filterEmbeddedDiff(rawDiff: string): { filtered: string; skippedFiles: string[] } {
  const skippedFiles: string[] = [];
  const filtered = rawDiff.split(/(?=^diff --git )/m).filter((section) => {
    const path = section.match(/^diff --git a\/(.*?) b\//)?.[1];
    if (!path || !SKIP.some((pattern) => pattern.test(path))) return true;
    skippedFiles.push(path);
    return false;
  }).join("");
  return { filtered, skippedFiles };
}
