import type { Issue, IssueComment } from "../issues/types.js";
import { issueFingerprint } from "../issues/fingerprint.js";
import { isIssueTriageComment } from "../issues/managed-comments.js";
import { truncateText } from "../runtime/text.js";
import {
  buildDraftPrStatusComment,
  DRAFT_PR_COMMENT_PREFIX,
  findDraftPrComment,
} from "./comment.js";
import {
  hasAnyLabel,
  hasLabel,
  requiresApproval,
  type DraftPrPolicy,
} from "./policy.js";
import type { DraftPrProvider } from "./provider.js";
import {
  assertAllowedRepository,
  repositoryCloneUrl,
  sanitizeTitle,
} from "./repository.js";
import {
  draftPrSubmissionSchema,
  type DraftPrAnalysis,
  type DraftPrInspection,
} from "./schema.js";
import {
  DraftPrWorkspaceLockError,
  type DraftPrWorkspace,
  type PreparedDraftPrWorkspace,
} from "./workspace.js";

export type DraftPrTrigger = "ready" | "approved";

export interface DraftPrToolDependencies {
  provider: DraftPrProvider;
  workspace: DraftPrWorkspace;
  policy: DraftPrPolicy;
  allowedRepository: string;
  serverUrl: string;
  apply: boolean;
  botLogin?: string;
}

export interface PreparedDraftPr {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  issueNumber: number;
  trigger: DraftPrTrigger;
  approved: boolean;
  issueFingerprint?: string;
  issue?: Issue;
  comments?: IssueComment[];
  workspacePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
}

export interface AppliedDraftPr {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  issueNumber: number;
  applied: boolean;
  outcome?: DraftPrAnalysis["outcome"] | "failed" | "needs_approval";
  branch?: string;
  commit?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  proposedTitle?: string;
  proposedBody?: string;
  inspection?: DraftPrInspection;
}

export async function prepareDraftPr(
  repository: string,
  issueNumber: number,
  trigger: DraftPrTrigger,
  dependencies: DraftPrToolDependencies,
): Promise<PreparedDraftPr> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  const issue = await dependencies.provider.getIssue(repository, issueNumber);
  const reason = ineligibleReason(issue, trigger, dependencies.policy);
  if (reason) {
    return {
      ok: true,
      skipped: true,
      reason,
      repository,
      issueNumber,
      trigger,
      approved: trigger === "approved",
    };
  }

  const branch = `${dependencies.policy.branchPrefix}${issueNumber}`;
  const existingPullRequests =
    await dependencies.provider.listOpenPullRequestsByHead(repository, branch);
  if (existingPullRequests.length > 0) {
    return {
      ok: true,
      skipped: true,
      reason: `an open Pull Request already exists for ${branch}`,
      repository,
      issueNumber,
      trigger,
      approved: trigger === "approved",
    };
  }

  const [baseBranch, comments] = await Promise.all([
    dependencies.provider.getRepositoryDefaultBranch(repository),
    dependencies.provider.listComments(repository, issueNumber),
  ]);
  const contextComments = selectContextComments(
    comments,
    dependencies.botLogin,
  );
  const fingerprint = issueFingerprint(issue, contextComments);
  let preparedWorkspace: PreparedDraftPrWorkspace;
  try {
    preparedWorkspace = await dependencies.workspace.prepare({
      repository,
      issueNumber,
      cloneUrl: repositoryCloneUrl(dependencies.serverUrl, repository),
      baseBranch,
      branch,
    });
    if (dependencies.apply) {
      const botLogin = requiredBotLogin(dependencies.botLogin);
      await claimIssue(
        repository,
        issueNumber,
        trigger,
        dependencies,
        botLogin,
      );
    }
  } catch (error) {
    // Lock contention means another run owns both the lock and workspace.
    if (error instanceof DraftPrWorkspaceLockError) {
      return {
        ok: true,
        skipped: true,
        reason: error.message,
        repository,
        issueNumber,
        trigger,
        approved: trigger === "approved",
      };
    }
    await dependencies.workspace.cleanup(repository, issueNumber);
    throw error;
  }

  return {
    ok: true,
    repository,
    issueNumber,
    trigger,
    approved: trigger === "approved",
    issueFingerprint: fingerprint,
    issue,
    comments: contextComments,
    workspacePath: preparedWorkspace.path,
    branch: preparedWorkspace.branch,
    baseBranch: preparedWorkspace.baseBranch,
    baseCommit: preparedWorkspace.baseCommit,
  };
}

