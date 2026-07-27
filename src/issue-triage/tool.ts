import type { IssuesClient } from "../issues/client.js";
import { issueFingerprint } from "../issues/fingerprint.js";
import { isIssueTriageComment } from "../issues/managed-comments.js";
import type { Issue, IssueCandidate, IssueComment } from "../issues/types.js";
import { errorMessage } from "../runtime/errors.js";
import { truncateText } from "../runtime/text.js";
import { buildTriageComment, commentMarker } from "./comment.js";
import {
  makeDecision,
  mergeManagedLabels,
  type TriagePolicy,
} from "./policy.js";
import { triageSubmissionSchema, type TriageDecision } from "./schema.js";

export interface IssueTriageToolDependencies {
  issues: IssuesClient;
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
  issue?: Issue;
  comments?: IssueComment[];
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
  const issue = await dependencies.issues.getIssue(repository, issueNumber);
  if (hasSkipLabel(issue.labels, dependencies.policy.skipLabels)) {
    return {
      ok: true,
      skipped: true,
      reason: "issue has a configured skip-triage label",
      repository,
      issueNumber,
      issueFingerprint: issueFingerprint(issue),
    };
  }
  const comments = await dependencies.issues.listComments(
    repository,
    issueNumber,
  );
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
    dependencies.issues,
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
  const issue = await dependencies.issues.getIssue(repository, issueNumber);
  if (hasSkipLabel(issue.labels, dependencies.policy.skipLabels)) {
    return {
      ok: true,
      skipped: true,
      reason: "issue has a configured skip-triage label",
      repository,
      issueNumber,
      applied: false,
    };
  }
  const botLogin = requiredBotLogin(apply, dependencies.botLogin);
  const comments = await dependencies.issues.listComments(
    repository,
    issueNumber,
  );
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
    dependencies.issues,
    repository,
    issue,
    dependencies.policy.maxCandidates,
  );
  const decision = makeDecision(
    submission.analysis,
    candidates,
    dependencies.policy,
    issue.labels,
  );
  const proposedComment = buildTriageComment(
    issueNumber,
    currentFingerprint,
    decision,
  );
  const desiredLabels = mergeManagedLabels(
    issue.labels,
    decision.labels,
    dependencies.policy.managedLabelPrefixes,
  );
  const existingLabels = issue.labels;
  const labelsToAdd = desiredLabels.filter(
    (label) => !existingLabels.includes(label),
  );
  const labelsToRemove = existingLabels.filter(
    (label) =>
      isManagedLabel(label, dependencies.policy.managedLabelPrefixes) &&
      !desiredLabels.includes(label),
  );
  const existingComment = findTriageComment(comments, botLogin);

  if (!apply) {
    return {
      ok: true,
      repository,
      issueNumber,
      applied: false,
      commentAction: "dry-run",
      decision,
      proposedComment,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  await ensureLabels(
    dependencies.issues,
    repository,
    decision.labels,
    dependencies.policy,
  );
  await dependencies.issues.addLabels(repository, issueNumber, labelsToAdd);
  for (const label of labelsToRemove) {
    await dependencies.issues.removeLabel(repository, issueNumber, label);
  }

  let commentAction: AppliedIssueTriage["commentAction"] = "unchanged";
  if (!existingComment) {
    await dependencies.issues.createComment(
      repository,
      issueNumber,
      proposedComment,
    );
    commentAction = "created";
  } else if (existingComment.body !== proposedComment) {
    await dependencies.issues.updateComment(
      repository,
      issueNumber,
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
    commentAction,
    decision,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function loadCandidates(
  issues: IssuesClient,
  repository: string,
  issue: Issue,
  limit: number,
): Promise<{ candidates: IssueCandidate[]; warnings: string[] }> {
  try {
    return {
      candidates: await issues.searchCandidates(repository, issue, limit),
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
  comments: IssueComment[],
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
  comments: IssueComment[],
  botLogin?: string,
): IssueComment | undefined {
  return comments.find(
    (comment) =>
      isManagedTriageComment(comment, botLogin) &&
      isIssueTriageComment(comment.body),
  );
}

function isManagedTriageComment(
  comment: IssueComment,
  botLogin?: string,
): boolean {
  const expectedLogin = botLogin?.trim().toLowerCase();
  return Boolean(
    expectedLogin && comment.user?.login.toLowerCase() === expectedLogin,
  );
}

function selectContextComments(
  comments: IssueComment[],
  botLogin?: string,
): IssueComment[] {
  return comments
    .filter(
      (comment) =>
        !isManagedTriageComment(comment, botLogin) ||
        !isIssueTriageComment(comment.body),
    )
    .sort((left, right) => left.id - right.id)
    .slice(-50)
    .map((comment) => ({
      ...comment,
      body: truncateText(comment.body, 4000),
    }));
}

function requiredBotLogin(
  apply: boolean,
  botLogin?: string,
): string | undefined {
  const normalized = botLogin?.trim();
  if (apply && !normalized) {
    throw new Error("provider bot username is required in apply mode");
  }
  return normalized || undefined;
}

function isManagedLabel(label: string, managedPrefixes: string[]): boolean {
  return managedPrefixes.some((prefix) => label.startsWith(prefix));
}

function hasSkipLabel(labels: string[], skipLabels: string[]): boolean {
  const normalizedSkipLabels = new Set(
    skipLabels.map((label) => label.trim().toLowerCase()),
  );
  return labels.some((label) =>
    normalizedSkipLabels.has(label.trim().toLowerCase()),
  );
}

async function ensureLabels(
  issues: IssuesClient,
  repository: string,
  labels: string[],
  policy: TriagePolicy,
): Promise<void> {
  for (const label of labels) {
    await issues.ensureLabel(
      repository,
      label,
      policy.labelColors[label] ?? "ededed",
      policy.labelDescriptions[label],
    );
  }
}
