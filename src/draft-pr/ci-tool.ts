import crypto from "node:crypto";
import type { IssueComment } from "../issues/types.js";
import {
  buildCiFixComment,
  findCiFixComment,
  parseCiFixState,
  type CiFixState,
  type CiFixStatus,
} from "./ci-comment.js";
import {
  ciFixSubmissionSchema,
  type CiFixAnalysis,
  type CiFixSubmission,
} from "./ci-schema.js";
import { requiresApproval } from "./policy.js";
import type {
  CheckRun,
  CheckRunAnnotation,
  CiFixProvider,
  DraftPullRequest,
} from "./provider.js";
import {
  assertAllowedRepository,
  repositoryCloneUrl,
  sanitizeTitle,
} from "./repository.js";
import {
  hasConsistentEnvironmentValidationOverride,
  type DraftPrInspection,
} from "./schema.js";
import type { DraftPrToolDependencies } from "./tool.js";
import { DraftPrWorkspaceLockError } from "./workspace.js";

const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "failure",
  "startup_failure",
  "timed_out",
]);
const MAX_ANNOTATIONS_PER_CHECK = 50;

export interface CiFixDependencies extends DraftPrToolDependencies {
  provider: CiFixProvider;
}

export interface CiFailure {
  checkRunId: number;
  name: string;
  conclusion: string;
  htmlUrl?: string;
  output: CheckRun["output"];
  annotations: CheckRunAnnotation[];
}

export interface PreparedCiFix {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  pullRequestNumber: number;
  checkSuiteId: number;
  workspacePath?: string;
  branch?: string;
  baseBranch?: string;
  expectedHeadSha?: string;
  failuresFingerprint?: string;
  previousAttempts?: number;
  failures?: CiFailure[];
}

export interface AppliedCiFix {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  pullRequestNumber: number;
  applied: boolean;
  outcome?: CiFixAnalysis["outcome"] | "failed" | "needs_approval";
  commit?: string;
  inspection?: DraftPrInspection;
}

export async function prepareCiFix(
  repository: string,
  pullRequestNumber: number,
  expectedHeadSha: string,
  checkSuiteId: number,
  dependencies: CiFixDependencies,
): Promise<PreparedCiFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireBotIdentity(dependencies);
  validateEventTarget(expectedHeadSha, checkSuiteId);
  const [pullRequest, comments] = await Promise.all([
    dependencies.provider.getPullRequest(repository, pullRequestNumber),
    dependencies.provider.listComments(repository, pullRequestNumber),
  ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) {
    return skipped(repository, pullRequestNumber, checkSuiteId, reason);
  }
  if (pullRequest.headSha !== expectedHeadSha) {
    return skipped(
      repository,
      pullRequestNumber,
      checkSuiteId,
      "CI event is for a stale Pull Request head",
    );
  }

  const state = ciState(comments, dependencies);
  if (
    state.checkSuiteId === checkSuiteId &&
    ["no-change", "needs-approval"].includes(state.status)
  ) {
    return skipped(
      repository,
      pullRequestNumber,
      checkSuiteId,
      "CI check suite was already processed",
    );
  }
  if (state.attempts >= dependencies.policy.maxFixIterations) {
    if (dependencies.apply) {
      await upsertCiState(
        repository,
        pullRequestNumber,
        {
          checkSuiteId,
          attempts: state.attempts,
          headSha: expectedHeadSha,
          status: "needs-approval",
        },
        comments,
        dependencies,
      );
    }
    return skipped(
      repository,
      pullRequestNumber,
      checkSuiteId,
      "automatic CI fix iteration limit reached",
    );
  }

  const failures = await loadFailures(
    repository,
    expectedHeadSha,
    checkSuiteId,
    dependencies,
  );
  if (failures.length === 0) {
    return skipped(
      repository,
      pullRequestNumber,
      checkSuiteId,
      "check suite has no supported failed checks",
    );
  }

  let prepared;
  try {
    prepared = await dependencies.workspace.prepareReview({
      repository,
      pullRequestNumber,
      cloneUrl: repositoryCloneUrl(dependencies.serverUrl, repository),
      baseBranch: pullRequest.base,
      branch: pullRequest.head,
      expectedHeadSha,
    });
  } catch (error) {
    if (error instanceof DraftPrWorkspaceLockError) {
      return skipped(
        repository,
        pullRequestNumber,
        checkSuiteId,
        "another Pull Request fix run holds the workspace lock",
      );
    }
    throw error;
  }

  if (dependencies.apply) {
    await upsertCiState(
      repository,
      pullRequestNumber,
      {
        checkSuiteId,
        attempts: state.attempts,
        headSha: expectedHeadSha,
        status: "fixing",
      },
      comments,
      dependencies,
    );
  }
  return {
    ok: true,
    repository,
    pullRequestNumber,
    checkSuiteId,
    workspacePath: prepared.path,
    branch: prepared.branch,
    baseBranch: prepared.baseBranch,
    expectedHeadSha: prepared.baseCommit,
    failuresFingerprint: fingerprintFailures(failures),
    previousAttempts: state.attempts,
    failures,
  };
}

