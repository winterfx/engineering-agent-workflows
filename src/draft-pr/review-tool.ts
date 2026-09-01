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
import {
  isTrustedReviewBot,
  requiresApproval,
  type DraftPrPolicy,
} from "./policy.js";
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
  findingFingerprint?: string;
  repeatedFindings?: number;
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
  const [
    pullRequest,
    triggeringReview,
    conversationComments,
    reviewComments,
    reviews,
  ] = await Promise.all([
    dependencies.provider.getPullRequest(repository, pullRequestNumber),
    dependencies.provider.getPullRequestReview(
      repository,
      pullRequestNumber,
      reviewId,
    ),
    dependencies.provider.listComments(repository, pullRequestNumber),
    dependencies.provider.listReviewComments(repository, pullRequestNumber),
    dependencies.provider.listPullRequestReviews(repository, pullRequestNumber),
  ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) return skipped(repository, pullRequestNumber, reason);
  const reviewReason = ineligibleReviewReason(
    triggeringReview,
    pullRequest,
    dependencies.policy,
  );
  if (reviewReason) return skipped(repository, pullRequestNumber, reviewReason);

  const state = reviewState(conversationComments, dependencies);
  if (triggeringReview.id <= state.reviewCursor) {
    return skipped(
      repository,
      pullRequestNumber,
      "Pull Request Review was already processed",
    );
  }
  // Sweep every review still ahead of the cursor, not just the one that
  // triggered this run. A scanner (e.g. monkeyscan[bot]) that fires several
  // independent reviews within seconds of each other can have its later
  // reviews lose the per-Pull-Request workspace lock to whichever review
  // fix run gets there first; that run silently skipping (see the
  // DraftPrWorkspaceLockError handling below) must never be the only chance
  // those later reviews get. Batching by cursor instead of by the single
  // triggering review id means the run that does win the lock picks up
  // every review already visible on the Pull Request, including ones whose
  // own trigger was dropped.
  const eligibleReviews = eligibleReviewsSince(
    reviews,
    pullRequest,
    dependencies.policy,
    state.reviewCursor,
  );
  const findings = findingsForReviews(eligibleReviews, reviewComments);
  if (findings.length === 0) {
    return skipped(repository, pullRequestNumber, "Review has no findings");
  }
  const batchReviewId = Math.max(
    ...eligibleReviews.map((eligibleReview) => eligibleReview.id),
  );
  if (findings.length > dependencies.policy.maxReviewComments) {
    if (dependencies.apply) {
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          ...state,
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
  const findingFingerprint = fingerprintFindingContent(findings);
  const sameAutomatedSequence =
    state.headSha === pullRequest.headSha &&
    state.findingFingerprint === findingFingerprint;
  const repeatedFindings = sameAutomatedSequence
    ? state.repeatedFindings + 1
    : 1;
  if (
    sameAutomatedSequence &&
    state.repeatedFindings >= dependencies.policy.maxFixIterations
  ) {
    if (dependencies.apply) {
      const detail = `The same findings remained after ${dependencies.policy.maxFixIterations} automatic attempts. Further automatic Review fixes are paused until a maintainer intervenes or the scanner reports a different finding.`;
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          reviewCursor: state.reviewCursor,
          iterations: state.iterations,
          headSha: pullRequest.headSha!,
          status: "needs-approval",
          findingFingerprint,
          repeatedFindings: state.repeatedFindings,
        },
        conversationComments,
        dependencies,
        detail,
      );
      await replyToReviewFindings(
        repository,
        pullRequestNumber,
        findings,
        reviewComments,
        "paused",
        pullRequest.headSha!,
        dependencies,
      );
    }
    return skipped(
      repository,
      pullRequestNumber,
      "automatic Review fix limit reached for repeated findings",
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
        findingFingerprint,
        repeatedFindings,
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
    reviewId: batchReviewId,
    reviewFingerprint: fingerprintFindings(findings),
    previousReviewCursor: state.reviewCursor,
    previousIterations: state.iterations,
    findingFingerprint,
    repeatedFindings,
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
  const [pullRequest, conversationComments, reviewComments, reviews] =
    await Promise.all([
      dependencies.provider.getPullRequest(repository, pullRequestNumber),
      dependencies.provider.listComments(repository, pullRequestNumber),
      dependencies.provider.listReviewComments(repository, pullRequestNumber),
      dependencies.provider.listPullRequestReviews(
        repository,
        pullRequestNumber,
      ),
    ]);
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) throw new Error(reason);
  if (pullRequest.headSha !== submission.expectedHeadSha) {
    throw new Error("Pull Request head changed after review fix preparation");
  }
  // Recompute the exact batch prepareReviewFix saw: every review still
  // eligible since the previous cursor, capped at the review id the
  // preparation step batched up to. The fingerprint checks below reject the
  // apply if that batch's contents drifted in the meantime.
  const eligibleReviews = eligibleReviewsSince(
    reviews,
    pullRequest,
    dependencies.policy,
    submission.previousReviewCursor,
  ).filter((eligibleReview) => eligibleReview.id <= submission.reviewId);
  const expectedKeys = submission.findingRefs.map(findingKey);
  const preparedFindings = findingsForReviews(eligibleReviews, reviewComments);
  const persistedState = reviewState(conversationComments, dependencies);
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    preparedFindings.length !== submission.findingRefs.length ||
    preparedFindings.some(
      (value) => !expectedKeys.includes(findingKey(value)),
    ) ||
    fingerprintFindings(preparedFindings) !== submission.reviewFingerprint ||
    fingerprintFindingContent(preparedFindings) !==
      submission.findingFingerprint
  ) {
    throw new Error("Pull Request Review changed after fix preparation");
  }
  if (
    dependencies.apply &&
    (persistedState.reviewCursor !== submission.previousReviewCursor ||
      persistedState.iterations !== submission.previousIterations ||
      persistedState.findingFingerprint !== submission.findingFingerprint ||
      persistedState.repeatedFindings !== submission.repeatedFindings)
  ) {
    throw new Error("Pull Request Review fix state changed after preparation");
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
  const nextStateBase = {
    reviewCursor: nextReviewCursor,
    iterations: nextIterations,
    headSha: submission.expectedHeadSha,
    findingFingerprint: submission.findingFingerprint,
    repeatedFindings: submission.repeatedFindings,
  };

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
      { ...nextStateBase, status },
      conversationComments,
      dependencies,
      reviewOutcomeDetail(
        status,
        submission.reviewId,
        submission.expectedHeadSha,
      ),
    );
    let acknowledgedCommentIds = new Set<number>();
    if (dependencies.apply) {
      acknowledgedCommentIds = await replyToReviewFindings(
        repository,
        pullRequestNumber,
        preparedFindings,
        reviewComments,
        status,
        submission.expectedHeadSha,
        dependencies,
      );
    }
    if (dependencies.apply && status === "no-change") {
      await resolveAddressedThreads(
        repository,
        pullRequestNumber,
        submission.analysis.findings,
        dependencies,
        acknowledgedCommentIds,
      );
    }
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
      { ...nextStateBase, status: "needs-approval" },
      conversationComments,
      dependencies,
      reviewOutcomeDetail(
        "needs-approval",
        submission.reviewId,
        submission.expectedHeadSha,
      ),
    );
    if (dependencies.apply) {
      await replyToReviewFindings(
        repository,
        pullRequestNumber,
        preparedFindings,
        reviewComments,
        "needs-approval",
        submission.expectedHeadSha,
        dependencies,
      );
    }
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
      ...nextStateBase,
      headSha: commit,
      status: "fixed",
    },
    conversationComments,
    dependencies,
    reviewOutcomeDetail("fixed", submission.reviewId, commit),
  );
  await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
  const acknowledgedCommentIds = await replyToReviewFindings(
    repository,
    pullRequestNumber,
    preparedFindings,
    reviewComments,
    "fixed",
    commit,
    dependencies,
  );
  await resolveAddressedThreads(
    repository,
    pullRequestNumber,
    submission.analysis.findings,
    dependencies,
    acknowledgedCommentIds,
  );
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
      const currentState = reviewState(comments, dependencies);
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          ...currentState,
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

