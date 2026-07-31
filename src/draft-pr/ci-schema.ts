import {
  array,
  enum as enumType,
  number,
  object,
  string,
  type infer as Infer,
} from "zod";
import { validationOverrideSchema } from "./schema.js";

const ciCheckReferenceSchema = object({
  checkRunId: number().int().positive(),
});

export const ciFixAnalysisSchema = object({
  outcome: enumType(["fixed", "no_change", "needs_approval", "blocked"]),
  commitTitle: string().max(120),
  summary: array(string().min(1).max(500)).max(8),
  failures: array(
    object({
      checkRunId: number().int().positive(),
      disposition: enumType(["fixed", "not_reproducible", "needs_approval"]),
      reason: string().min(1).max(1000),
    }),
  )
    .min(1)
    .max(100),
  tests: array(
    object({
      command: string().min(1).max(300),
      status: enumType(["passed", "failed", "not_run"]),
      details: string().max(1000),
    }),
  ).max(20),
  risk: object({
    level: enumType(["low", "medium", "high"]),
    reasons: array(string().min(1).max(500)).max(8),
  }),
  notes: array(string().min(1).max(500)).max(8),
  validationOverride: validationOverrideSchema.optional(),
});

export const ciFixSubmissionSchema = object({
  checkSuiteId: number().int().positive(),
  failuresFingerprint: string().regex(/^[0-9a-f]{20}$/),
  checkRefs: array(ciCheckReferenceSchema).min(1).max(100),
  workspacePath: string().min(1).max(2000),
  branch: string().min(1).max(250),
  baseBranch: string().min(1).max(250),
  expectedHeadSha: string().regex(/^[0-9a-f]{40}$/),
  previousAttempts: number().int().nonnegative(),
  analysis: ciFixAnalysisSchema,
});

export type CiFixAnalysis = Infer<typeof ciFixAnalysisSchema>;
export type CiFixSubmission = Infer<typeof ciFixSubmissionSchema>;
