import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Draft PR skill validation policy", () => {
  it("reports focused validation results honestly", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain("report their exact results");
    expect(skill).toContain(
      "preserve the initial failure, diagnosed\n  cause, corrective action, and final evidence",
    );
    expect(skill).toContain(
      "Never omit an unresolved\n  failure from `tests` or relabel it as `passed`",
    );
  });

  it("keeps unresolved validation failures blocking", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain(
      "Include every unresolved preparation or validation failure in `tests` and",
    );
    expect(skill).toMatch(
      /otherwise retain `failed` or `not_run`\s+and return `blocked`/,
    );
  });

  it("leaves required repository gates to the trusted Scheduler", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain("Keep Agent validation lightweight in every mode");
    expect(skill).toMatch(
      /Never run Integration, E2E,\s+Docker smoke, the repository's full Coverage gate, or its complete\s+validation matrix in the Agent sandbox/,
    );
    expect(skill).toContain(
      "even when a supplied CI failure\n   names one of those gates",
    );
    expect(skill).toMatch(
      /the trusted Scheduler independently runs\s+the policy's required lightweight gates in a credential-free sandbox/,
    );
    expect(skill).toMatch(
      /any\s+failure blocks commit and push regardless of the Agent's\s+reported results/,
    );
    expect(skill).toContain("For `fix_validation` mode:");
    expect(skill).toContain(
      "The Scheduler will independently rerun every required gate after the repair",
    );
    expect(skill).toContain(
      "Reproduce the smallest trustworthy scope that exercises\n  the supplied failure",
    );
    expect(skill).toContain("Defer those heavyweight scopes to provider CI");
  });

  it("pins deterministic commit validation to lightweight gates", async () => {
    const policy = JSON.parse(
      await readFile(
        new URL("../agents/draft-pr/policy.json", import.meta.url),
        "utf8",
      ),
    );

    expect(policy.requiredValidationGates).toEqual([
      "task-prepare",
      "task-lint",
      "task-test-unit",
    ]);
    expect(policy.requiredValidationGates).not.toContain(
      "task-test-integration",
    );
    expect(policy.requiredValidationGates).not.toContain("task-test-e2e");
    expect(policy.requiredValidationGates).not.toContain("task-test-coverage");
  });
});
