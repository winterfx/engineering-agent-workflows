import { z } from "zod";

const ciCheckReferenceSchema = z.object({
  checkRunId: z.number().int().positive(),
});

export const ciFixAnalysisSchema = z.object({
  outcome: z.enum(["fixed", "no_change", "needs_approval", "blocked"]),
  commitTitle: z.string().max(120),
  summary: z.array(z.string().min(1).max(500)).max(8),
  failures: z
    .array(
      z.object({
        checkRunId: z.number().int().positive(),
        disposition: z.enum(["fixed", "not_reproducible", "needs_approval"]),
        reason: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(100),
  tests: z
    .array(
      z.object({
        command: z.string().min(1).max(300),
        status: z.enum(["passed", "failed", "not_run"]),
        details: z.string().max(1000),
      }),
    )
    .max(20),
  risk: z.object({
    level: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string().min(1).max(500)).max(8),
  }),
  notes: z.array(z.string().min(1).max(500)).max(8),
});

export const ciFixSubmissionSchema = z.object({
  checkSuiteId: z.number().int().positive(),
  failuresFingerprint: z.string().regex(/^[0-9a-f]{20}$/),
  checkRefs: z.array(ciCheckReferenceSchema).min(1).max(100),
  workspacePath: z.string().min(1).max(2000),
  branch: z.string().min(1).max(250),
  baseBranch: z.string().min(1).max(250),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  previousAttempts: z.number().int().nonnegative(),
  analysis: ciFixAnalysisSchema,
});

export type CiFixAnalysis = z.infer<typeof ciFixAnalysisSchema>;
export type CiFixSubmission = z.infer<typeof ciFixSubmissionSchema>;
