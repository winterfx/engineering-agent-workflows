import crypto from "node:crypto";
import type { IssueComment } from "../issues/types.js";
import { errorMessage } from "../runtime/errors.js";
import { truncateText } from "../runtime/text.js";
import {
  buildReviewFixComment,
  findReviewFixComment,
  parseReviewFixState,
  type ReviewFixState,
  type ReviewFixStatus,
} from "./review-comment.js";
import { requiresApproval } from "./policy.js";
import type {
  DraftPullRequest,
  PullRequestReview,
  PullRequestReviewComment,
  ReviewFixProvider,
} from "./provider.js";
import {
  assertAllowedRepository,
  repositoryCloneUrl,
  sanitizeTitle,
} from "./repository.js";
import {
  reviewFixSubmissionSchema,
  type ReviewFindingSource,
  type ReviewFixAnalysis,
  type ReviewFixSubmission,
} from "./review-schema.js";
import {
  hasConsistentValidationOverride,
  type DraftPrInspection,
} from "./schema.js";
import type { DraftPrToolDependencies } from "./tool.js";
import { DraftPrWorkspaceLockError } from "./workspace.js";

export interface ReviewFixDependencies extends DraftPrToolDependencies {
  provider: ReviewFixProvider;
}

export interface ReviewFinding {
  source: ReviewFindingSource;
  commentId: number;
  body: string;
  htmlUrl?: string;
  createdAt?: string;
  path?: string;
  line?: number;
  originalLine?: number;
  startLine?: number;
  originalStartLine?: number;
  side?: string;
  startSide?: string;
  diffHunk?: string;
  commitId?: string;
  originalCommitId?: string;
  inReplyToId?: number;
  pullRequestReviewId?: number;
}

interface SourcedFinding {
  source: ReviewFindingSource;
  id: number;
  body: string;
  htmlUrl?: string;
  createdAt?: string;
  review?: PullRequestReview;
  comment?: PullRequestReviewComment;
}

export interface PreparedReviewFix {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  pullRequestNumber: number;
  workspacePath?: string;
  branch?: string;
  baseBranch?: string;
  expectedHeadSha?: string;
  reviewId?: number;
  reviewFingerprint?: string;
  previousReviewCursor?: number;
  previousIterations?: number;
  findings?: ReviewFinding[];
}

export interface AppliedReviewFix {
  ok: true;
  skipped?: boolean;
  reason?: string;
  repository: string;
  pullRequestNumber: number;
  applied: boolean;
  outcome?: ReviewFixAnalysis["outcome"] | "failed" | "needs_approval";
  commit?: string;
  inspection?: DraftPrInspection;
}

export async function prepareReviewFix(
  repository: string,
  pullRequestNumber: number,
  reviewId: number,
  dependencies: ReviewFixDependencies,
): Promise<PreparedReviewFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireReviewBotIdentity(dependencies);
  const [pullRequest, review, conversationComments, reviewComments] =
    await Promise.all([
      dependencies.provider.getPullRequest(repository, pullRequestNumber),
      dependencies.provider.getPullRequestReview(
        repository,
        pullRequestNumber,
        reviewId,
      ),
      dependencies.provider.listComments(repository, pullRequestNumber),
      dependencies.provider.listReviewComments(repository, pullRequestNumber),
    ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) return skipped(repository, pullRequestNumber, reason);
  const reviewReason = ineligibleReviewReason(review, pullRequest);
  if (reviewReason) return skipped(repository, pullRequestNumber, reviewReason);

  const state = reviewState(conversationComments, dependencies);
  if (review.id <= state.reviewCursor) {
    return skipped(
      repository,
      pullRequestNumber,
      "Pull Request Review was already processed",
    );
  }
  const findings = findingsForReview(review, reviewComments);
  if (findings.length === 0) {
    return skipped(repository, pullRequestNumber, "Review has no findings");
  }
  if (findings.length > dependencies.policy.maxReviewComments) {
    if (dependencies.apply) {
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          reviewCursor: state.reviewCursor,
          iterations: state.iterations,
          headSha: pullRequest.headSha!,
          status: "needs-approval",
        },
        conversationComments,
        dependencies,
      );
    }
    return skipped(
      repository,
      pullRequestNumber,
      `Review has ${findings.length} findings, exceeding the automatic limit of ${dependencies.policy.maxReviewComments}`,
    );
  }
  if (state.iterations >= dependencies.policy.maxFixIterations) {
    if (dependencies.apply) {
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          reviewCursor: state.reviewCursor,
          iterations: state.iterations,
          headSha: pullRequest.headSha!,
          status: "needs-approval",
        },
        conversationComments,
        dependencies,
      );
    }
    return skipped(
      repository,
      pullRequestNumber,
      "automatic Review fix iteration limit reached",
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
      expectedHeadSha: pullRequest.headSha!,
    });
  } catch (error) {
    if (error instanceof DraftPrWorkspaceLockError) {
      return skipped(
        repository,
        pullRequestNumber,
        "another review fix run holds the Pull Request lock",
      );
    }
    throw error;
  }

  if (dependencies.apply) {
    await upsertReviewState(
      repository,
      pullRequestNumber,
      {
        reviewCursor: state.reviewCursor,
        iterations: state.iterations,
        headSha: pullRequest.headSha!,
        status: "fixing",
      },
      conversationComments,
      dependencies,
    );
  }
  return {
    ok: true,
    repository,
    pullRequestNumber,
    workspacePath: prepared.path,
    branch: prepared.branch,
    baseBranch: prepared.baseBranch,
    expectedHeadSha: prepared.baseCommit,
    reviewId: review.id,
    reviewFingerprint: fingerprintFindings(findings),
    previousReviewCursor: state.reviewCursor,
    previousIterations: state.iterations,
    findings: findings.map((value) => toFinding(value)),
  };
}