export async function applyCiFix(
  repository: string,
  pullRequestNumber: number,
  submissionInput: unknown,
  dependencies: CiFixDependencies,
): Promise<AppliedCiFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireBotIdentity(dependencies);
  const submission = ciFixSubmissionSchema.parse(submissionInput);
  const [pullRequest, comments, failures] = await Promise.all([
    dependencies.provider.getPullRequest(repository, pullRequestNumber),
    dependencies.provider.listComments(repository, pullRequestNumber),
    loadFailures(
      repository,
      submission.expectedHeadSha,
      submission.checkSuiteId,
      dependencies,
    ),
  ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) throw new Error(reason);
  if (pullRequest.headSha !== submission.expectedHeadSha) {
    throw new Error("Pull Request head changed after CI fix preparation");
  }
  const expectedIds = submission.checkRefs.map((value) => value.checkRunId);
  const actualIds = failures.map((value) => value.checkRunId);
  if (
    new Set(expectedIds).size !== expectedIds.length ||
    expectedIds.length !== actualIds.length ||
    expectedIds.some((id, index) => id !== actualIds[index]) ||
    fingerprintFailures(failures) !== submission.failuresFingerprint
  ) {
    throw new Error("failed CI checks changed after fix preparation");
  }

  validateFailureCoverage(submission.analysis, expectedIds);
  const inspection = await dependencies.workspace.inspect(
    submission.workspacePath,
  );
  if (inspection.headCommit !== submission.expectedHeadSha) {
    throw new Error("the Agent committed or moved HEAD in the CI workspace");
  }
  const nextAttempts = submission.previousAttempts + 1;

  if (submission.analysis.outcome !== "fixed") {
    if (inspection.changedFiles.length > 0) {
      throw new Error(
        `${submission.analysis.outcome} CI result contains changes`,
      );
    }
    if (
      submission.analysis.outcome === "no_change" &&
      submission.analysis.failures.some(
        (failure) => failure.disposition !== "not_reproducible",
      )
    ) {
      throw new Error(
        "no_change CI result requires every failure to be not reproducible",
      );
    }
    const status: CiFixStatus =
      submission.analysis.outcome === "needs_approval"
        ? "needs-approval"
        : submission.analysis.outcome === "no_change"
          ? "no-change"
          : "failed";
    await finishWithoutPush(
      repository,
      pullRequestNumber,
      submission,
      nextAttempts,
      status,
      comments,
      dependencies,
    );
    return {
      ok: true,
      repository,
      pullRequestNumber,
      applied: dependencies.apply,
      outcome: submission.analysis.outcome,
      inspection,
    };
  }

  validateFixedAnalysis(submission.analysis, inspection);
  const approvalReasons = requiresApproval(
    submission.analysis,
    inspection,
    false,
    dependencies.policy,
  );
  if (approvalReasons.length > 0) {
    await finishWithoutPush(
      repository,
      pullRequestNumber,
      submission,
      nextAttempts,
      "needs-approval",
      comments,
      dependencies,
    );
    return {
      ok: true,
      repository,
      pullRequestNumber,
      applied: dependencies.apply,
      outcome: "needs_approval",
      inspection,
    };
  }

  if (!dependencies.apply) {
    await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
    return {
      ok: true,
      repository,
      pullRequestNumber,
      applied: false,
      outcome: "fixed",
      inspection,
    };
  }
  const commit = await dependencies.workspace.commitAndPush(
    submission.workspacePath,
    submission.branch,
    sanitizeTitle(submission.analysis.commitTitle),
    repositoryCloneUrl(dependencies.serverUrl, repository),
  );
  await upsertCiState(
    repository,
    pullRequestNumber,
    {
      checkSuiteId: submission.checkSuiteId,
      attempts: nextAttempts,
      headSha: commit,
      status: "fixed",
    },
    comments,
    dependencies,
  );
  await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
  return {
    ok: true,
    repository,
    pullRequestNumber,
    applied: true,
    outcome: "fixed",
    commit,
    inspection,
  };
}

