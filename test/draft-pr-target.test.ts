import { describe, expect, it } from "vitest";
import {
  assertBoundDraftPrTarget,
  assertBoundReviewTarget,
} from "../src/draft-pr/target.js";

describe("Draft PR target binding", () => {
  it("requires an exact scheduler-bound target in apply mode", () => {
    expect(() =>
      assertBoundDraftPrTarget("chaitin/agent-compose", 439, true, {}),
    ).toThrow("scheduler-bound");
    expect(() =>
      assertBoundDraftPrTarget("chaitin/agent-compose", 439, true, {
        DRAFT_PR_EXPECTED_REPOSITORY: "chaitin/agent-compose",
        DRAFT_PR_EXPECTED_ISSUE: "440",
      }),
    ).toThrow("does not match");
    expect(() =>
      assertBoundDraftPrTarget("chaitin/agent-compose", 439, true, {
        DRAFT_PR_EXPECTED_REPOSITORY: "chaitin/agent-compose",
        DRAFT_PR_EXPECTED_ISSUE: "439",
      }),
    ).not.toThrow();
  });

  it("binds review writes to one exact Pull Request", () => {
    expect(() =>
      assertBoundReviewTarget("chaitin/agent-compose", 440, true, {}),
    ).toThrow("scheduler-bound");
    expect(() =>
      assertBoundReviewTarget("chaitin/agent-compose", 440, true, {
        DRAFT_PR_EXPECTED_REPOSITORY: "chaitin/agent-compose",
        DRAFT_PR_EXPECTED_PULL_REQUEST: "441",
      }),
    ).toThrow("does not match");
    expect(() =>
      assertBoundReviewTarget("chaitin/agent-compose", 440, true, {
        DRAFT_PR_EXPECTED_REPOSITORY: "chaitin/agent-compose",
        DRAFT_PR_EXPECTED_PULL_REQUEST: "440",
      }),
    ).not.toThrow();
  });
});