export async function applyReviewFix(
  repository: string,
  pullRequestNumber: number,
  submissionInput: unknown,
  dependencies: ReviewFixDependencies,
): Promise<AppliedReviewFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireReviewBotIdentity(dependencies);
  const submission = reviewFixSubmissionSchema.parse(submissionInput);
  const [pullRequest, review, conversationComments, reviewComments] =
    await Promise.all([
      dependencies.provider.getPullRequest(repository, pullRequestNumber),
      dependencies.provider.getPullRequestReview(
        repository,
        pullRequestNumber,
        submission.reviewId,
      ),
      dependencies.provider.listComments(repository, pullRequestNumber),
      dependencies.provider.listReviewComments(repository, pullRequestNumber),
    ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) throw new Error(reason);
  const reviewReason = ineligibleReviewReason(review, pullRequest);
  if (reviewReason) throw new Error(reviewReason);
  if (pullRequest.headSha !== submission.expectedHeadSha) {
    throw new Error("Pull Request head changed after review fix preparation");
  }
  const expectedKeys = submission.findingRefs.map(findingKey);
  const preparedFindings = findingsForReview(review, reviewComments);
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    preparedFindings.length !== submission.findingRefs.length ||
    preparedFindings.some(
      (value) => !expectedKeys.includes(findingKey(value)),
    ) ||
    fingerprintFindings(preparedFindings) !== submission.reviewFingerprint
  ) {
    throw new Error("Pull Request Review changed after fix preparation");
  }

  const inspection = await dependencies.workspace.inspect(
    submission.workspacePath,
  );
  if (inspection.headCommit !== submission.expectedHeadSha) {
    throw new Error(
      "the Agent committed or moved HEAD in the review workspace",
    );
  }
  validateFindingCoverage(submission.analysis, submission.findingRefs);
  const nextIterations = submission.previousIterations + 1;
  const nextReviewCursor = Math.max(
    submission.previousReviewCursor,
    submission.reviewId,
  );

  if (submission.analysis.outcome !== "fixed") {
    if (
      submission.analysis.outcome === "no_change" &&
      inspection.changedFiles.length > 0
    ) {
      throw new Error("no_change review result contains repository changes");
    }
    const status: ReviewFixStatus =
      submission.analysis.outcome === "needs_approval"
        ? "needs-approval"
        : submission.analysis.outcome === "no_change"
          ? "no-change"
          : "failed";
    await finishWithoutPush(
      repository,
      pullRequestNumber,
      nextReviewCursor,
      nextIterations,
      submission.expectedHeadSha,
      status,
      conversationComments,
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

  validateFixedReview(submission.analysis, inspection);
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
      nextReviewCursor,
      nextIterations,
      submission.expectedHeadSha,
      "needs-approval",
      conversationComments,
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
  const commitTitle = sanitizeTitle(submission.analysis.commitTitle);
  const commit = await dependencies.workspace.commitAndPush(
    submission.workspacePath,
    submission.branch,
    commitTitle,
    repositoryCloneUrl(dependencies.serverUrl, repository),
  );
  await upsertReviewState(
    repository,
    pullRequestNumber,
    {
      reviewCursor: nextReviewCursor,
      iterations: nextIterations,
      headSha: commit,
      status: "fixed",
    },
    conversationComments,
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

export async function failReviewFix(
  repository: string,
  pullRequestNumber: number,
  reviewCursor: number,
  iterations: number,
  headSha: string,
  dependencies: ReviewFixDependencies,
): Promise<AppliedReviewFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  try {
    if (dependencies.apply) {
      const comments = await dependencies.provider.listComments(
        repository,
        pullRequestNumber,
      );
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          reviewCursor,
          iterations,
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

function findingsForReview(
  review: PullRequestReview,
  reviewComments: PullRequestReviewComment[],
): SourcedFinding[] {
  const findings: SourcedFinding[] = [];
  if (review.body.trim()) {
    findings.push({
      source: "review",
      id: review.id,
      body: review.body,
      ...(review.htmlUrl ? { htmlUrl: review.htmlUrl } : {}),
      ...(review.submittedAt ? { createdAt: review.submittedAt } : {}),
      review,
    });
  }
  findings.push(
    ...reviewComments
      .filter(
        (comment) =>
          comment.pullRequestReviewId === review.id &&
          !comment.inReplyToId &&
          sameUser(comment.user, review.user),
      )
      .map((comment) => ({
        source: "review_comment" as const,
        id: comment.id,
        body: comment.body,
        ...(comment.htmlUrl ? { htmlUrl: comment.htmlUrl } : {}),
        ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
        comment,
      })),
  );
  return findings.sort(compareSourcedFindings);
}

function ineligibleReason(
  pullRequest: DraftPullRequest,
  repository: string,
  dependencies: ReviewFixDependencies,
): string | undefined {
  if (pullRequest.state.toLowerCase() !== "open")
    return "Pull Request is not open";
  if (!pullRequest.draft) return "Pull Request is not a Draft";
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

function ineligibleReviewReason(
  review: PullRequestReview,
  pullRequest: DraftPullRequest,
): string | undefined {
  if (review.state.trim().toLowerCase() !== "changes_requested") {
    return "Pull Request Review is not a change request";
  }
  if (!review.user?.login.trim()) return "Pull Request Review has no author";
  if (!trustedReviewerAssociation(review.authorAssociation)) {
    return "Pull Request Review author is not a trusted repository member";
  }
  if (review.commitId !== pullRequest.headSha) {
    return "Pull Request Review targets a stale head";
  }
  return undefined;
}

function trustedReviewerAssociation(value: string): boolean {
  return ["owner", "member", "collaborator"].includes(
    value.trim().toLowerCase(),
  );
}

function sameUser(
  left: PullRequestReviewComment["user"],
  right: PullRequestReview["user"],
): boolean {
  if (!left || !right) return false;
  if (left.id !== undefined && right.id !== undefined)
    return left.id === right.id;
  return left.login.trim().toLowerCase() === right.login.trim().toLowerCase();
}

function validateFindingCoverage(
  analysis: ReviewFixAnalysis,
  expectedFindings: ReviewFixSubmission["findingRefs"],
): void {
  const actual = analysis.findings.map(findingKey);
  const expected = expectedFindings.map(findingKey);
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw new Error("review result must address every prepared finding once");
  }
  if (
    analysis.outcome === "fixed" &&
    analysis.findings.some(
      (finding) => finding.disposition === "needs_approval",
    )
  ) {
    throw new Error(
      "fixed review result cannot contain approval-gated findings",
    );
  }
  if (
    analysis.outcome === "no_change" &&
    analysis.findings.some(
      (finding) => finding.disposition !== "not_reproducible",
    )
  ) {
    throw new Error(
      "no_change review result requires every finding to be not reproducible",
    );
  }
}

function validateFixedReview(
  analysis: ReviewFixAnalysis,
  inspection: DraftPrInspection,
): void {
  if (!sanitizeTitle(analysis.commitTitle)) {
    throw new Error("fixed review result requires a commit title");
  }
  if (inspection.changedFiles.length === 0) {
    throw new Error("fixed review result requires a non-empty change");
  }
  if (!inspection.diffCheckPassed) {
    throw new Error("git diff --check rejected the review fix");
  }
  if (inspection.secretFindingPaths.length > 0) {
    throw new Error(
      `possible credential material detected in: ${inspection.secretFindingPaths.join(", ")}`,
    );
  }
  if (
    analysis.validationOverride &&
    !hasConsistentValidationOverride(analysis)
  ) {
    throw new Error(
      "fixed review result has an inconsistent validation override",
    );
  }
  if (
    analysis.tests.some((test) => test.status === "failed") &&
    !hasConsistentValidationOverride(analysis)
  ) {
    throw new Error("fixed review result reports a failed validation command");
  }
}

async function finishWithoutPush(
  repository: string,
  pullRequestNumber: number,
  reviewCursor: number,
  iterations: number,
  headSha: string,
  status: ReviewFixStatus,
  comments: IssueComment[],
  dependencies: ReviewFixDependencies,
): Promise<void> {
  if (dependencies.apply) {
    await upsertReviewState(
      repository,
      pullRequestNumber,
      { reviewCursor, iterations, headSha, status },
      comments,
      dependencies,
    );
  }
  await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
}

async function upsertReviewState(
  repository: string,
  pullRequestNumber: number,
  state: ReviewFixState,
  comments: IssueComment[],
  dependencies: ReviewFixDependencies,
): Promise<void> {
  const botLogin = dependencies.botLogin?.trim();
  if (!botLogin)
    throw new Error("Draft PR bot login is required in apply mode");
  const body = buildReviewFixComment(state);
  const existing = findReviewFixComment(comments, botLogin);
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

function reviewState(
  comments: IssueComment[],
  dependencies: ReviewFixDependencies,
): ReviewFixState {
  const botLogin = dependencies.botLogin?.trim();
  if (!botLogin) return parseReviewFixState(undefined);
  return parseReviewFixState(findReviewFixComment(comments, botLogin));
}

function fingerprintFindings(findings: SourcedFinding[]): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        findings.map(({ source, id, body, review, comment }) => ({
          source,
          id,
          body,
          author: (review?.user ?? comment?.user)?.login ?? "",
          authorId: (review?.user ?? comment?.user)?.id ?? null,
          ...(review
            ? {
                state: review.state,
                commitId: review.commitId,
                authorAssociation: review.authorAssociation,
              }
            : {}),
          ...(comment
            ? {
                path: comment.path,
                line: comment.line ?? null,
                originalLine: comment.originalLine ?? null,
                diffHunk: comment.diffHunk ?? "",
                commitId: comment.commitId ?? "",
              }
            : {}),
        })),
      ),
    )
    .digest("hex")
    .slice(0, 20);
}

function toFinding({
  source,
  id,
  body,
  htmlUrl,
  createdAt,
  comment,
}: SourcedFinding): ReviewFinding {
  return {
    source,
    commentId: id,
    body: truncateText(body, 4000),
    ...(htmlUrl ? { htmlUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(comment?.path ? { path: comment.path } : {}),
    ...(comment?.line !== undefined ? { line: comment.line } : {}),
    ...(comment?.originalLine !== undefined
      ? { originalLine: comment.originalLine }
      : {}),
    ...(comment?.startLine !== undefined
      ? { startLine: comment.startLine }
      : {}),
    ...(comment?.originalStartLine !== undefined
      ? { originalStartLine: comment.originalStartLine }
      : {}),
    ...(comment?.side ? { side: comment.side } : {}),
    ...(comment?.startSide ? { startSide: comment.startSide } : {}),
    ...(comment?.diffHunk
      ? { diffHunk: truncateText(comment.diffHunk, 8000) }
      : {}),
    ...(comment?.commitId ? { commitId: comment.commitId } : {}),
    ...(comment?.originalCommitId
      ? { originalCommitId: comment.originalCommitId }
      : {}),
    ...(comment?.inReplyToId !== undefined
      ? { inReplyToId: comment.inReplyToId }
      : {}),
    ...(comment?.pullRequestReviewId !== undefined
      ? { pullRequestReviewId: comment.pullRequestReviewId }
      : {}),
  };
}

function compareSourcedFindings(
  left: SourcedFinding,
  right: SourcedFinding,
): number {
  const sourceOrder = { review: 0, review_comment: 1 };
  return (
    sourceOrder[left.source] - sourceOrder[right.source] || left.id - right.id
  );
}

function findingKey(
  value: SourcedFinding | { source: ReviewFindingSource; commentId: number },
): string {
  const commentId = "id" in value ? value.id : value.commentId;
  return `${value.source}:${commentId}`;
}

function skipped(
  repository: string,
  pullRequestNumber: number,
  reason: string,
): PreparedReviewFix {
  return { ok: true, skipped: true, reason, repository, pullRequestNumber };
}

function requireReviewBotIdentity(dependencies: ReviewFixDependencies): void {
  if (dependencies.apply && !dependencies.botLogin?.trim()) {
    throw new Error("Draft PR bot login is required in apply mode");
  }
}
