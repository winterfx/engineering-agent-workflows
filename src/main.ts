import { readFile } from "node:fs/promises";
import { GitHubClient } from "./github/client.js";
import { loadIssueTriageDefinition } from "./issue-triage/definition.js";
import { RuntimeTriageModel } from "./issue-triage/model.js";
import {
  runIssueTriageWorkflow,
  runtimeLogger,
} from "./issue-triage/workflow.js";

const RESULT_PREFIX = "__ENGINEERING_AGENT_WORKFLOW_RESULT__";

interface CLIOptions {
  workflow: string;
  eventFile: string;
  apply: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.workflow !== "issue-triage") {
    throw new Error(`unsupported workflow: ${options.workflow}`);
  }

  const event = JSON.parse(
    await readFile(options.eventFile, "utf8"),
  ) as unknown;
  const definition = await loadIssueTriageDefinition();
  const github = new GitHubClient({
    ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
    ...(process.env.GITHUB_API_URL
      ? { baseUrl: process.env.GITHUB_API_URL }
      : {}),
  });
  const model = new RuntimeTriageModel(process.env.ISSUE_TRIAGE_MODEL);
  const result = await runIssueTriageWorkflow(
    event,
    {
      apply: options.apply,
      ...(process.env.ISSUE_TRIAGE_BOT_LOGIN
        ? { botLogin: process.env.ISSUE_TRIAGE_BOT_LOGIN }
        : {}),
    },
    { github, model, definition, log: runtimeLogger },
  );
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function parseArguments(args: string[]): CLIOptions {
  let workflow = "";
  let eventFile = "";
  let apply = envBoolean(process.env.ISSUE_TRIAGE_APPLY);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--workflow") {
      workflow = requiredArgumentValue(args, ++index, "--workflow");
    } else if (argument === "--event") {
      eventFile = requiredArgumentValue(args, ++index, "--event");
    } else if (argument === "--apply") {
      apply = true;
    } else if (argument === "--dry-run") {
      apply = false;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!workflow) {
    throw new Error("--workflow is required");
  }
  if (!eventFile) {
    throw new Error("--event is required");
  }
  return { workflow, eventFile, apply };
}

function requiredArgumentValue(
  args: string[],
  index: number,
  name: string,
): string {
  const value = args[index]?.trim();
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function envBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`engineering agent workflow failed: ${message}\n`);
  process.stdout.write(
    `${RESULT_PREFIX}${JSON.stringify({ ok: false, error: message })}\n`,
  );
  process.exitCode = 1;
});
