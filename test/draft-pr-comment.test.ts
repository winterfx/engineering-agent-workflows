import { describe, expect, it } from "vitest";
import {
  buildDraftPrStatusComment,
  sanitizeFailureReason,
} from "../src/draft-pr/comment.js";
import {
  buildReviewFixComment,
  parseReviewFixState,
} from "../src/draft-pr/review-comment.js";

describe("Draft PR status comment", () => {
  it("includes a redacted deterministic failure reason", () => {
    const reason = sanitizeFailureReason(
      "git clone failed with Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456 and https://user:secret@github.com/repo",
    );

    expect(reason).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(reason).not.toContain("user:secret");
    expect(
      buildDraftPrStatusComment(3, "failed", { reasons: [reason] }),
    ).toContain(`- ${reason}`);
  });
});

describe("Draft PR Review status comment", () => {
  it("builds and parses the v3 Review cursor", () => {
    const body = buildReviewFixComment({
      reviewCursor: 700,
      iterations: 2,
      headSha: "a".repeat(40),
      status: "fixed",
    });

    expect(body).toContain("review-fix:v3 review=700 iterations=2");
    expect(body).toContain("## Review follow-up");
    expect(parseReviewFixState({ id: 1, body })).toEqual({
      reviewCursor: 700,
      iterations: 2,
      headSha: "a".repeat(40),
      status: "fixed",
    });
  });

  it.each([
    `<!-- engineering-agent-workflows:review-fix:v1 cursor=99 iterations=1 head=${"b".repeat(40)} status=failed -->`,
    `<!-- engineering-agent-workflows:review-fix:v2 conversation=88 review=99 iterations=1 head=${"b".repeat(40)} status=failed -->`,
  ])("reads legacy state without reusing comment IDs as Review IDs", (body) => {
    expect(parseReviewFixState({ id: 1, body })).toEqual({
      reviewCursor: 0,
      iterations: 1,
      headSha: "b".repeat(40),
      status: "failed",
    });
  });
});
