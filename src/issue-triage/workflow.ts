import runtime from "@chaitin-ai/agent-compose-runtime-sdk";
import type {
  GitHubComment,
  GitHubIssue,
  IssueCandidate,
} from "../github/types.js";
import { labelNames } from "../github/types.js";
import type { GitHubIssuesClient } from "../github/client.js";
import {
  buildTriageComment,
  COMMENT_MARKER_PREFIX,
  commentMarker,
  issueFingerprint,
} from "./comment.js";
import type { IssueTriageDefinition } from "./definition.js";
import { ignoreReason, parseIssueWebhook } from "./event.js";
import type { TriageModel } from "./model.js";
import { makeDecision, mergeManagedLabels } from "./policy.js";
import type { TriageDecision } from "./schema.js";

export interface IssueTriageWorkflowOptions {
  apply: boolean;
  botLogin?: string;
}

export interface IssueTriageWorkflowDependencies {
  github: GitHubIssuesClient;
  model: TriageModel;
  definition: IssueTriageDefinition;
  log?: (message: string, payload?: Record<string, unknown>) => void;
}

export interface IssueTriageWorkflowResult {
  ok: boolean;
  ignored?: boolean;
  skipped?: boolean;
  reason?: string;
  repository?: string;
  issueNumber?: number;
  applied?: boolean;
  titleChanged?: boolean;
  commentAction?: "created" | "updated" | "unchanged" | "dry-run";
  decision?: TriageDecision;
  proposedComment?: string;
}

export async function runIssueTriageWorkflow(
  input: unknown,
  options: IssueTriageWorkflowOptions,
  dependencies: IssueTriageWorkflowDependencies,
): Promise<IssueTriageWorkflowResult> {
  const event = parseIssueWebhook(input);
  const ignored = ignoreReason(event, options.botLogin);
  if (ignored) {
    return { ok: true, ignored: true, reason: ignored };
  }

  const repository = event.repository.full_name;
  const issueNumber = event.issue.number;
  const log = dependencies.log ?? (() => undefined);
  log("issue triage started", {
    repository,
    issueNumber,
    action: event.action,
  });

  const [issue, comments] = await Promise.all([
    dependencies.github.getIssue(repository, issueNumber),
    dependencies.github.listComments(repository, issueNumber),
  ]);
  const currentFingerprint = issueFingerprint(issue);
  if (
    comments.some((comment) =>
      comment.body.includes(commentMarker(issueNumber, currentFingerprint)),
    )
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "issue content already triaged",
      repository,
      issueNumber,
      applied: false,
    };
  }

  let candidates: IssueCandidate[] = [];
  try {
    candidates = await dependencies.github.searchCandidates(
      repository,
      issue,
      dependencies.definition.policy.maxCandidates,
    );
  } catch (error) {
    log("candidate search failed; continuing without candidates", {
      repository,
      issueNumber,
      error: errorMessage(error),
    });
  }

  const analysis = await dependencies.model.analyze({
    issue,
    repository,
    candidates,
    policy: dependencies.definition.policy,
    agentText: dependencies.definition.agentText,
  });
  const decision = makeDecision(
    analysis,
    candidates,
    dependencies.definition.policy,
  );
  const targetTitle = decision.normalizedTitle || issue.title;
  const targetIssue = { ...issue, title: targetTitle };
  const targetFingerprint = issueFingerprint(targetIssue);
  const proposedComment = buildTriageComment(
    issueNumber,
    targetFingerprint,
    decision,
  );
  const desiredLabels = mergeManagedLabels(
    labelNames(issue),
    decision.labels,
    dependencies.definition.policy.managedLabelPrefixes,
  );
  const titleChanged = targetTitle !== issue.title;
  const labelsChanged = !sameStringSet(labelNames(issue), desiredLabels);
  const existingComment = findTriageComment(comments);

  if (!options.apply) {
    log("issue triage dry-run completed", {
      repository,
      issueNumber,
      priority: decision.priority,
      titleChanged,
      labelsChanged,
    });
    return {
      ok: true,
      repository,
      issueNumber,
      applied: false,
      titleChanged,
      commentAction: "dry-run",
      decision,
      proposedComment,
    };
  }

  await ensureLabels(
    dependencies.github,
    repository,
    decision.labels,
    dependencies.definition,
  );
  if (titleChanged || labelsChanged) {
    await dependencies.github.updateIssue(repository, issueNumber, {
      ...(titleChanged ? { title: targetTitle } : {}),
      ...(labelsChanged ? { labels: desiredLabels } : {}),
    });
  }

  let commentAction: IssueTriageWorkflowResult["commentAction"] = "unchanged";
  if (!existingComment) {
    await dependencies.github.createComment(
      repository,
      issueNumber,
      proposedComment,
    );
    commentAction = "created";
  } else if (existingComment.body !== proposedComment) {
    await dependencies.github.updateComment(
      repository,
      existingComment.id,
      proposedComment,
    );
    commentAction = "updated";
  }

  log("issue triage applied", {
    repository,
    issueNumber,
    priority: decision.priority,
    titleChanged,
    labelsChanged,
    commentAction,
  });
  return {
    ok: true,
    repository,
    issueNumber,
    applied: true,
    titleChanged,
    commentAction,
    decision,
  };
}

export function runtimeLogger(
  message: string,
  payload?: Record<string, unknown>,
): void {
  runtime.log(message, payload);
}

async function ensureLabels(
  github: GitHubIssuesClient,
  repository: string,
  labels: string[],
  definition: IssueTriageDefinition,
): Promise<void> {
  for (const label of labels) {
    const color = definition.policy.labelColors[label] ?? "ededed";
    await github.ensureLabel(repository, label, color);
  }
}

function findTriageComment(
  comments: GitHubComment[],
): GitHubComment | undefined {
  return comments.find((comment) =>
    comment.body.includes(COMMENT_MARKER_PREFIX),
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
