import { z } from "zod";

export const reviewFindingSourceSchema = z.enum(["review", "review_comment"]);

const reviewFindingReferenceSchema = z.object({
  source: reviewFindingSourceSchema,
  commentId: z.number().int().positive(),
});

const reviewTestSchema = z.object({
  command: z.string().min(1).max(300),
  status: z.enum(["passed", "failed", "not_run"]),
  details: z.string().max(1000),
});

export const reviewFixAnalysisSchema = z.object({
  outcome: z.enum(["fixed", "no_change", "needs_approval", "blocked"]),
  commitTitle: z.string().max(120),
  summary: z.array(z.string().min(1).max(500)).max(8),
  findings: z
    .array(
      z.object({
        source: reviewFindingSourceSchema,
        commentId: z.number().int().positive(),
        disposition: z.enum(["fixed", "not_reproducible", "needs_approval"]),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(100),
  tests: z.array(reviewTestSchema).max(20),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string().min(1).max(500)).max(8),
  }),
  notes: z.array(z.string().min(1).max(500)).max(8),
});

export const reviewFixSubmissionSchema = z.object({
  reviewId: z.number().int().positive(),
  reviewFingerprint: z.string().regex(/^[0-9a-f]{20}$/),
  findingRefs: z.array(reviewFindingReferenceSchema).min(1).max(100),
  workspacePath: z.string().min(1).max(2000),
  branch: z.string().min(1).max(250),
  baseBranch: z.string().min(1).max(250),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  previousReviewCursor: z.number().int().nonnegative(),
  previousIterations: z.number().int().nonnegative(),
  analysis: reviewFixAnalysisSchema,
});

export type ReviewFixAnalysis = z.infer<typeof reviewFixAnalysisSchema>;
export type ReviewFixSubmission = z.infer<typeof reviewFixSubmissionSchema>;
export type ReviewFindingSource = z.infer<typeof reviewFindingSourceSchema>;
