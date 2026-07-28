import {
  array,
  boolean,
  enum as enumType,
  number,
  object,
  string,
  type infer as Infer,
} from "zod";
import { ISSUE_FINGERPRINT_PATTERN } from "../issues/fingerprint.js";

const unknownBoolean = boolean().nullable();

export const triageAnalysisSchema = object({
  issueType: enumType([
    "bug",
    "enhancement",
    "documentation",
    "question",
    "unknown",
  ]),
  classificationConfidence: number().min(0).max(1),
  priorityConfidence: number().min(0).max(1),
  facts: object({
    environment: enumType(["production", "non-production", "unknown"]),
    productionImpact: enumType(["none", "degraded", "outage", "unknown"]),
    securityImpact: enumType(["none", "low", "high", "critical", "unknown"]),
    dataLoss: unknownBoolean,
    coreFlowBlocked: unknownBoolean,
    workaround: enumType(["available", "none", "unknown"]),
    affectedScope: enumType(["single", "limited", "many", "all", "unknown"]),
    slaRisk: unknownBoolean,
    releaseBlocker: unknownBoolean,
  }),
  duplicate: object({
    issueNumber: number().int().positive().nullable(),
    confidence: number().min(0).max(1),
    reason: string().max(2000),
  }),
  relatedIssues: array(
    object({
      issueNumber: number().int().positive(),
      reason: string().min(1).max(1000),
    }),
  ).max(10),
  missingInformation: array(string().min(1).max(1000)).max(10),
  priorityReason: string().min(1).max(2000),
});

export const triageSubmissionSchema = object({
  issueFingerprint: string().regex(ISSUE_FINGERPRINT_PATTERN),
  analysis: triageAnalysisSchema,
});

export type TriageAnalysis = Infer<typeof triageAnalysisSchema>;
export type TriageSubmission = Infer<typeof triageSubmissionSchema>;

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
