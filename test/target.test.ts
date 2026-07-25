import { describe, expect, it } from "vitest";
import { assertBoundIssueTarget } from "../src/issue-triage/target.js";

describe("scheduler-bound Issue target", () => {
  it("accepts the exact repository and Issue supplied by the Scheduler", () => {
    expect(() =>
      assertBoundIssueTarget("example/repo", 410, true, {
        ISSUE_TRIAGE_EXPECTED_REPOSITORY: "example/repo",
        ISSUE_TRIAGE_EXPECTED_ISSUE: "410",
      }),
    ).not.toThrow();
  });

  it("rejects a model-selected target that differs from the webhook", () => {
    expect(() =>
      assertBoundIssueTarget("other/repo", 999, true, {
        ISSUE_TRIAGE_EXPECTED_REPOSITORY: "example/repo",
        ISSUE_TRIAGE_EXPECTED_ISSUE: "410",
      }),
    ).toThrow("does not match scheduler-bound target");
  });

  it("requires a trusted binding whenever writes are enabled", () => {
    expect(() => assertBoundIssueTarget("example/repo", 410, true, {})).toThrow(
      "requires a scheduler-bound Issue target",
    );
  });

  it("allows an unbound local dry-run", () => {
    expect(() =>
      assertBoundIssueTarget("example/repo", 410, false, {}),
    ).not.toThrow();
  });
});