export async function failCiFix(
  repository: string,
  pullRequestNumber: number,
  checkSuiteId: number,
  attempts: number,
  headSha: string,
  dependencies: CiFixDependencies,
): Promise<AppliedCiFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  try {
    if (dependencies.apply) {
      const comments = await dependencies.provider.listComments(
        repository,
        pullRequestNumber,
      );
      await upsertCiState(
        repository,
        pullRequestNumber,
        {
          checkSuiteId,
          attempts,
          headSha,
          status: "failed",
        },
        comments,
        dependencies,
      );
    }
  } finally {
    await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
  }
  return {
    ok: true,
    repository,
    pullRequestNumber,
    applied: dependencies.apply,
    outcome: "failed",
  };
}

async function loadFailures(
  repository: string,
  headSha: string,
  checkSuiteId: number,
  dependencies: CiFixDependencies,
): Promise<CiFailure[]> {
  const runs = (await dependencies.provider.listCheckRuns(repository, headSha))
    .filter(
      (run) =>
        run.checkSuiteId === checkSuiteId &&
        run.status === "completed" &&
        FAILED_CONCLUSIONS.has(run.conclusion ?? ""),
    )
    .sort((left, right) => left.id - right.id);
  if (runs.length > dependencies.policy.maxReviewComments) {
    throw new Error(
      `CI check suite has ${runs.length} failed checks (limit ${dependencies.policy.maxReviewComments})`,
    );
  }
  return Promise.all(
    runs.map(async (run) => ({
      checkRunId: run.id,
      name: run.name,
      conclusion: run.conclusion!,
      ...(run.htmlUrl ? { htmlUrl: run.htmlUrl } : {}),
      output: run.output,
      annotations: (
        await dependencies.provider.listCheckRunAnnotations(repository, run.id)
      ).slice(0, MAX_ANNOTATIONS_PER_CHECK),
    })),
  );
}

function fingerprintFailures(failures: CiFailure[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(failures))
    .digest("hex")
    .slice(0, 20);
}

function validateFailureCoverage(
  analysis: CiFixAnalysis,
  expectedIds: number[],
): void {
  const actual = analysis.failures.map((failure) => failure.checkRunId);
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expectedIds.length ||
    actual.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(
      "CI fix analysis must address every failed check exactly once",
    );
  }
  if (
    analysis.outcome === "fixed" &&
    analysis.failures.some(
      (failure) => failure.disposition === "needs_approval",
    )
  ) {
    throw new Error("fixed CI result cannot contain approval-gated failures");
  }
}

