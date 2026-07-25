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
import {
  makeDecision,
  mergeManagedLabels,
  type TriagePolicy,
} from "./policy.js";
import { triageSubmissionSchema, type TriageDecision } from "./schema.js";

export interface IssueTriageToolDependencies {
  github: GitHubIssuesClient;
  policy: TriagePolicy;
  botLogin?: string;
}

export interface PreparedIssueTriage {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  issueNumber: number;
  issueFingerprint: string;
  issue?: GitHubIssue;
  comments?: GitHubComment[];
  candidates?: IssueCandidate[];
  warnings?: string[];
}

export interface AppliedIssueTriage {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  issueNumber: number;
  applied: boolean;
  titleChanged?: boolean;
  commentAction?: "created" | "updated" | "unchanged" | "dry-run";
  decision?: TriageDecision;
  proposedComment?: string;
  warnings?: string[];
}

export async function prepareIssueTriage(
  repository: string,
  issueNumber: number,
  dependencies: IssueTriageToolDependencies,
): Promise<PreparedIssueTriage> {
  const [issue, comments] = await Promise.all([
    dependencies.github.getIssue(repository, issueNumber),
    dependencies.github.listComments(repository, issueNumber),
  ]);
  const contextComments = selectContextComments(
    comments,
    dependencies.botLogin,
  );
  const fingerprint = issueFingerprint(issue, contextComments);
  if (
    hasCurrentTriageComment(
      comments,
      issueNumber,
      fingerprint,
      dependencies.botLogin,
    )
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "issue content already triaged",
      repository,
      issueNumber,
      issueFingerprint: fingerprint,
    };
  }

  const { candidates, warnings } = await loadCandidates(
    dependencies.github,
    repository,
    issue,
    dependencies.policy.maxCandidates,
  );
  return {
    ok: true,
    repository,
    issueNumber,
    issueFingerprint: fingerprint,
    issue,
    comments: contextComments,
    candidates,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function applyIssueTriage(
  repository: string,
  issueNumber: number,
  submissionInput: unknown,
  apply: boolean,
  dependencies: IssueTriageToolDependencies,
): Promise<AppliedIssueTriage> {
  const submission = triageSubmissionSchema.parse(submissionInput);
  const botLogin = requiredBotLogin(apply, dependencies.botLogin);
  const [issue, comments] = await Promise.all([
    dependencies.github.getIssue(repository, issueNumber),
    dependencies.github.listComments(repository, issueNumber),
  ]);
  const contextComments = selectContextComments(comments, botLogin);
  const currentFingerprint = issueFingerprint(issue, contextComments);
  if (currentFingerprint !== submission.issueFingerprint) {
    throw new Error(
      "issue changed after analysis; run the prepare command again before applying",
    );
  }
  if (
    hasCurrentTriageComment(comments, issueNumber, currentFingerprint, botLogin)
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

  const { candidates, warnings } = await loadCandidates(
    dependencies.github,
    repository,
    issue,
    dependencies.policy.maxCandidates,
  );
  const decision = makeDecision(
    submission.analysis,
    candidates,
    dependencies.policy,
  );
  const targetTitle = decision.normalizedTitle || issue.title;
  const targetIssue = { ...issue, title: targetTitle };
  const targetFingerprint = issueFingerprint(targetIssue, contextComments);
  const proposedComment = buildTriageComment(
    issueNumber,
    targetFingerprint,
    decision,
  );
  const desiredLabels = mergeManagedLabels(
    labelNames(issue),
    decision.labels,
    dependencies.policy.managedLabelPrefixes,
  );
  const existingLabels = labelNames(issue);
  const labelsToAdd = desiredLabels.filter(
    (label) => !existingLabels.includes(label),
  );
  const labelsToRemove = existingLabels.filter(
    (label) =>
      isManagedLabel(label, dependencies.policy.managedLabelPrefixes) &&
      !desiredLabels.includes(label),
  );
  const titleChanged = targetTitle !== issue.title;
  const labelsChanged = labelsToAdd.length > 0 || labelsToRemove.length > 0;
  const existingComment = findTriageComment(comments, botLogin);

  if (!apply) {
    return {
      ok: true,
      repository,
      issueNumber,
      applied: false,
      titleChanged,
      commentAction: "dry-run",
      decision,
      proposedComment,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  await ensureLabels(
    dependencies.github,
    repository,
    decision.labels,
    dependencies.policy,
  );
  if (titleChanged) {
    await dependencies.github.updateIssue(repository, issueNumber, {
      title: targetTitle,
    });
  }
  await dependencies.github.addLabels(repository, issueNumber, labelsToAdd);
  for (const label of labelsToRemove) {
    await dependencies.github.removeLabel(repository, issueNumber, label);
  }

  let commentAction: AppliedIssueTriage["commentAction"] = "unchanged";
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

  return {
    ok: true,
    repository,
    issueNumber,
    applied: true,
    titleChanged,
    commentAction,
    decision,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function loadCandidates(
  github: GitHubIssuesClient,
  repository: string,
  issue: GitHubIssue,
  limit: number,
): Promise<{ candidates: IssueCandidate[]; warnings: string[] }> {
  try {
    return {
      candidates: await github.searchCandidates(repository, issue, limit),
      warnings: [],
    };
  } catch (error) {
    return {
      candidates: [],
      warnings: [
        `candidate search failed; duplicate claims will be rejected: ${errorMessage(error)}`,
      ],
    };
  }
}

function hasCurrentTriageComment(
  comments: GitHubComment[],
  issueNumber: number,
  fingerprint: string,
  botLogin?: string,
): boolean {
  const marker = commentMarker(issueNumber, fingerprint);
  return comments.some(
    (comment) =>
      isManagedTriageComment(comment, botLogin) &&
      (comment.body === marker || comment.body.startsWith(`${marker}\n`)),
  );
}

function findTriageComment(
  comments: GitHubComment[],
  botLogin?: string,
): GitHubComment | undefined {
  return comments.find(
    (comment) =>
      isManagedTriageComment(comment, botLogin) &&
      comment.body.startsWith(COMMENT_MARKER_PREFIX),
  );
}

function isManagedTriageComment(
  comment: GitHubComment,
  botLogin?: string,
): boolean {
  const expectedLogin = botLogin?.trim().toLowerCase();
  return Boolean(
    expectedLogin && comment.user?.login.toLowerCase() === expectedLogin,
  );
}

function selectContextComments(
  comments: GitHubComment[],
  botLogin?: string,
): GitHubComment[] {
  return comments
    .filter(
      (comment) =>
        !isManagedTriageComment(comment, botLogin) ||
        !comment.body.startsWith(COMMENT_MARKER_PREFIX),
    )
    .sort((left, right) => left.id - right.id)
    .slice(-50)
    .map((comment) => ({
      ...comment,
      body: truncate(comment.body, 4000),
    }));
}

function requiredBotLogin(
  apply: boolean,
  botLogin?: string,
): string | undefined {
  const normalized = botLogin?.trim();
  if (apply && !normalized) {
    throw new Error("ISSUE_TRIAGE_BOT_LOGIN is required in apply mode");
  }
  return normalized || undefined;
}

function isManagedLabel(label: string, managedPrefixes: string[]): boolean {
  return managedPrefixes.some((prefix) => label.startsWith(prefix));
}

async function ensureLabels(
  github: GitHubIssuesClient,
  repository: string,
  labels: string[],
  policy: TriagePolicy,
): Promise<void> {
  for (const label of labels) {
    await github.ensureLabel(
      repository,
      label,
      policy.labelColors[label] ?? "ededed",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
