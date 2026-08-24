import {
  array,
  enum as enumType,
  number,
  object,
  record,
  string,
  type infer as Infer,
} from "zod";
import type { DraftPrAnalysis, DraftPrInspection } from "./schema.js";

export const draftPrPolicySchema = object({
  version: number().int().positive(),
  readyLabel: string().min(1),
  approvedLabel: string().min(1),
  runningLabel: string().min(1),
  needsApprovalLabel: string().min(1),
  prOpenLabel: string().min(1),
  failedLabel: string().min(1),
  skipLabels: array(string().min(1)),
  blockedLabels: array(string().min(1)),
  branchPrefix: string().regex(/^[a-zA-Z0-9._/-]+$/),
  maxChangedFiles: number().int().positive().max(1000),
  maxChangedLines: number().int().positive().max(100_000),
  maxReviewComments: number().int().positive().max(100),
  maxValidationFixIterations: number().int().positive().max(20),
  maxFixIterations: number().int().positive().max(20),
  requiredValidationGates: array(
    enumType(["task-prepare", "task-lint", "task-test-unit"]),
  ).min(1),
  allowedValidationFailureCases: array(string().min(1).max(300)).max(50),
  approvalPathPrefixes: array(string().min(1)),
  trustedReviewBotLogins: array(string().min(1)),
  labelColors: record(string(), string().regex(/^[0-9a-fA-F]{6}$/)),
});

export type DraftPrPolicy = Infer<typeof draftPrPolicySchema>;

export function requiresApproval(
  analysis: Pick<DraftPrAnalysis, "risk">,
  inspection: DraftPrInspection,
  approved: boolean,
  policy: DraftPrPolicy,
): string[] {
  if (approved) return [];

  const reasons: string[] = [];
  if (analysis.risk.level === "high") {
    reasons.push("the implementation reports high risk");
  }
  if (inspection.changedFiles.length > policy.maxChangedFiles) {
    reasons.push(
      `the change touches ${inspection.changedFiles.length} files (limit ${policy.maxChangedFiles})`,
    );
  }
  const changedLines = inspection.additions + inspection.deletions;
  if (changedLines > policy.maxChangedLines) {
    reasons.push(
      `the change modifies ${changedLines} lines (limit ${policy.maxChangedLines})`,
    );
  }
  const sensitivePaths = inspection.changedFiles.filter((file) =>
    policy.approvalPathPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (sensitivePaths.length > 0) {
    reasons.push(
      `the change touches approval-gated paths: ${sensitivePaths.slice(0, 5).join(", ")}`,
    );
  }
  return reasons;
}

export function hasLabel(labels: string[], expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  return labels.some((label) => label.trim().toLowerCase() === normalized);
}

export function hasAnyLabel(labels: string[], expected: string[]): boolean {
  return expected.some((label) => hasLabel(labels, label));
}

export function isTrustedReviewBot(
  login: string,
  policy: Pick<DraftPrPolicy, "trustedReviewBotLogins">,
): boolean {
  const normalized = login.trim().toLowerCase();
  if (!normalized) return false;
  return policy.trustedReviewBotLogins.some(
    (value) => value.trim().toLowerCase() === normalized,
  );
}
