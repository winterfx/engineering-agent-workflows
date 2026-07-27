import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubClient } from "../github/client.js";
import { isProjectPath } from "../issues/types.js";
import {
  envBoolean,
  isPositiveInteger,
  requiredArgumentValue,
} from "../runtime/cli.js";
import { errorMessage } from "../runtime/errors.js";
import { loadJsonFromCandidates } from "../runtime/load-json.js";
import { applyCiFix, failCiFix, prepareCiFix } from "./ci-tool.js";
import { draftPrPolicySchema, type DraftPrPolicy } from "./policy.js";
import {
  applyReviewFix,
  failReviewFix,
  listReviewFixTargets,
  prepareReviewFix,
} from "./review-tool.js";
import { assertBoundDraftPrTarget, assertBoundReviewTarget } from "./target.js";
import { applyDraftPr, failDraftPr, prepareDraftPr } from "./tool.js";
import { GitDraftPrWorkspace } from "./workspace.js";

interface CLIOptions {
  command:
    | "prepare"
    | "apply"
    | "fail"
    | "list-review-targets"
    | "prepare-review"
    | "apply-review"
    | "fail-review"
    | "prepare-ci"
    | "apply-ci"
    | "fail-ci";
  repository: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  trigger?: "ready" | "approved";
  analysisFile?: string;
  message?: string;
  conversationCursor?: number;
  reviewCursor?: number;
  iterations?: number;
  headSha?: string;
  checkSuiteId?: number;
  attempts?: number;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const policy = await loadPolicy();
  const apply = envBoolean(process.env.DRAFT_PR_APPLY);
  if (["prepare", "apply", "fail"].includes(options.command)) {
    assertBoundDraftPrTarget(
      options.repository,
      options.issueNumber!,
      apply,
      process.env,
    );
  } else if (options.command !== "list-review-targets") {
    assertBoundReviewTarget(
      options.repository,
      options.pullRequestNumber!,
      apply,
      process.env,
    );
  }
  const token = process.env.GITHUB_TOKEN?.trim() ?? "";
  const provider = new GitHubClient({
    ...(token ? { token } : {}),
    ...(process.env.GITHUB_API_URL
      ? { baseUrl: process.env.GITHUB_API_URL }
      : {}),
  });
  const workspace = new GitDraftPrWorkspace({
    root: process.env.DRAFT_PR_WORKSPACE_ROOT?.trim() || "/draft-pr-workspaces",
    token,
    authorName:
      process.env.DRAFT_PR_GIT_AUTHOR_NAME?.trim() ||
      "engineering-agent-workflows",
    authorEmail:
      process.env.DRAFT_PR_GIT_AUTHOR_EMAIL?.trim() ||
      "engineering-agent-workflows@users.noreply.github.com",
  });
  const dependencies = {
    provider,
    workspace,
    policy,
    allowedRepository:
      process.env.DRAFT_PR_ALLOWED_REPOSITORY?.trim() ||
      process.env.GITHUB_ALLOWED_REPOSITORY?.trim() ||
      "",
    serverUrl: process.env.GITHUB_SERVER_URL?.trim() || "https://github.com",
    apply,
    ...(process.env.GITHUB_BOT_LOGIN
      ? { botLogin: process.env.GITHUB_BOT_LOGIN }
      : {}),
    monkeyScanBotLogin: process.env.MONKEYSCAN_BOT_LOGIN?.trim() ?? "",
    ...(isPositiveInteger(process.env.MONKEYSCAN_BOT_USER_ID)
      ? { monkeyScanBotUserId: Number(process.env.MONKEYSCAN_BOT_USER_ID) }
      : {}),
  };

