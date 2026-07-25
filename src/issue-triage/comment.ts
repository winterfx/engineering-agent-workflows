import crypto from "node:crypto";
import type { GitHubComment, GitHubIssue } from "../github/types.js";
import type { TriageDecision } from "./schema.js";

export const COMMENT_MARKER_PREFIX =
  "<!-- engineering-agent-workflows:issue-triage:v1";

export function issueFingerprint(
  issue: Pick<GitHubIssue, "title" | "body">,
  comments: Array<Pick<GitHubComment, "id" | "body" | "user">> = [],
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
    analysis.summary,
    "",
    "### Classification",
    "",
    `- Type: \`${analysis.issueType}\``,
    `- Area: \`${analysis.area}\``,
    `- Priority: \`${decision.priority}\``,
    `- Priority basis: ${analysis.priorityReason}`,
  ];

  if (decision.duplicateIssueNumber !== null) {
    lines.push(
      "",
      "### Possible duplicate",
      "",
      `- #${decision.duplicateIssueNumber} (${Math.round(analysis.duplicate.confidence * 100)}% confidence): ${analysis.duplicate.reason}`,
    );
  }

  if (decision.relatedIssues.length > 0) {
    lines.push("", "### Related issues", "");
    for (const related of decision.relatedIssues) {
      lines.push(`- #${related.issueNumber}: ${related.reason}`);
    }
  }

  if (analysis.acceptanceCriteria.length > 0) {
    lines.push("", "### Suggested acceptance criteria", "");
    for (const criterion of analysis.acceptanceCriteria) {
      lines.push(`- [ ] ${criterion}`);
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