export interface PendingReviewFix {
  repository: string;
  pullRequestNumber: number;
  reviewId: number;
}

export interface PendingReviewFixes {
  ok: true;
  pending: PendingReviewFix[];
}

/**
 * Finds bot-managed Draft Pull Requests with a trusted Review still ahead of
 * the stored cursor. Batching by cursor in {@link prepareReviewFix} closes
 * the common case where a burst of reviews collides with the per-Pull-Request
 * workspace lock, but a review whose own trigger is dropped and that is never
 * followed by another review on the same Pull Request would otherwise wait
 * forever for a next webhook that never comes. A periodic sweep that calls
 * this and re-triggers `prepareReviewFix` for anything it finds closes that
 * gap.
 */
export async function listPendingReviewFixes(
  repository: string,
  dependencies: ReviewFixDependencies,
): Promise<PendingReviewFixes> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  const openPullRequests =
    await dependencies.provider.listOpenPullRequests(repository);
  const pending: PendingReviewFix[] = [];
  for (const pullRequest of openPullRequests) {
    if (ineligibleReason(pullRequest, repository, dependencies)) continue;
    const [conversationComments, reviewComments, reviews] = await Promise.all([
      dependencies.provider.listComments(repository, pullRequest.number),
      dependencies.provider.listReviewComments(repository, pullRequest.number),
      dependencies.provider.listPullRequestReviews(
        repository,
        pullRequest.number,
      ),
    ]);
    const state = reviewState(conversationComments, dependencies);
    const eligibleReviews = eligibleReviewsSince(
      reviews,
      pullRequest,
      dependencies.policy,
      state.reviewCursor,
    );
    if (findingsForReviews(eligibleReviews, reviewComments).length === 0) {
      continue;
    }
    pending.push({
      repository,
      pullRequestNumber: pullRequest.number,
      reviewId: Math.max(
        ...eligibleReviews.map((eligibleReview) => eligibleReview.id),
      ),
    });
  }
  return { ok: true, pending };
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

