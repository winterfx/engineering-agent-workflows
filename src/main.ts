import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubClient } from "./github/client.js";
import {
  triagePolicySchema,
  type TriagePolicy,
} from "./issue-triage/policy.js";
import { assertBoundIssueTarget } from "./issue-triage/target.js";
import { applyIssueTriage, prepareIssueTriage } from "./issue-triage/tool.js";

interface CLIOptions {
  command: "prepare" | "apply";
  repository: string;
  issueNumber: number;
  analysisFile?: string;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const policy = await loadPolicy();
  const apply = envBoolean(process.env.ISSUE_TRIAGE_APPLY);
  assertBoundIssueTarget(
    options.repository,
    options.issueNumber,
    apply,
    process.env,
  );
  const github = new GitHubClient({
    ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
    ...(process.env.GITHUB_API_URL
      ? { baseUrl: process.env.GITHUB_API_URL }
      : {}),
  });
  const dependencies = {
    github,
    policy,
    ...(process.env.ISSUE_TRIAGE_BOT_LOGIN
      ? { botLogin: process.env.ISSUE_TRIAGE_BOT_LOGIN }
      : {}),
  };

  const result =
    options.command === "prepare"
      ? await prepareIssueTriage(
          options.repository,
          options.issueNumber,
          dependencies,
        )
      : await applyIssueTriage(
          options.repository,
          options.issueNumber,
          JSON.parse(await readFile(options.analysisFile!, "utf8")) as unknown,
          apply,
          dependencies,
        );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function loadPolicy(): Promise<TriagePolicy> {
  const candidates = [
    fileURLToPath(new URL("../policy.json", import.meta.url)),
    path.resolve("agents/issue-triage/policy.json"),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return triagePolicySchema.parse(
        JSON.parse(await readFile(candidate, "utf8")) as unknown,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `failed to load issue triage policy: ${errorMessage(lastError)}`,
  );
}

function parseArguments(args: string[]): CLIOptions {
  const command = args.shift();
  if (command !== "prepare" && command !== "apply") {
    throw new Error("first argument must be prepare or apply");
  }
  let repository = "";
  let issueNumber = 0;
  let analysisFile = "";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repository") {
      repository = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--issue") {
      const raw = requiredArgumentValue(args, ++index, argument);
      issueNumber = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        throw new Error("--issue must be a positive integer");
      }
    } else if (argument === "--analysis") {
      analysisFile = requiredArgumentValue(args, ++index, argument);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("--repository must use owner/name format");
  }
  if (issueNumber <= 0) throw new Error("--issue is required");
  if (command === "apply" && !analysisFile) {
    throw new Error("--analysis is required for apply");
  }
  return {
    command,
    repository,
    issueNumber,
    ...(analysisFile ? { analysisFile } : {}),
  };
}

function requiredArgumentValue(
  args: string[],
  index: number,
  name: string,
): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function envBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`issue triage failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
