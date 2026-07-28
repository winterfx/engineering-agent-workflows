import type { IssueComment } from "../issues/types.js";

export const DRAFT_PR_COMMENT_PREFIX =
  "<!-- engineering-agent-workflows:draft-pr:v1";

export function draftPrCommentMarker(issueNumber: number): string {
  return `${DRAFT_PR_COMMENT_PREFIX} issue=${issueNumber} -->`;
}

export function findDraftPrComment(
  comments: IssueComment[],
  botLogin: string,
): IssueComment | undefined {
  const expected = botLogin.trim().toLowerCase();
  return comments.find(
    (comment) =>
      comment.user?.login.trim().toLowerCase() === expected &&
      comment.body.startsWith(DRAFT_PR_COMMENT_PREFIX),
  );
}

export function buildDraftPrStatusComment(
  issueNumber: number,
  status: "running" | "needs-approval" | "pr-open" | "failed" | "dry-run",
  details: {
    pullRequestUrl?: string;
    reasons?: string[];
    message?: string;
  } = {},
): string {
  const lines = [draftPrCommentMarker(issueNumber), "## Draft PR agent", ""];
  if (status === "running") {
    lines.push("The repository development Agent has claimed this Issue.");
  } else if (status === "needs-approval") {
    lines.push("Implementation paused for maintainer approval.");
  } else if (status === "pr-open") {
    lines.push(
      details.pullRequestUrl
        ? `Draft Pull Request: ${details.pullRequestUrl}`
        : "A Draft Pull Request was created.",
    );
  } else if (status === "dry-run") {
    lines.push("Dry run completed; no branch or Pull Request was created.");
  } else {
    lines.push(
      "The repository development Agent could not prepare a Draft PR.",
    );
  }

  const reasons = (details.reasons ?? [])
    .map(sanitizeFailureReason)
    .filter(Boolean);
  if (reasons.length > 0) {
    lines.push("", "### Attention", "");
    for (const reason of reasons.slice(0, 8)) lines.push(`- ${reason}`);
  }
  const message = sanitizeLine(details.message ?? "");
  if (message) lines.push("", message);
  return lines.join("\n");
}

function sanitizeLine(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function sanitizeFailureReason(value: string): string {
  return sanitizeLine(value)
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "<redacted-token>",
    )
    .replace(/(Authorization\s*:\s*)(?:Bearer|token)\s+\S+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/([?&](?:access_token|token)=)[^&\s]+/gi, "$1<redacted>")
    .slice(0, 500);
}
