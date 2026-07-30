import {
  array,
  enum as enumType,
  object,
  string,
  type infer as Infer,
} from "zod";
import { ISSUE_FINGERPRINT_PATTERN } from "../issues/fingerprint.js";

export const draftPrAnalysisSchema = object({
  outcome: enumType(["implemented", "needs_approval", "blocked", "no_change"]),
  prTitle: string().max(120),
  summary: array(string().min(1).max(500)).max(8),
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
});

export const draftPrSubmissionSchema = object({
  issueFingerprint: string().regex(ISSUE_FINGERPRINT_PATTERN),
  trigger: enumType(["ready", "approved"]),
  workspacePath: string().min(1).max(2000),
  branch: string().min(1).max(250),
  baseBranch: string().min(1).max(250),
  baseCommit: string().regex(/^[0-9a-f]{40}$/),
  analysis: draftPrAnalysisSchema,
});

export type DraftPrAnalysis = Infer<typeof draftPrAnalysisSchema>;
export type DraftPrSubmission = Infer<typeof draftPrSubmissionSchema>;

export interface DraftPrInspection {
  headCommit: string;
  changeFingerprint: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffCheckPassed: boolean;
  secretFindingPaths: string[];
}
