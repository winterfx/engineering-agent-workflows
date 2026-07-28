import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  normalizeGeneratedSource,
  parseBuildArguments,
} from "../scripts/build-tools.js";

describe("generated tool bundle build", () => {
  it("builds every target by default", () => {
    expect(parseBuildArguments([])).toEqual({
      check: false,
      targets: ["issue-triage", "draft-pr"],
    });
    expect(parseBuildArguments(["--check"])).toEqual({
      check: true,
      targets: ["issue-triage", "draft-pr"],
    });
  });

  it("accepts an explicit target and rejects unknown targets", () => {
    expect(parseBuildArguments(["draft-pr"])).toEqual({
      check: false,
      targets: ["draft-pr"],
    });
    expect(() => parseBuildArguments(["unknown"])).toThrow(
      "unknown build target: unknown",
    );
  });

  it("normalizes trailing whitespace deterministically", () => {
    expect(normalizeGeneratedSource("first  \nsecond\t\nthird\n")).toBe(
      "first\nsecond\nthird\n",
    );
  });

  it("keeps the generated bundles free of the Zod locale catalog", async () => {
    const bundles = await Promise.all([
      readFile(
        new URL(
          "../agents/issue-triage/scripts/issue-triage.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../agents/draft-pr/scripts/draft-pr.mjs", import.meta.url),
        "utf8",
      ),
    ]);

    for (const bundle of bundles) {
      expect(bundle).not.toContain("node_modules/zod/v4/locales/");
    }
  });
});