export async function applyDraftPr(
  repository: string,
  issueNumber: number,
  submissionInput: unknown,
  dependencies: DraftPrToolDependencies,
): Promise<AppliedDraftPr> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  const submission = draftPrSubmissionSchema.parse(submissionInput);
  const [issue, comments] = await Promise.all([
    dependencies.provider.getIssue(repository, issueNumber),
    dependencies.provider.listComments(repository, issueNumber),
  ]);
  const contextComments = selectContextComments(
    comments,
    dependencies.botLogin,
  );
  if (
    issueFingerprint(issue, contextComments) !== submission.issueFingerprint
  ) {
    throw new Error("Issue changed after the Draft PR Agent started");
  }
  if (issue.state.toLowerCase() !== "open") {
    throw new Error("Issue is no longer open");
  }

  const inspection = await dependencies.workspace.inspect(
    submission.workspacePath,
  );
  if (inspection.headCommit !== submission.baseCommit) {
    throw new Error(
      "the Agent committed or moved HEAD inside the prepared workspace",
    );
  }
  const analysis = submission.analysis;
  if (analysis.outcome !== "implemented") {
    const reasons = outcomeReasons(analysis);
    if (analysis.outcome === "needs_approval") {
      await transitionNeedsApproval(
        repository,
        issueNumber,
        reasons,
        dependencies,
      );
    } else {
      await transitionFailed(repository, issueNumber, reasons, dependencies);
    }
    await dependencies.workspace.cleanup(repository, issueNumber);
    return {
      ok: true,
      repository,
      issueNumber,
      applied: dependencies.apply,
      outcome: analysis.outcome,
      branch: submission.branch,
      inspection,
    };
  }

  validateImplementedAnalysis(analysis, inspection);
  const approvalReasons = requiresApproval(
    analysis,
    inspection,
    submission.trigger === "approved",
    dependencies.policy,
  );
  if (approvalReasons.length > 0) {
    await transitionNeedsApproval(
      repository,
      issueNumber,
      approvalReasons,
      dependencies,
    );
    await dependencies.workspace.cleanup(repository, issueNumber);
    return {
      ok: true,
      repository,
      issueNumber,
      applied: dependencies.apply,
      outcome: "needs_approval",
      branch: submission.branch,
      inspection,
    };
  }

  const title = sanitizeTitle(analysis.prTitle);
  const body = buildPullRequestBody(issueNumber, analysis);
  if (!dependencies.apply) {
    await dependencies.workspace.cleanup(repository, issueNumber);
    return {
      ok: true,
      repository,
      issueNumber,
      applied: false,
      outcome: "implemented",
      branch: submission.branch,
      proposedTitle: title,
      proposedBody: body,
      inspection,
    };
  }

  const commit = await dependencies.workspace.commitAndPush(
    submission.workspacePath,
    submission.branch,
    title,
    repositoryCloneUrl(dependencies.serverUrl, repository),
  );
  const pullRequest = await dependencies.provider.createDraftPullRequest(
    repository,
    {
      title,
      body,
      head: submission.branch,
      base: submission.baseBranch,
    },
  );
  await transitionPullRequestOpen(
    repository,
    issueNumber,
    pullRequest.url,
    dependencies,
  );
  await dependencies.workspace.cleanup(repository, issueNumber);
  return {
    ok: true,
    repository,
    issueNumber,
    applied: true,
    outcome: "implemented",
    branch: submission.branch,
    commit,
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url,
    inspection,
  };
}

export async function failDraftPr(
  repository: string,
  issueNumber: number,
  message: string,
  dependencies: DraftPrToolDependencies,
): Promise<AppliedDraftPr> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  try {
    if (dependencies.apply) {
      await transitionFailed(repository, issueNumber, [message], dependencies);
    }
  } finally {
    await dependencies.workspace.cleanup(repository, issueNumber);
  }
  return {
    ok: true,
    repository,
    issueNumber,
    applied: dependencies.apply,
    outcome: "failed",
  };
}

