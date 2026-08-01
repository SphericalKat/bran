export const MAX_REVIEW_INSTRUCTIONS_BYTES = 128 * 1024;

const DEFAULT_INSTRUCTIONS = `# Review Judgment Profile

Identify production bugs introduced by the proposed change. Report only concrete, actionable issues that are likely to be fixed by the author.

A finding must be introduced by the reviewed delta and meaningfully affect correctness, performance, security, or maintainability. Do not report pre-existing issues, speculative breakage, intentional design choices, or cosmetic style concerns. Prefer no finding over a weak finding.

Write one concise finding per distinct issue. Explain the affected behavior and the conditions that trigger it. Pinpoint the smallest changed line range that makes the issue clear, and ensure every finding overlaps changed code.

Trace direct contracts affected by the delta. For routes, API parameters, authentication, database queries, schemas, cache keys, and public interfaces, follow externally supplied values through the layers they cross. Read only the adjacent definitions and callers needed to establish the contract.

When relevant, investigate race conditions, boundary errors, schema drift, authorization checks, partial-write safety, data loss, swallowed failures, and missing regression coverage.`;

export function validateReviewInstructions(content: string, source = "review instructions"): string {
  if (new TextEncoder().encode(content).byteLength > MAX_REVIEW_INSTRUCTIONS_BYTES) {
    throw new Error(`${source} exceeds the ${MAX_REVIEW_INSTRUCTIONS_BYTES}-byte size limit`);
  }
  if (!content.trim()) throw new Error(`${source} must not be empty`);
  return content;
}

export function loadDefaultReviewInstructions(): string {
  return DEFAULT_INSTRUCTIONS;
}
