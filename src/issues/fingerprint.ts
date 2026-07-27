import crypto from "node:crypto";
import type { Issue, IssueComment } from "./types.js";

export const ISSUE_FINGERPRINT_PATTERN = /^[0-9a-f]{20}$/;

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
