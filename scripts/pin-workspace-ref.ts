import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composePath = path.join(repositoryRoot, "agent-compose.yml");

// Matches the `ref:` line of an `agents.<name>.workspace` block by its fixed
// position immediately before that block's `target: workflow-repo` line.
// Other `ref:` fields in this file (skills, scheduler.script) are followed
// by a `path:` line instead and are intentionally left untouched — see the
// design note in agent-compose.yml history for why only workspace.ref is
// pinned to a commit SHA.
const workspaceRefPattern =
  /( {6}ref: )[0-9a-f]{40}(\n {6}target: workflow-repo\n)/g;

export function pinWorkspaceRefs(
  compose: string,
  sha: string,
): { updated: string; count: number } {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`expected a 40-character commit SHA, got: ${sha}`);
  }
  let count = 0;
  const updated = compose.replace(
    workspaceRefPattern,
    (_match, prefix, suffix) => {
      count += 1;
      return `${prefix}${sha}${suffix}`;
    },
  );
  return { updated, count };
}

async function main(): Promise<void> {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const compose = await readFile(composePath, "utf8");
  const { updated, count } = pinWorkspaceRefs(compose, sha);
  if (count === 0) {
    throw new Error(
      "no agents.*.workspace.ref fields found in agent-compose.yml",
    );
  }
  await writeFile(composePath, updated);
  process.stdout.write(`pinned ${count} workspace.ref field(s) to ${sha}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
