import { z } from "zod";
import { ISSUE_FINGERPRINT_PATTERN } from "../issues/fingerprint.js";

export const draftPrAnalysisSchema = z.object({
  outcome: z.enum(["implemented", "needs_approval", "blocked", "no_change"]),
  prTitle: z.string().max(120),
  summary: z.array(z.string().min(1).max(500)).max(8),
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

export const draftPrSubmissionSchema = z.object({
  issueFingerprint: z.string().regex(ISSUE_FINGERPRINT_PATTERN),
  trigger: z.enum(["ready", "approved"]),
  workspacePath: z.string().min(1).max(2000),
  branch: z.string().min(1).max(250),
  baseBranch: z.string().min(1).max(250),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  analysis: draftPrAnalysisSchema,
});

export type DraftPrAnalysis = z.infer<typeof draftPrAnalysisSchema>;
export type DraftPrSubmission = z.infer<typeof draftPrSubmissionSchema>;

export interface DraftPrInspection {
  headCommit: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffCheckPassed: boolean;
  secretFindingPaths: string[];
}
