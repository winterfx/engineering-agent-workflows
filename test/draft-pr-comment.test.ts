import { describe, expect, it } from "vitest";
import {
  buildDraftPrStatusComment,
  sanitizeFailureReason,
} from "../src/draft-pr/comment.js";

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