function ineligibleReason(
  issue: Issue,
  trigger: DraftPrTrigger,
  policy: DraftPrPolicy,
): string | undefined {
  if (issue.state.toLowerCase() !== "open") return "Issue is not open";
  if (hasAnyLabel(issue.labels, policy.skipLabels)) {
    return "Issue has a configured skip label";
  }
  if (hasAnyLabel(issue.labels, policy.blockedLabels)) {
    return "Issue has a label that blocks Draft PR execution";
  }
  const triggerLabel =
    trigger === "approved" ? policy.approvedLabel : policy.readyLabel;
  if (!hasLabel(issue.labels, triggerLabel)) {
    return `Issue does not have ${triggerLabel}`;
  }
  if (
    trigger === "approved" &&
    !hasLabel(issue.labels, policy.needsApprovalLabel)
  ) {
    return `Issue does not have ${policy.needsApprovalLabel}`;
  }
  return undefined;
}

async function claimIssue(
  repository: string,
  issueNumber: number,
  trigger: DraftPrTrigger,
  dependencies: DraftPrToolDependencies,
  botLogin: string,
): Promise<void> {
  const policy = dependencies.policy;
  await ensureWorkflowLabels(repository, [policy.runningLabel], dependencies);
  await dependencies.provider.addLabels(repository, issueNumber, [
    policy.runningLabel,
  ]);
  await dependencies.provider.removeLabel(
    repository,
    issueNumber,
    trigger === "approved" ? policy.approvedLabel : policy.readyLabel,
  );
  await dependencies.provider.removeLabel(
    repository,
    issueNumber,
    policy.failedLabel,
  );
  if (trigger === "approved") {
    await dependencies.provider.removeLabel(
      repository,
      issueNumber,
      policy.needsApprovalLabel,
    );
  }
  await upsertStatusComment(
    repository,
    issueNumber,
    buildDraftPrStatusComment(issueNumber, "running"),
    dependencies,
    botLogin,
  );
}

async function transitionNeedsApproval(
  repository: string,
  issueNumber: number,
  reasons: string[],
  dependencies: DraftPrToolDependencies,
): Promise<void> {
  if (!dependencies.apply) return;
  const botLogin = requiredBotLogin(dependencies.botLogin);
  const policy = dependencies.policy;
  await ensureWorkflowLabels(
    repository,
    [policy.needsApprovalLabel],
    dependencies,
  );
  await dependencies.provider.addLabels(repository, issueNumber, [
    policy.needsApprovalLabel,
  ]);
  await dependencies.provider.removeLabel(
    repository,
    issueNumber,
    policy.runningLabel,
  );
  await upsertStatusComment(
    repository,
    issueNumber,
    buildDraftPrStatusComment(issueNumber, "needs-approval", { reasons }),
    dependencies,
    botLogin,
  );
}

async function transitionFailed(
  repository: string,
  issueNumber: number,
  reasons: string[],
  dependencies: DraftPrToolDependencies,
): Promise<void> {
  if (!dependencies.apply) return;
  const botLogin = requiredBotLogin(dependencies.botLogin);
  const policy = dependencies.policy;
  await ensureWorkflowLabels(repository, [policy.failedLabel], dependencies);
  await dependencies.provider.addLabels(repository, issueNumber, [
    policy.failedLabel,
  ]);
  await dependencies.provider.removeLabel(
    repository,
    issueNumber,
    policy.runningLabel,
  );
  await upsertStatusComment(
    repository,
    issueNumber,
    buildDraftPrStatusComment(issueNumber, "failed", { reasons }),
    dependencies,
    botLogin,
  );
}

async function transitionPullRequestOpen(
  repository: string,
  issueNumber: number,
  pullRequestUrl: string,
  dependencies: DraftPrToolDependencies,
): Promise<void> {
  const botLogin = requiredBotLogin(dependencies.botLogin);
  const policy = dependencies.policy;
  await ensureWorkflowLabels(repository, [policy.prOpenLabel], dependencies);
  await dependencies.provider.addLabels(repository, issueNumber, [
    policy.prOpenLabel,
  ]);
  await dependencies.provider.removeLabel(
    repository,
    issueNumber,
    policy.runningLabel,
  );
  await upsertStatusComment(
    repository,
    issueNumber,
    buildDraftPrStatusComment(issueNumber, "pr-open", { pullRequestUrl }),
    dependencies,
    botLogin,
  );
}

