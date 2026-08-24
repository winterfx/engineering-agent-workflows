import type { IssueComment } from "../issues/types.js";

export const CI_FIX_COMMENT_PREFIX =
  "<!-- engineering-agent-workflows:ci-fix:v1";

export type CiFixStatus =
  "fixing" | "fixed" | "no-change" | "needs-approval" | "failed";

export interface CiFixState {
  checkSuiteId: number;
  attempts: number;
  headSha: string;
  status: CiFixStatus;
}

export function findCiFixComment(
  comments: IssueComment[],
  botLogin: string,
): IssueComment | undefined {
  const expected = botLogin.trim().toLowerCase();
  return comments.find(
    (comment) =>
      comment.user?.login.trim().toLowerCase() === expected &&
      comment.body.startsWith(CI_FIX_COMMENT_PREFIX),
  );
}

export function parseCiFixState(comment: IssueComment | undefined): CiFixState {
  if (!comment) return emptyCiFixState();
  const marker = comment.body.split("\n", 1)[0] ?? "";
  const match = marker.match(
    /^<!-- engineering-agent-workflows:ci-fix:v1 suite=(\d+) attempts=(\d+) head=([0-9a-f]{40}|none) status=(fixing|fixed|no-change|needs-approval|failed) -->$/,
  );
  if (!match) return emptyCiFixState();
  return {
    checkSuiteId: Number(match[1]),
    attempts: Number(match[2]),
    headSha: match[3] === "none" ? "" : match[3]!,
    status: match[4] as CiFixStatus,
  };
}

export function buildCiFixComment(state: CiFixState, detail?: string): string {
  const marker = `${CI_FIX_COMMENT_PREFIX} suite=${state.checkSuiteId} attempts=${state.attempts} head=${state.headSha || "none"} status=${state.status} -->`;
  const messages: Record<CiFixStatus, string> = {
    fixing: "The Draft PR Agent is validating the latest failed CI checks.",
    fixed:
      "The Draft PR Agent pushed a validated fix for the failed CI checks.",
    "no-change":
      "The Draft PR Agent inspected the failed CI checks and made no code change.",
    "needs-approval": "Automatic CI fixes paused for maintainer review.",
    failed: "The Draft PR Agent could not complete the latest CI fix attempt.",
  };
  const lines = [marker, "## CI follow-up", "", messages[state.status]];
  if (detail) lines.push("", detail);
  return lines.join("\n");
}

function emptyCiFixState(): CiFixState {
  return {
    checkSuiteId: 0,
    attempts: 0,
    headSha: "",
    status: "fixed",
  };
}
