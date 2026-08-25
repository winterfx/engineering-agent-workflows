import {
  array,
  enum as enumType,
  number,
  object,
  string,
  type infer as Infer,
} from "zod";
import { validationOverrideSchema } from "./schema.js";

export const reviewFindingSourceSchema = enumType(["review", "review_comment"]);

const reviewFindingReferenceSchema = object({
  source: reviewFindingSourceSchema,
  commentId: number().int().positive(),
});

const reviewTestSchema = object({
  command: string().min(1).max(300),
  status: enumType(["passed", "failed", "not_run"]),
  details: string().max(1000),
});

export const reviewFixAnalysisSchema = object({
  outcome: enumType(["fixed", "no_change", "needs_approval", "blocked"]),
  commitTitle: string().max(120),
  summary: array(string().min(1).max(500)).max(8),
  findings: array(
    object({
      source: reviewFindingSourceSchema,
      commentId: number().int().positive(),
      disposition: enumType(["fixed", "not_reproducible", "needs_approval"]),
      reason: string().min(1).max(1000),
    }),
  ).max(100),
  tests: array(reviewTestSchema).max(20),
  risk: object({
    level: enumType(["low", "medium", "high"]),
    reasons: array(string().min(1).max(500)).max(8),
  }),
  notes: array(string().min(1).max(500)).max(8),
  validationOverride: validationOverrideSchema.optional(),
});

export const reviewFixSubmissionSchema = object({
  reviewId: number().int().positive(),
  reviewFingerprint: string().regex(/^[0-9a-f]{20}$/),
  findingRefs: array(reviewFindingReferenceSchema).min(1).max(100),
  workspacePath: string().min(1).max(2000),
  branch: string().min(1).max(250),
  baseBranch: string().min(1).max(250),
  expectedHeadSha: string().regex(/^[0-9a-f]{40}$/),
  previousReviewCursor: number().int().nonnegative(),
  previousIterations: number().int().nonnegative(),
  findingFingerprint: string().regex(/^[0-9a-f]{20}$/),
  repeatedFindings: number().int().positive(),
  analysis: reviewFixAnalysisSchema,
});

export type ReviewFixAnalysis = Infer<typeof reviewFixAnalysisSchema>;
export type ReviewFixSubmission = Infer<typeof reviewFixSubmissionSchema>;
export type ReviewFindingSource = Infer<typeof reviewFindingSourceSchema>;