function findingsForReviews(
  reviews: PullRequestReview[],
  reviewComments: PullRequestReviewComment[],
): SourcedFinding[] {
  const findings: SourcedFinding[] = [];
  for (const review of reviews) {
    findings.push(...findingsForReview(review, reviewComments));
  }
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
  policy: DraftPrPolicy,
): string | undefined {
  if (!review.user?.login.trim()) return "Pull Request Review has no author";
  const trustedBot = isTrustedReviewBot(review.user.login, policy);
  const state = review.state.trim().toLowerCase();
  // Review bots (e.g. monkeyscan[bot]) submit findings as GitHub App reviews,
  // which GitHub only lets them post as COMMENTED — they can never use the
  // CHANGES_REQUESTED state a human reviewer would, and they are never a
  // repository collaborator either. Trusted bots get a state exemption in
  // return for tighter identity pinning (exact allowlisted login match).
  if (trustedBot) {
    if (state !== "changes_requested" && state !== "commented") {
      return "Pull Request Review is not a change request or comment";
    }
  } else {
    if (state !== "changes_requested") {
      return "Pull Request Review is not a change request";
    }
    if (!trustedReviewerAssociation(review.authorAssociation)) {
      return "Pull Request Review author is not a trusted repository member";
    }
  }
  if (review.commitId !== pullRequest.headSha) {
    return "Pull Request Review targets a stale head";
  }
  return undefined;
}

function eligibleReviewsSince(
  reviews: PullRequestReview[],
  pullRequest: DraftPullRequest,
  policy: DraftPrPolicy,
  cursor: number,
): PullRequestReview[] {
  return reviews
    .filter((review) => review.id > cursor)
    .filter((review) => !ineligibleReviewReason(review, pullRequest, policy))
    .sort((left, right) => left.id - right.id);
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
  state: ReviewFixState,
  comments: IssueComment[],
  dependencies: ReviewFixDependencies,
  detail?: string,
): Promise<void> {
  if (dependencies.apply) {
    await upsertReviewState(
      repository,
      pullRequestNumber,
      state,
      comments,
      dependencies,
      detail,
    );
  }
  await dependencies.workspace.cleanupReview(repository, pullRequestNumber);
}

type ReviewReplyOutcome = ReviewFixStatus | "paused";

