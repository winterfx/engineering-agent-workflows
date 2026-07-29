import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Draft PR skill validation policy", () => {
  it("allows diagnosed failures only after equivalent final validation passes", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain("every final required validation passed");
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

  it("keeps unresolved final validation failures blocking", async () => {
    const skill = await readFile(
      new URL("../agents/draft-pr/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain(
      "Return `blocked` when a required final validation failed, could not be run, or",
    );
    expect(skill).toMatch(
      /otherwise retain `failed` or `not_run`\s+and return `blocked`/,
    );
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
