import { array, number, object, record, string } from "zod";
import type { IssueCandidate } from "../issues/types.js";
import type { Priority, TriageAnalysis, TriageDecision } from "./schema.js";

export const triagePolicySchema = object({
  version: number().int().positive(),
  duplicateConfidenceThreshold: number().min(0).max(1),
  classificationConfidenceThreshold: number().min(0).max(1),
  priorityConfidenceThreshold: number().min(0).max(1),
  maxCandidates: number().int().min(0).max(100),
  maxRelatedIssues: number().int().min(0).max(20),
  skipLabels: array(string().min(1)),
  managedLabelPrefixes: array(string().min(1)),
  classificationLabels: object({
    bug: string().min(1),
    enhancement: string().min(1),
    documentation: string().min(1),
    question: string().min(1),
  }),
  labelColors: record(string(), string().regex(/^[0-9a-fA-F]{6}$/)),
  labelDescriptions: record(string(), string().min(1).max(100)),
});

export interface TriagePolicy {
  version: number;
  duplicateConfidenceThreshold: number;
  classificationConfidenceThreshold: number;
  priorityConfidenceThreshold: number;
  maxCandidates: number;
  maxRelatedIssues: number;
  skipLabels: string[];
  managedLabelPrefixes: string[];
  classificationLabels: {
    bug: string;
    enhancement: string;
    documentation: string;
    question: string;
  };
  labelColors: Record<string, string>;
  labelDescriptions: Record<string, string>;
}

export function calculatePriority(
  analysis: TriageAnalysis,
  policy: TriagePolicy,
): Priority {
  const { facts } = analysis;

  if (
    facts.securityImpact === "critical" ||
    facts.dataLoss === true ||
    (facts.environment === "production" && facts.productionImpact === "outage")
  ) {
    return "P0";
  }

  if (
    facts.securityImpact === "high" ||
    facts.releaseBlocker === true ||
    (facts.environment === "production" &&
      facts.coreFlowBlocked === true &&
      facts.workaround === "none")
  ) {
    return "P1";
  }

  if (analysis.priorityConfidence < policy.priorityConfidenceThreshold) {
    return "pending";
  }

  const lacksImpactEvidence =
    facts.productionImpact === "unknown" &&
    facts.affectedScope === "unknown" &&
    facts.slaRisk === null &&
    facts.releaseBlocker === null;
  if (lacksImpactEvidence) {
    return "pending";
  }

  if (
    facts.productionImpact === "degraded" ||
    facts.affectedScope === "many" ||
    facts.affectedScope === "all" ||
    facts.slaRisk === true ||
    facts.coreFlowBlocked === true
  ) {
    return "P2";
  }

  return "P3";
}

export function makeDecision(
  analysis: TriageAnalysis,
  candidates: IssueCandidate[],
  policy: TriagePolicy,
  existingLabels: string[] = [],
): TriageDecision {
  const candidateNumbers = new Set(
    candidates.map((candidate) => candidate.number),
  );
  const duplicate = analysis.duplicate;
  const duplicateIssueNumber =
    duplicate.issueNumber !== null &&
    duplicate.confidence >= policy.duplicateConfidenceThreshold &&
    candidateNumbers.has(duplicate.issueNumber)
      ? duplicate.issueNumber
      : null;

  const relatedIssues = analysis.relatedIssues
    .filter(
      (related) =>
        candidateNumbers.has(related.issueNumber) &&
        related.issueNumber !== duplicateIssueNumber,
    )
    .filter(
      (related, index, all) =>
        all.findIndex(
          (candidate) => candidate.issueNumber === related.issueNumber,
        ) === index,
    )
    .slice(0, policy.maxRelatedIssues);

  const priority = calculatePriority(analysis, policy);
  const classification = resolveClassification(
    analysis,
    existingLabels,
    policy,
  );
  const labels = [
    `priority:${priority}`,
    analysis.missingInformation.length > 0
      ? "triage:needs-info"
      : "triage:done",
  ];

  if (classification.source === "analysis" && classification.label) {
    labels.push(classification.label);
  }
  if (duplicateIssueNumber !== null) {
    labels.push("duplicate");
  }

  return {
    analysis,
    classification,
    priority,
    labels: [...new Set(labels)],
    duplicateIssueNumber,
    relatedIssues,
  };
}

function resolveClassification(
  analysis: TriageAnalysis,
  existingLabels: string[],
  policy: TriagePolicy,
): TriageDecision["classification"] {
  const configuredLabels = Object.values(policy.classificationLabels);
  const normalizedConfigured = new Map(
    configuredLabels.map((label) => [label.trim().toLowerCase(), label]),
  );
  const existingClassificationLabels = [
    ...new Set(
      existingLabels
        .map((label) => normalizedConfigured.get(label.trim().toLowerCase()))
        .filter((label): label is string => Boolean(label)),
    ),
  ];

  if (existingClassificationLabels.length === 1) {
    return { label: existingClassificationLabels[0]!, source: "existing" };
  }
  if (existingClassificationLabels.length > 1) {
    return { label: null, source: "conflict" };
  }
  if (
    analysis.issueType === "unknown" ||
    analysis.classificationConfidence < policy.classificationConfidenceThreshold
  ) {
    return { label: null, source: "unknown" };
  }
  return {
    label: policy.classificationLabels[analysis.issueType],
    source: "analysis",
  };
}

export function mergeManagedLabels(
  existing: string[],
  desired: string[],
  managedPrefixes: string[],
): string[] {
  const preserved = existing.filter(
    (label) => !managedPrefixes.some((prefix) => label.startsWith(prefix)),
  );
  return [...new Set([...preserved, ...desired])];
}
