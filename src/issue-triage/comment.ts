import { issueFingerprint } from "../issues/fingerprint.js";
import { ISSUE_TRIAGE_COMMENT_PREFIX } from "../issues/managed-comments.js";
import type { TriageDecision } from "./schema.js";

export const COMMENT_MARKER_PREFIX = ISSUE_TRIAGE_COMMENT_PREFIX;
export { issueFingerprint } from "../issues/fingerprint.js";

export function commentMarker(
  issueNumber: number,
  fingerprint: string,
): string {
  return `${COMMENT_MARKER_PREFIX} issue=${issueNumber} fingerprint=${fingerprint} -->`;
}

export function buildTriageComment(
  issueNumber: number,
  fingerprint: string,
  decision: TriageDecision,
): string {
  const analysis = decision.analysis;
  const lines = [
    commentMarker(issueNumber, fingerprint),
    "## Issue triage",
    "",
    "### Classification",
    "",
    `- Type: \`${classificationText(decision)}\``,
    `- Priority: \`${decision.priority}\``,
    `- Priority basis: ${analysis.priorityReason}`,
  ];

  if (decision.duplicateIssueNumber !== null) {
    lines.push(
      "",
      "### Possible duplicate",
      "",
      `- #${decision.duplicateIssueNumber}: ${analysis.duplicate.reason}`,
    );
  }

  if (decision.relatedIssues.length > 0) {
    lines.push("", "### Related issues", "");
    for (const related of decision.relatedIssues) {
      lines.push(`- #${related.issueNumber}: ${related.reason}`);
    }
  }

  if (analysis.missingInformation.length > 0) {
    lines.push("", "### Information needed", "");
    for (const missing of analysis.missingInformation) {
      lines.push(`- ${missing}`);
    }
  }

  lines.push(
    "",
    "### Maintainer next step",
    "",
    "- When this Issue is ready for implementation, a maintainer can add the `agent:ready` label. The Agent will open a Draft Pull Request and will not merge it automatically.",
    "- Add `skip-triage` to opt out of automated triage.",
    "",
    "_This is an automated initial assessment based on the Issue text and related candidates; no repository code was inspected._",
  );
  return lines.join("\n");
}

function classificationText(decision: TriageDecision): string {
  if (decision.classification.label) return decision.classification.label;
  return decision.classification.source === "conflict"
    ? "unresolved (conflicting existing labels)"
    : "unknown";
}
