import { Type } from "@earendil-works/pi-ai";
import type { ReviewOutput, ReviewPriority } from "./types";

const LOCATION_SCHEMA = Type.Object({
  path: Type.String({ minLength: 1 }),
  line_range: Type.Object({
    start: Type.Integer({ minimum: 1 }),
    end: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const FINDING_SCHEMA = Type.Object({
  title: Type.String({ minLength: 1 }),
  body: Type.String({ minLength: 1 }),
  priority: Type.Integer({ minimum: 0, maximum: 3 }),
  code_location: LOCATION_SCHEMA,
  existing_code: Type.Optional(Type.String({ minLength: 1 })),
  suggestion: Type.Optional(Type.String({
    minLength: 1,
    description: "Exact replacement source code for the full line range. No instructions, explanations, or Markdown fences.",
  })),
}, { additionalProperties: false });

export const SUBMIT_REVIEW_SCHEMA = Type.Object({
  findings: Type.Array(FINDING_SCHEMA),
  overall_correctness: Type.Union([
    Type.Literal("patch is correct"),
    Type.Literal("patch is incorrect"),
  ]),
  overall_explanation: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function validateReviewOutput(value: unknown): ReviewOutput {
  if (!value || typeof value !== "object") throw new Error("Review must be an object");
  const review = value as ReviewOutput;
  if (!Array.isArray(review.findings)) throw new Error("Review findings must be an array");
  if (typeof review.overall_explanation !== "string" || !review.overall_explanation.trim()) {
    throw new Error("Review explanation must not be empty");
  }

  for (const [index, finding] of review.findings.entries()) {
    const label = `Finding ${index + 1}`;
    if (!finding || typeof finding !== "object") throw new Error(`${label} must be an object`);
    if (typeof finding.title !== "string" || typeof finding.body !== "string") {
      throw new Error(`${label} title and body must be strings`);
    }
    const priority = priorityFromTitle(finding.title);
    if (priority === null || finding.priority !== priority) {
      throw new Error(`${label} title and priority must use the same P0-P3 value`);
    }
    const location = finding.code_location;
    if (!location || !isRepositoryPath(location.path)) {
      throw new Error(`${label} must use a repository-relative path`);
    }
    if (!Number.isSafeInteger(location.line_range?.start) ||
      !Number.isSafeInteger(location.line_range?.end) ||
      location.line_range.start < 1 || location.line_range.start > location.line_range.end) {
      throw new Error(`${label} has an invalid line range`);
    }
  }

  return {
    ...review,
    overall_correctness: review.findings.length === 0
      ? "patch is correct"
      : "patch is incorrect",
  };
}

function priorityFromTitle(title: string): ReviewPriority | null {
  const match = title.match(/^\[P([0-3])\]/);
  return match ? Number(match[1]) as ReviewPriority : null;
}

function isRepositoryPath(path: string): boolean {
  if (!path || path !== path.trim() || path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
