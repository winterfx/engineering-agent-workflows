import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Draft PR skill validation policy", () => {
  it("allows diagnosed failures only after equivalent final validation passes", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain("every selected required local validation passed");
    expect(skill).toContain(
      "an equivalent final validation with the same scope passes",
    );
    expect(skill).toContain(
      "Never omit a failing package, weaken an assertion, or",
    );
    expect(skill).toContain(
      "preserve the initial failure, diagnosed\n  cause, corrective action, and final evidence",
    );
    expect(skill).toContain(
      "Never omit an unresolved\n  failure from `tests` or relabel it as `passed`",
    );
  });

  it("keeps unresolved selected local validation failures blocking", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain(
      "Return `blocked` when a selected required local validation failed, could not",
    );
    expect(skill).toMatch(
      /otherwise retain `failed` or `not_run`\s+and return `blocked`/,
    );
  });

  it("defers comprehensive validation to provider CI", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain(
      "Do not run repository-wide\n   build, all-package unit, integration, coverage, or E2E gates merely as",
    );
    expect(skill).toContain("a repository-wide unit shape");
    expect(skill).toContain(
      "Provider CI owns the comprehensive matrix after the deterministic tool",
    );
    expect(skill).toContain(
      "Record intentionally deferred comprehensive CI in\n   `notes`, not as a `not_run` test, and do not block on it",
    );
    expect(skill).toContain("do not run unrelated CI gates");
  });

  it("serializes preparation commands that mutate a shared workspace", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain(
      "Run workspace-mutating preparation commands serially and at most once per",
    );
    expect(skill).toContain(
      "Never run package installation, source generation, formatting,",
    );
    expect(skill).toContain(
      "parallelize only commands proven not to write the same workspace or shared",
    );
  });
});
