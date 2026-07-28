import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const buildTargets = {
  "issue-triage": {
    entryPoint: "src/issue-triage/main.ts",
    outfile: "agents/issue-triage/scripts/issue-triage.mjs",
  },
  "draft-pr": {
    entryPoint: "src/draft-pr/main.ts",
    outfile: "agents/draft-pr/scripts/draft-pr.mjs",
  },
} as const;

export type BuildTargetName = keyof typeof buildTargets;

export interface BuildOptions {
  check: boolean;
  targets: BuildTargetName[];
}

export function normalizeGeneratedSource(source: string): string {
  return source.replace(/[ \t]+$/gm, "");
}

export function parseBuildArguments(args: string[]): BuildOptions {
  const check = args.includes("--check");
  const requested = args.filter((argument) => argument !== "--check");
  const targets = requested.length > 0 ? requested : Object.keys(buildTargets);

  for (const target of targets) {
    if (!(target in buildTargets)) {
      throw new Error(`unknown build target: ${target}`);
    }
  }

  return { check, targets: targets as BuildTargetName[] };
}

async function buildTarget(
  targetName: BuildTargetName,
  check: boolean,
): Promise<boolean> {
  const target = buildTargets[targetName];
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [target.entryPoint],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(repositoryRoot, target.outfile),
    write: false,
    logLevel: "silent",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`esbuild produced no output for ${targetName}`);
  const generated = normalizeGeneratedSource(output.text);
  const outfile = path.join(repositoryRoot, target.outfile);

  if (!check) {
    await writeFile(outfile, generated);
    process.stdout.write(`built ${target.outfile}\n`);
    return true;
  }

  const current = await readFile(outfile, "utf8");
  if (current === generated) {
    process.stdout.write(`checked ${target.outfile}\n`);
    return true;
  }
  process.stderr.write(`stale ${target.outfile}\n`);
  return false;
}

export async function runBuild(options: BuildOptions): Promise<void> {
  const results = await Promise.all(
    options.targets.map((target) => buildTarget(target, options.check)),
  );
  if (results.some((matched) => !matched)) {
    throw new Error("generated tool bundles are stale; run npm run build");
  }
}

async function main(): Promise<void> {
  await runBuild(parseBuildArguments(process.argv.slice(2)));
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
