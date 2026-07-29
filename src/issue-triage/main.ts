import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitHubToken } from "../github/app-auth.js";
import { GitHubClient } from "../github/client.js";
import { isRepositorySlug } from "../issues/types.js";
import { envBoolean, requiredArgumentValue } from "../runtime/cli.js";
import { errorMessage } from "../runtime/errors.js";
import { loadJsonFromCandidates } from "../runtime/load-json.js";
import { triagePolicySchema, type TriagePolicy } from "./policy.js";
import { assertBoundIssueTarget } from "./target.js";
import { applyIssueTriage, prepareIssueTriage } from "./tool.js";

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
  const token = await resolveGitHubToken(options.repository);
  const issues = new GitHubClient({
    ...(token ? { token } : {}),
    ...(process.env.GITHUB_API_URL
      ? { baseUrl: process.env.GITHUB_API_URL }
      : {}),
  });
  const dependencies = {
    issues,
    policy,
    ...(process.env.GITHUB_BOT_LOGIN
      ? { botLogin: process.env.GITHUB_BOT_LOGIN }
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
  const embedded = process.env.WORKFLOW_POLICY_JSON?.trim();
  if (embedded) {
    try {
      return triagePolicySchema.parse(JSON.parse(embedded));
    } catch (error) {
      throw new Error(
        `failed to load embedded triage policy: ${errorMessage(error)}`,
      );
    }
  }
  return loadJsonFromCandidates(
    [
      fileURLToPath(new URL("../policy.json", import.meta.url)),
      path.resolve("agents/issue-triage/policy.json"),
    ],
    (value) => triagePolicySchema.parse(value),
    "failed to load issue triage policy",
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

  if (!isRepositorySlug(repository)) {
    throw new Error("--repository must use owner/repository format");
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

main().catch((error: unknown) => {
  process.stderr.write(`issue triage failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
