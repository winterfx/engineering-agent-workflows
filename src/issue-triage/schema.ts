import { z } from "zod";
import { ISSUE_FINGERPRINT_PATTERN } from "../issues/fingerprint.js";

const unknownBoolean = z.boolean().nullable();

export const triageAnalysisSchema = z.object({
  issueType: z.enum([
    "bug",
    "enhancement",
    "documentation",
    "question",
    "unknown",
  ]),
  classificationConfidence: z.number().min(0).max(1),
  priorityConfidence: z.number().min(0).max(1),
  facts: z.object({
    environment: z.enum(["production", "non-production", "unknown"]),
    productionImpact: z.enum(["none", "degraded", "outage", "unknown"]),
    securityImpact: z.enum(["none", "low", "high", "critical", "unknown"]),
    dataLoss: unknownBoolean,
    coreFlowBlocked: unknownBoolean,
    workaround: z.enum(["available", "none", "unknown"]),
    affectedScope: z.enum(["single", "limited", "many", "all", "unknown"]),
    slaRisk: unknownBoolean,
    releaseBlocker: unknownBoolean,
  }),
  duplicate: z.object({
    issueNumber: z.number().int().positive().nullable(),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(2000),
  }),
  relatedIssues: z
    .array(
      z.object({
        issueNumber: z.number().int().positive(),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(10),
  missingInformation: z.array(z.string().min(1).max(1000)).max(10),
  priorityReason: z.string().min(1).max(2000),
});

export const triageSubmissionSchema = z.object({
  issueFingerprint: z.string().regex(ISSUE_FINGERPRINT_PATTERN),
  analysis: triageAnalysisSchema,
});

export type TriageAnalysis = z.infer<typeof triageAnalysisSchema>;
export type TriageSubmission = z.infer<typeof triageSubmissionSchema>;

export type Priority = "P0" | "P1" | "P2" | "P3" | "pending";

export interface TriageDecision {
  analysis: TriageAnalysis;
  classification: {
    label: string | null;
    source: "existing" | "analysis" | "unknown" | "conflict";
  };
  priority: Priority;
  labels: string[];
  duplicateIssueNumber: number | null;
  relatedIssues: Array<{ issueNumber: number; reason: string }>;
}
