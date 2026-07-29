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

    expect(skill).toContain(
      "Do\n   not run the repository's complete validation matrix unless the active",
    );
    expect(skill).toContain(
      "the trusted Scheduler independently runs the\n   policy's required gates in a credential-free sandbox",
    );
    expect(skill).toContain(
      "any failure blocks\n   commit and push regardless of the Agent's reported results",
    );
    expect(skill).toContain("do not run unrelated CI gates");
  });
});
