import { z } from "zod";

const unknownBoolean = z.boolean().nullable();

export const triageAnalysisSchema = z.object({
  normalizedTitle: z.string().min(1).max(180),
  summary: z.string().min(1).max(4000),
  issueType: z.enum(["bug", "enhancement", "question", "task"]),
  area: z.enum(["api", "cli", "runtime", "reliability", "docs", "general"]),
  classificationConfidence: z.number().min(0).max(1),
  titleConfidence: z.number().min(0).max(1),
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
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(10),
  missingInformation: z.array(z.string().min(1).max(1000)).max(10),
  priorityReason: z.string().min(1).max(2000),
});

export const triageSubmissionSchema = z.object({
  issueFingerprint: z.string().regex(/^[0-9a-f]{20}$/),
  analysis: triageAnalysisSchema,
});

export type TriageAnalysis = z.infer<typeof triageAnalysisSchema>;
export type TriageSubmission = z.infer<typeof triageSubmissionSchema>;

export type Priority = "P0" | "P1" | "P2" | "P3" | "pending";

export interface TriageDecision {
  analysis: TriageAnalysis;
  normalizedTitle: string;
  priority: Priority;
  labels: string[];
  duplicateIssueNumber: number | null;
  relatedIssues: Array<{ issueNumber: number; reason: string }>;
}
