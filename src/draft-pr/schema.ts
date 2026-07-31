import {
  array,
  enum as enumType,
  object,
  string,
  type infer as Infer,
} from "zod";
import { ISSUE_FINGERPRINT_PATTERN } from "../issues/fingerprint.js";

export const validationOverrideSchema = object({
  classification: enumType(["allowlisted_test_failure"]),
  source: enumType(["policy"]),
  reason: string().min(1).max(1000),
  failedCommands: array(string().min(1).max(300)).min(1).max(20),
  allowedFailureCases: array(string().min(1).max(300)).min(1).max(50),
});

interface ValidationOverrideAnalysis {
  tests: Array<{ command: string; status: "passed" | "failed" | "not_run" }>;
  validationOverride?: Infer<typeof validationOverrideSchema> | undefined;
}

export function hasConsistentValidationOverride(
  analysis: ValidationOverrideAnalysis,
): boolean {
  const override = analysis.validationOverride;
  if (!override) return false;
  const failedCommands = [
    ...new Set(
      analysis.tests
        .filter((test) => test.status === "failed")
        .map((test) => test.command),
    ),
  ];
  const overrideCommands = [...new Set(override.failedCommands)];
  return (
    failedCommands.length > 0 &&
    failedCommands.length === overrideCommands.length &&
    failedCommands.every((command) => overrideCommands.includes(command))
  );
}

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
  validationOverride: validationOverrideSchema.optional(),
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
