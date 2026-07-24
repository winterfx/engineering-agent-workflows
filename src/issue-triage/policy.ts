import type { IssueCandidate } from "../github/types.js";
import type { Priority, TriageAnalysis, TriageDecision } from "./schema.js";

export interface TriagePolicy {
  version: number;
  duplicateConfidenceThreshold: number;
  titleConfidenceThreshold: number;
  classificationConfidenceThreshold: number;
  priorityConfidenceThreshold: number;
  maxCandidates: number;
  maxRelatedIssues: number;
  managedLabelPrefixes: string[];
  labelColors: Record<string, string>;
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
  const labels = [
    `priority:${priority}`,
    analysis.missingInformation.length > 0
      ? "triage:needs-info"
      : "triage:done",
  ];

  if (
    analysis.classificationConfidence >=
    policy.classificationConfidenceThreshold
  ) {
    labels.push(`area:${analysis.area}`, analysis.issueType);
  }
  if (duplicateIssueNumber !== null) {
    labels.push("duplicate");
  }

  return {
    analysis,
    normalizedTitle: sanitizeTitle(
      analysis.titleConfidence >= policy.titleConfidenceThreshold
        ? analysis.normalizedTitle
        : "",
    ),
    priority,
    labels: [...new Set(labels)],
    duplicateIssueNumber,
    relatedIssues,
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

function sanitizeTitle(title: string): string {
  return title
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