async function replyToReviewFindings(
  repository: string,
  pullRequestNumber: number,
  findings: SourcedFinding[],
  reviewComments: PullRequestReviewComment[],
  outcome: ReviewReplyOutcome,
  headSha: string,
  dependencies: ReviewFixDependencies,
): Promise<Set<number>> {
  const acknowledgedCommentIds = new Set<number>();
  const botLogin = dependencies.botLogin?.trim().toLowerCase();
  if (!botLogin) return acknowledgedCommentIds;
  for (const finding of findings) {
    if (finding.source !== "review_comment") continue;
    const marker = `<!-- engineering-agent-workflows:review-reply:v1 comment=${finding.id} outcome=${outcome} -->`;
    const alreadyReplied = reviewComments.some(
      (comment) =>
        comment.inReplyToId === finding.id &&
        comment.user?.login.trim().toLowerCase() === botLogin &&
        comment.body.startsWith(marker),
    );
    if (alreadyReplied) {
      acknowledgedCommentIds.add(finding.id);
      continue;
    }
    try {
      await dependencies.provider.replyToReviewComment(
        repository,
        pullRequestNumber,
        finding.id,
        `${marker}\n${reviewReplyMessage(outcome, headSha)}`,
      );
      acknowledgedCommentIds.add(finding.id);
    } catch (error) {
      console.error(
        `failed to reply to Review comment ${finding.id} in ${repository}#${pullRequestNumber}: ${errorMessage(error)}`,
      );
    }
  }
  return acknowledgedCommentIds;
}

function reviewReplyMessage(
  outcome: ReviewReplyOutcome,
  headSha: string,
): string {
  const shortSha = headSha.slice(0, 12);
  if (outcome === "fixed")
    return `Addressed by the Draft PR Agent in ${shortSha} after local validation.`;
  if (outcome === "no-change")
    return `Checked by the Draft PR Agent against ${shortSha}; no code change was required.`;
  if (outcome === "needs-approval")
    return "The Draft PR Agent checked this finding but paused for maintainer approval.";
  if (outcome === "paused")
    return "Automatic fixing paused because this finding persisted through the configured repeat limit; maintainer input is needed.";
  return "The Draft PR Agent could not complete this finding automatically; maintainer input is needed.";
}

function reviewOutcomeDetail(
  status: ReviewFixStatus,
  reviewId: number,
  headSha: string,
): string {
  const shortSha = headSha.slice(0, 12);
  if (status === "fixed")
    return `Review ${reviewId} was addressed in commit ${shortSha}. Inline findings, when present, have per-finding follow-up in their threads.`;
  if (status === "no-change")
    return `Review ${reviewId} was checked against ${shortSha}; no code change was required.`;
  if (status === "needs-approval")
    return `Review ${reviewId} requires maintainer approval before the proposed change can proceed.`;
  return `Review ${reviewId} could not be completed automatically.`;
}

async function resolveAddressedThreads(
  repository: string,
  pullRequestNumber: number,
  findings: ReviewFixAnalysis["findings"],
  dependencies: ReviewFixDependencies,
  acknowledgedCommentIds: ReadonlySet<number>,
): Promise<void> {
  const commentIds = findings
    .filter(
      (finding) =>
        finding.source === "review_comment" &&
        acknowledgedCommentIds.has(finding.commentId) &&
        (finding.disposition === "fixed" ||
          finding.disposition === "not_reproducible"),
    )
    .map((finding) => finding.commentId);
  if (commentIds.length === 0) return;
  try {
    await dependencies.provider.resolveReviewThreads(
      repository,
      pullRequestNumber,
      commentIds,
    );
  } catch (error) {
    // Best-effort: the fix itself already landed (commit pushed or verified
    // not reproducible) — a GraphQL hiccup resolving the thread shouldn't
    // fail the whole review-fix run.
    console.error(
      `failed to resolve Review thread comments in ${repository}#${pullRequestNumber}: ${errorMessage(error)}`,
    );
  }
}

async function upsertReviewState(
  repository: string,
  pullRequestNumber: number,
  state: ReviewFixState,
  comments: IssueComment[],
  dependencies: ReviewFixDependencies,
  detail?: string,
): Promise<void> {
  const botLogin = dependencies.botLogin?.trim();
  if (!botLogin)
    throw new Error("Draft PR bot login is required in apply mode");
  const body = buildReviewFixComment(state, detail);
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

function fingerprintFindingContent(findings: SourcedFinding[]): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        findings.map(({ source, body, review, comment }) => ({
          source,
          body: body.trim(),
          author:
            (review?.user ?? comment?.user)?.login.trim().toLowerCase() ?? "",
          ...(comment ? { path: comment.path } : {}),
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