async function ensureWorkflowLabels(
  repository: string,
  labels: string[],
  dependencies: DraftPrToolDependencies,
): Promise<void> {
  for (const label of labels) {
    await dependencies.provider.ensureLabel(
      repository,
      label,
      dependencies.policy.labelColors[label] ?? "ededed",
    );
  }
}

async function upsertStatusComment(
  repository: string,
  issueNumber: number,
  body: string,
  dependencies: DraftPrToolDependencies,
  botLogin: string,
): Promise<void> {
  const comments = await dependencies.provider.listComments(
    repository,
    issueNumber,
  );
  const existing = findDraftPrComment(comments, botLogin);
  if (existing) {
    await dependencies.provider.updateComment(
      repository,
      issueNumber,
      existing.id,
      body,
    );
  } else {
    await dependencies.provider.createComment(repository, issueNumber, body);
  }
}

function selectContextComments(
  comments: IssueComment[],
  botLogin?: string,
): IssueComment[] {
  const expectedBot = botLogin?.trim().toLowerCase();
  return comments
    .filter((comment) => {
      const managedBot =
        expectedBot && comment.user?.login.trim().toLowerCase() === expectedBot;
      return !(
        managedBot &&
        (comment.body.startsWith(DRAFT_PR_COMMENT_PREFIX) ||
          isIssueTriageComment(comment.body))
      );
    })
    .sort((left, right) => left.id - right.id)
    .slice(-50)
    .map((comment) => ({
      ...comment,
      body: truncateText(comment.body, 4000),
    }));
}

function validateImplementedAnalysis(
  analysis: DraftPrAnalysis,
  inspection: DraftPrInspection,
): void {
  if (!sanitizeTitle(analysis.prTitle)) {
    throw new Error("implemented result requires a Pull Request title");
  }
  if (inspection.changedFiles.length === 0) {
    throw new Error(
      "implemented result requires a non-empty repository change",
    );
  }
  if (!inspection.diffCheckPassed) {
    throw new Error("git diff --check rejected the repository change");
  }
  if (inspection.secretFindingPaths.length > 0) {
    throw new Error(
      `possible credential material detected in: ${inspection.secretFindingPaths.join(", ")}`,
    );
  }
  if (analysis.tests.some((test) => test.status === "failed")) {
    throw new Error("implemented result reports a failed validation command");
  }
}

function outcomeReasons(analysis: DraftPrAnalysis): string[] {
  return [
    ...analysis.risk.reasons,
    ...analysis.notes,
    ...analysis.summary,
  ].slice(0, 8);
}

function buildPullRequestBody(
  issueNumber: number,
  analysis: DraftPrAnalysis,
): string {
  const lines = [`Closes #${issueNumber}`, "", "## Summary", ""];
  for (const item of analysis.summary) lines.push(`- ${sanitizeLine(item)}`);
  lines.push("", "## Validation", "");
  if (analysis.tests.length === 0) {
    lines.push("- Not reported.");
  } else {
    for (const test of analysis.tests) {
      lines.push(
        `- \`${sanitizeCode(test.command)}\` — ${test.status}${test.details ? `: ${sanitizeLine(test.details)}` : ""}`,
      );
    }
  }
  lines.push("", "## Risk", "", `- Level: \`${analysis.risk.level}\``);
  for (const reason of analysis.risk.reasons) {
    lines.push(`- ${sanitizeLine(reason)}`);
  }
  if (analysis.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of analysis.notes) lines.push(`- ${sanitizeLine(note)}`);
  }
  lines.push(
    "",
    "_Prepared by the repository development Agent and opened as a Draft Pull Request for maintainer review._",
  );
  return lines.join("\n");
}

function sanitizeLine(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function sanitizeCode(value: string): string {
  return sanitizeLine(value).replace(/`/g, "'");
}

function requiredBotLogin(value?: string): string {
  const normalized = value?.trim();
  if (!normalized)
    throw new Error("Draft PR bot login is required in apply mode");
  return normalized;
}