  const result =
    options.command === "prepare"
      ? await prepareDraftPr(
          options.repository,
          options.issueNumber!,
          options.trigger!,
          dependencies,
        )
      : options.command === "apply"
        ? await applyDraftPr(
            options.repository,
            options.issueNumber!,
            JSON.parse(
              await readFile(options.analysisFile!, "utf8"),
            ) as unknown,
            dependencies,
          )
        : options.command === "fail"
          ? await failDraftPr(
              options.repository,
              options.issueNumber!,
              options.message ?? "Draft PR Agent execution failed",
              dependencies,
            )
          : options.command === "list-review-targets"
            ? await listReviewFixTargets(options.repository, dependencies)
            : options.command === "prepare-review"
              ? await prepareReviewFix(
                  options.repository,
                  options.pullRequestNumber!,
                  dependencies,
                )
              : options.command === "apply-review"
                ? await applyReviewFix(
                    options.repository,
                    options.pullRequestNumber!,
                    JSON.parse(
                      await readFile(options.analysisFile!, "utf8"),
                    ) as unknown,
                    dependencies,
                  )
                : options.command === "fail-review"
                  ? await failReviewFix(
                      options.repository,
                      options.pullRequestNumber!,
                      options.conversationCursor ?? 0,
                      options.reviewCursor ?? 0,
                      options.iterations ?? 0,
                      options.headSha ?? "",
                      dependencies,
                    )
                  : options.command === "prepare-ci"
                    ? await prepareCiFix(
                        options.repository,
                        options.pullRequestNumber!,
                        options.headSha ?? "",
                        options.checkSuiteId ?? 0,
                        dependencies,
                      )
                    : options.command === "apply-ci"
                      ? await applyCiFix(
                          options.repository,
                          options.pullRequestNumber!,
                          JSON.parse(
                            await readFile(options.analysisFile!, "utf8"),
                          ) as unknown,
                          dependencies,
                        )
                      : await failCiFix(
                          options.repository,
                          options.pullRequestNumber!,
                          options.checkSuiteId ?? 0,
                          options.attempts ?? 0,
                          options.headSha ?? "",
                          dependencies,
                        );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function loadPolicy(): Promise<DraftPrPolicy> {
  return loadJsonFromCandidates(
    [
      fileURLToPath(new URL("../policy.json", import.meta.url)),
      path.resolve("agents/draft-pr/policy.json"),
    ],
    (value) => draftPrPolicySchema.parse(value),
    "failed to load Draft PR policy",
  );
}

function parseArguments(args: string[]): CLIOptions {
  const command = args.shift();
  if (
    command !== "prepare" &&
    command !== "apply" &&
    command !== "fail" &&
    command !== "list-review-targets" &&
    command !== "prepare-review" &&
    command !== "apply-review" &&
    command !== "fail-review" &&
    command !== "prepare-ci" &&
    command !== "apply-ci" &&
    command !== "fail-ci"
  ) {
    throw new Error("invalid Draft PR tool command");
  }
  let repository = "";
  let issueNumber = 0;
  let pullRequestNumber = 0;
  let trigger = "";
  let analysisFile = "";
  let message = "";
  let conversationCursor = 0;
  let reviewCursor = 0;
  let iterations = 0;
  let headSha = "";
  let checkSuiteId = 0;
  let attempts = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repository") {
      repository = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--issue") {
      issueNumber = Number(requiredArgumentValue(args, ++index, argument));
    } else if (argument === "--pull-request") {
      pullRequestNumber = Number(
        requiredArgumentValue(args, ++index, argument),
      );
    } else if (argument === "--trigger") {
      trigger = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--analysis") {
      analysisFile = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--message") {
      message = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--conversation-cursor") {
      conversationCursor = Number(
        requiredArgumentValue(args, ++index, argument),
      );
    } else if (argument === "--review-cursor") {
      reviewCursor = Number(requiredArgumentValue(args, ++index, argument));
    } else if (argument === "--iterations") {
      iterations = Number(requiredArgumentValue(args, ++index, argument));
    } else if (argument === "--head") {
      headSha = requiredArgumentValue(args, ++index, argument);
    } else if (argument === "--check-suite") {
      checkSuiteId = Number(requiredArgumentValue(args, ++index, argument));
    } else if (argument === "--attempts") {
      attempts = Number(requiredArgumentValue(args, ++index, argument));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!isProjectPath(repository)) {
    throw new Error("--repository must use owner/repository format");
  }
  if (
    ["prepare", "apply", "fail"].includes(command) &&
    (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)
  ) {
    throw new Error("--issue must be a positive integer");
  }
  if (
    [
      "prepare-review",
      "apply-review",
      "fail-review",
      "prepare-ci",
      "apply-ci",
      "fail-ci",
    ].includes(command) &&
    (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0)
  ) {
    throw new Error("--pull-request must be a positive integer");
  }
  if (command === "prepare" && trigger !== "ready" && trigger !== "approved") {
    throw new Error("prepare requires --trigger ready or approved");
  }
  if (
    (command === "apply" ||
      command === "apply-review" ||
      command === "apply-ci") &&
    !analysisFile
  ) {
    throw new Error(`${command} requires --analysis`);
  }
  return {
    command,
    repository,
    ...(issueNumber ? { issueNumber } : {}),
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
    ...(trigger === "ready" || trigger === "approved" ? { trigger } : {}),
    ...(analysisFile ? { analysisFile } : {}),
    ...(message ? { message } : {}),
    ...(conversationCursor ? { conversationCursor } : {}),
    ...(reviewCursor ? { reviewCursor } : {}),
    ...(iterations ? { iterations } : {}),
    ...(headSha ? { headSha } : {}),
    ...(Number.isSafeInteger(checkSuiteId) && checkSuiteId > 0
      ? { checkSuiteId }
      : {}),
    ...(Number.isSafeInteger(attempts) && attempts >= 0 ? { attempts } : {}),
  };
}

main().catch((error: unknown) => {
  process.stderr.write(`draft-pr failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
