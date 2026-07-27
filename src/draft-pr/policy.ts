import { z } from "zod";
import type { DraftPrAnalysis, DraftPrInspection } from "./schema.js";

export const draftPrPolicySchema = z.object({
  version: z.number().int().positive(),
  readyLabel: z.string().min(1),
  approvedLabel: z.string().min(1),
  runningLabel: z.string().min(1),
  needsApprovalLabel: z.string().min(1),
  prOpenLabel: z.string().min(1),
  failedLabel: z.string().min(1),
  skipLabels: z.array(z.string().min(1)),
  blockedLabels: z.array(z.string().min(1)),
  branchPrefix: z.string().regex(/^[a-zA-Z0-9._/-]+$/),
  maxChangedFiles: z.number().int().positive().max(1000),
  maxChangedLines: z.number().int().positive().max(100_000),
  maxReviewComments: z.number().int().positive().max(100),
  maxFixIterations: z.number().int().positive().max(20),
  approvalPathPrefixes: z.array(z.string().min(1)),
  labelColors: z.record(z.string(), z.string().regex(/^[0-9a-fA-F]{6}$/)),
});

export type DraftPrPolicy = z.infer<typeof draftPrPolicySchema>;

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
