import type { IssueComment } from "../issues/types.js";

export const REVIEW_FIX_COMMENT_PREFIX =
  "<!-- engineering-agent-workflows:review-fix:v";
const REVIEW_FIX_COMMENT_V2_PREFIX = `${REVIEW_FIX_COMMENT_PREFIX}2`;
const REVIEW_FIX_COMMENT_V3_PREFIX = `${REVIEW_FIX_COMMENT_PREFIX}3`;

export type ReviewFixStatus =
  "fixing" | "fixed" | "no-change" | "needs-approval" | "failed";

export interface ReviewFixState {
  reviewCursor: number;
  iterations: number;
  headSha: string;
  status: ReviewFixStatus;
}

export function findReviewFixComment(
  comments: IssueComment[],
  botLogin: string,
): IssueComment | undefined {
  const expected = botLogin.trim().toLowerCase();
  return comments.find(
    (comment) =>
      comment.user?.login.trim().toLowerCase() === expected &&
      comment.body.startsWith(REVIEW_FIX_COMMENT_PREFIX),
  );
}

export function parseReviewFixState(
  comment: IssueComment | undefined,
): ReviewFixState {
  if (!comment) return emptyReviewFixState();
  const marker = comment.body.split("\n", 1)[0] ?? "";
  const v3Match = marker.match(
    /^<!-- engineering-agent-workflows:review-fix:v3 review=(\d+) iterations=(\d+) head=([0-9a-f]{40}|none) status=(fixing|fixed|no-change|needs-approval|failed) -->$/,
  );
  if (v3Match) {
    return {
      reviewCursor: Number(v3Match[1]),
      iterations: Number(v3Match[2]),
      headSha: v3Match[3] === "none" ? "" : v3Match[3]!,
      status: v3Match[4] as ReviewFixStatus,
    };
  }
  const v2Match = marker.match(
    /^<!-- engineering-agent-workflows:review-fix:v2 conversation=(\d+) review=(\d+) iterations=(\d+) head=([0-9a-f]{40}|none) status=(fixing|fixed|no-change|needs-approval|failed) -->$/,
  );
  if (v2Match) {
    return {
      // v2 stored Conversation and inline Review Comment IDs, not Review IDs.
      // Start the v3 Review cursor at zero so the first formal change request
      // after upgrading is never skipped because the ID namespaces differ.
      reviewCursor: 0,
      iterations: Number(v2Match[3]),
      headSha: v2Match[4] === "none" ? "" : v2Match[4]!,
      status: v2Match[5] as ReviewFixStatus,
    };
  }
  const v1Match = marker.match(
    /^<!-- engineering-agent-workflows:review-fix:v1 cursor=(\d+) iterations=(\d+) head=([0-9a-f]{40}|none) status=(fixing|fixed|no-change|needs-approval|failed) -->$/,
  );
  if (!v1Match) return emptyReviewFixState();
  return {
    reviewCursor: 0,
    iterations: Number(v1Match[2]),
    headSha: v1Match[3] === "none" ? "" : v1Match[3]!,
    status: v1Match[4] as ReviewFixStatus,
  };
}

export function buildReviewFixComment(
  state: ReviewFixState,
  detail?: string,
): string {
  const marker = `${REVIEW_FIX_COMMENT_V3_PREFIX} review=${state.reviewCursor} iterations=${state.iterations} head=${state.headSha || "none"} status=${state.status} -->`;
  const messages: Record<ReviewFixStatus, string> = {
    fixing: "The Draft PR Agent is validating a requested change.",
    fixed:
      "The Draft PR Agent pushed a validated fix for the latest requested changes.",
    "no-change":
      "The Draft PR Agent verified the latest requested changes and made no code change.",
    "needs-approval": "Automatic Review fixes paused for maintainer approval.",
    failed:
      "The Draft PR Agent could not complete the latest Review fix attempt.",
  };
  const lines = [marker, "## Review follow-up", "", messages[state.status]];
  if (detail) lines.push("", detail);
  return lines.join("\n");
}

function emptyReviewFixState(): ReviewFixState {
  return {
    reviewCursor: 0,
    iterations: 0,
    headSha: "",
    status: "fixed",
  };
}
