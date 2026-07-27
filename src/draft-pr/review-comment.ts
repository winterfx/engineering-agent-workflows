import type { IssueComment } from "../issues/types.js";

export const REVIEW_FIX_COMMENT_PREFIX =
  "<!-- engineering-agent-workflows:review-fix:v";
const REVIEW_FIX_COMMENT_V2_PREFIX = `${REVIEW_FIX_COMMENT_PREFIX}2`;

export type ReviewFixStatus =
  "fixing" | "fixed" | "no-change" | "needs-approval" | "failed";

export interface ReviewFixState {
  conversationCursor: number;
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
  const v2Match = marker.match(
    /^<!-- engineering-agent-workflows:review-fix:v2 conversation=(\d+) review=(\d+) iterations=(\d+) head=([0-9a-f]{40}|none) status=(fixing|fixed|no-change|needs-approval|failed) -->$/,
  );
  if (v2Match) {
    return {
      conversationCursor: Number(v2Match[1]),
      reviewCursor: Number(v2Match[2]),
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
    conversationCursor: Number(v1Match[1]),
    reviewCursor: 0,
    iterations: Number(v1Match[2]),
    headSha: v1Match[3] === "none" ? "" : v1Match[3]!,
    status: v1Match[4] as ReviewFixStatus,
  };
}

export function buildReviewFixComment(state: ReviewFixState): string {
  const marker = `${REVIEW_FIX_COMMENT_V2_PREFIX} conversation=${state.conversationCursor} review=${state.reviewCursor} iterations=${state.iterations} head=${state.headSha || "none"} status=${state.status} -->`;
  const messages: Record<ReviewFixStatus, string> = {
    fixing: "The Draft PR Agent is validating new MonkeyScan findings.",
    fixed:
      "The Draft PR Agent pushed a validated fix for the latest MonkeyScan findings.",
    "no-change":
      "The Draft PR Agent verified the latest MonkeyScan findings and made no code change.",
    "needs-approval":
      "Automatic MonkeyScan fixes paused for maintainer review.",
    failed:
      "The Draft PR Agent could not complete the latest MonkeyScan fix attempt.",
  };
  return [marker, "## MonkeyScan follow-up", "", messages[state.status]].join(
    "\n",
  );
}

function emptyReviewFixState(): ReviewFixState {
  return {
    conversationCursor: 0,
    reviewCursor: 0,
    iterations: 0,
    headSha: "",
    status: "fixed",
  };
}