function validateFixedAnalysis(
  analysis: CiFixAnalysis,
  inspection: DraftPrInspection,
): void {
  if (inspection.changedFiles.length === 0) {
    throw new Error("fixed CI result contains no repository changes");
  }
  if (!inspection.diffCheckPassed) {
    throw new Error("CI fix failed git diff --check");
  }
  if (inspection.secretFindingPaths.length > 0) {
    throw new Error("CI fix contains potential credential material");
  }
  if (
    analysis.validationOverride &&
    !hasConsistentEnvironmentValidationOverride(analysis)
  ) {
    throw new Error("fixed CI result has an inconsistent validation override");
  }
  if (
    analysis.tests.some((test) => test.status === "failed") &&
    !hasConsistentEnvironmentValidationOverride(analysis)
  ) {
    throw new Error("fixed CI result reports a failed validation command");
  }
}

function ineligibleReason(
  pullRequest: DraftPullRequest,
  repository: string,
  dependencies: CiFixDependencies,
): string | undefined {
  if (pullRequest.state.toLowerCase() !== "open")
    return "Pull Request is not open";
  if (!pullRequest.head.startsWith(dependencies.policy.branchPrefix)) {
    return "Pull Request branch is not managed by the Draft PR Agent";
  }
  if (
    pullRequest.headRepository?.trim().toLowerCase() !==
    repository.trim().toLowerCase()
  ) {
    return "Pull Request head repository is not the allowlisted repository";
  }
  if (!pullRequest.headSha || !/^[0-9a-f]{40}$/.test(pullRequest.headSha)) {
    return "Pull Request has no valid head SHA";
  }
  return undefined;
}

function validateEventTarget(headSha: string, checkSuiteId: number): void {
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("invalid CI event head SHA");
  }
  if (!Number.isSafeInteger(checkSuiteId) || checkSuiteId <= 0) {
    throw new Error("invalid CI check suite ID");
  }
}

function ciState(
  comments: IssueComment[],
  dependencies: CiFixDependencies,
): CiFixState {
  return parseCiFixState(
    findCiFixComment(comments, dependencies.botLogin?.trim() ?? ""),
  );
}

async function finishWithoutPush(
  repository: string,
  pullRequestNumber: number,
  submission: CiFixSubmission,
  attempts: number,
  status: CiFixStatus,
  comments: IssueComment[],
  dependencies: CiFixDependencies,
): Promise<void> {
  if (dependencies.apply) {
    await upsertCiState(
      repository,
      pullRequestNumber,
      {
        checkSuiteId: submission.checkSuiteId,
        attempts,
        headSha: submission.expectedHeadSha,
        status,
      },
      comments,
      dependencies,
    );
  }
  await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
}

async function upsertCiState(
  repository: string,
  pullRequestNumber: number,
  state: CiFixState,
  comments: IssueComment[],
  dependencies: CiFixDependencies,
): Promise<void> {
  const botLogin = dependencies.botLogin?.trim() ?? "";
  if (!botLogin) throw new Error("GitHub bot login is required in apply mode");
  const existing = findCiFixComment(comments, botLogin);
  const body = buildCiFixComment(state);
  if (existing) {
    await dependencies.provider.updateComment(
      repository,
      pullRequestNumber,
      existing.id,
      body,
    );
  } else {
    await dependencies.provider.createComment(
      repository,
      pullRequestNumber,
      body,
    );
  }
}

function requireBotIdentity(dependencies: CiFixDependencies): void {
  if (dependencies.apply && !dependencies.botLogin?.trim()) {
    throw new Error("GitHub bot login is required for CI fixes in apply mode");
  }
}

function skipped(
  repository: string,
  pullRequestNumber: number,
  checkSuiteId: number,
  reason: string,
): PreparedCiFix {
  return {
    ok: true,
    skipped: true,
    reason,
    repository,
    pullRequestNumber,
    checkSuiteId,
  };
}
