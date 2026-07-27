import crypto from "node:crypto";
import type { Issue, IssueComment } from "../issues/types.js";
import type { TriageDecision } from "./schema.js";

export const COMMENT_MARKER_PREFIX =
  "<!-- engineering-agent-workflows:issue-triage:v1";

export function issueFingerprint(
  issue: Pick<Issue, "title" | "body">,
  comments: Array<Pick<IssueComment, "id" | "body" | "user">> = [],
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        title: issue.title.trim(),
        body: issue.body ?? "",
        comments: comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          author: comment.user?.login ?? "",
        })),
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

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
