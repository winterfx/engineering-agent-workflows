import crypto from "node:crypto";
import type { IssueComment } from "../issues/types.js";
import {
  buildReviewFixComment,
  findReviewFixComment,
  parseReviewFixState,
  type ReviewFixState,
  type ReviewFixStatus,
} from "./review-comment.js";
import { requiresApproval } from "./policy.js";
import type {
  DraftPrProvider,
  DraftPullRequest,
  PullRequestReviewComment,
} from "./provider.js";
import {
  reviewFixSubmissionSchema,
  type ReviewCommentSource,
  type ReviewFixAnalysis,
  type ReviewFixSubmission,
} from "./review-schema.js";
import type { DraftPrInspection } from "./schema.js";
import type { DraftPrToolDependencies } from "./tool.js";

export interface ReviewFixDependencies extends DraftPrToolDependencies {
  provider: DraftPrProvider;
  monkeyScanBotLogin: string;
  monkeyScanBotUserId?: number;
}

export interface ReviewFinding {
  source: ReviewCommentSource;
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

interface SourcedComment {
  source: ReviewCommentSource;
  comment: IssueComment | PullRequestReviewComment;
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
  commentsFingerprint?: string;
  previousConversationCursor?: number;
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

export async function listReviewFixTargets(
  repository: string,
  dependencies: ReviewFixDependencies,
): Promise<{
  ok: true;
  repository: string;
  targets: Array<{ pullRequestNumber: number; headSha: string }>;
}> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireReviewIdentities(dependencies);
  const pullRequests =
    await dependencies.provider.listOpenPullRequests(repository);
  const targets: Array<{ pullRequestNumber: number; headSha: string }> = [];
  for (const pullRequest of pullRequests) {
    if (!eligiblePullRequest(pullRequest, repository, dependencies)) continue;
    const [conversationComments, reviewComments] = await Promise.all([
      dependencies.provider.listComments(repository, pullRequest.number),
      dependencies.provider.listReviewComments(repository, pullRequest.number),
    ]);
    const state = reviewState(conversationComments, dependencies);
    if (
      state.iterations < dependencies.policy.maxFixIterations &&
      pendingMonkeyScanComments(
        conversationComments,
        reviewComments,
        state,
        dependencies,
      ).length
    ) {
      targets.push({
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha!,
      });
    }
  }
  return { ok: true, repository, targets };
}

export async function prepareReviewFix(
  repository: string,
  pullRequestNumber: number,
  dependencies: ReviewFixDependencies,
): Promise<PreparedReviewFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireReviewIdentities(dependencies);
  const [pullRequest, conversationComments, reviewComments] = await Promise.all(
    [
      dependencies.provider.getPullRequest(repository, pullRequestNumber),
      dependencies.provider.listComments(repository, pullRequestNumber),
      dependencies.provider.listReviewComments(repository, pullRequestNumber),
    ],
  );
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) return skipped(repository, pullRequestNumber, reason);

  const state = reviewState(conversationComments, dependencies);
  const pending = pendingMonkeyScanComments(
    conversationComments,
    reviewComments,
    state,
    dependencies,
  ).slice(0, dependencies.policy.maxReviewComments);
  if (pending.length === 0) {
    return skipped(
      repository,
      pullRequestNumber,
      "no unprocessed MonkeyScan comments",
    );
  }
  if (state.iterations >= dependencies.policy.maxFixIterations) {
    if (dependencies.apply) {
      await upsertReviewState(
        repository,
        pullRequestNumber,
        {
          conversationCursor: state.conversationCursor,
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
      "automatic MonkeyScan fix iteration limit reached",
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
    if (errorMessage(error).includes("holds the Pull Request lock")) {
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
        conversationCursor: state.conversationCursor,
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
    commentsFingerprint: fingerprintComments(pending),
    previousConversationCursor: state.conversationCursor,
    previousReviewCursor: state.reviewCursor,
    previousIterations: state.iterations,
    findings: pending.map((value) => toFinding(value)),
  };
}

export async function applyReviewFix(
  repository: string,
  pullRequestNumber: number,
  submissionInput: unknown,
  dependencies: ReviewFixDependencies,
): Promise<AppliedReviewFix> {
  assertAllowedRepository(repository, dependencies.allowedRepository);
  requireReviewIdentities(dependencies);
  const submission = reviewFixSubmissionSchema.parse(submissionInput);
  const [pullRequest, conversationComments, reviewComments] = await Promise.all(
    [
      dependencies.provider.getPullRequest(repository, pullRequestNumber),
      dependencies.provider.listComments(repository, pullRequestNumber),
      dependencies.provider.listReviewComments(repository, pullRequestNumber),
    ],
  );
  const reason = ineligibleReason(pullRequest, repository, dependencies);
  if (reason) throw new Error(reason);
  if (pullRequest.headSha !== submission.expectedHeadSha) {
    throw new Error("Pull Request head changed after review fix preparation");
  }
  const expectedKeys = submission.commentRefs.map(commentKey);
  const preparedComments = allMonkeyScanComments(
    conversationComments,
    reviewComments,
    dependencies,
  )
    .filter((value) => expectedKeys.includes(commentKey(value)))
    .sort(compareSourcedComments);
  if (
    new Set(expectedKeys).size !== expectedKeys.length ||
    preparedComments.length !== submission.commentRefs.length ||
    fingerprintComments(preparedComments) !== submission.commentsFingerprint
  ) {
    throw new Error("MonkeyScan comments changed after review fix preparation");
  }

  const inspection = await dependencies.workspace.inspect(
    submission.workspacePath,
  );
  if (inspection.headCommit !== submission.expectedHeadSha) {
    throw new Error(
      "the Agent committed or moved HEAD in the review workspace",
    );
  }
  validateFindingCoverage(submission.analysis, submission.commentRefs);
  const nextIterations = submission.previousIterations + 1;
  const nextConversationCursor = nextCursor(
    "conversation",
    submission.previousConversationCursor,
    submission.commentRefs,
  );
  const nextReviewCursor = nextCursor(
    "review",
    submission.previousReviewCursor,
    submission.commentRefs,
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
      nextConversationCursor,
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
      nextConversationCursor,
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
      conversationCursor: nextConversationCursor,
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
  conversationCursor: number,
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
          conversationCursor,
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

function pendingMonkeyScanComments(
  conversationComments: IssueComment[],
  reviewComments: PullRequestReviewComment[],
  state: Pick<ReviewFixState, "conversationCursor" | "reviewCursor">,
  dependencies: ReviewFixDependencies,
): SourcedComment[] {
  return allMonkeyScanComments(
    conversationComments,
    reviewComments,
    dependencies,
  )
    .filter((value) =>
      value.source === "conversation"
        ? value.comment.id > state.conversationCursor
        : value.comment.id > state.reviewCursor,
    )
    .sort(compareSourcedComments);
}

function allMonkeyScanComments(
  conversationComments: IssueComment[],
  reviewComments: PullRequestReviewComment[],
  dependencies: ReviewFixDependencies,
): SourcedComment[] {
  return [
    ...conversationComments.map((comment) => ({
      source: "conversation" as const,
      comment,
    })),
    ...reviewComments.map((comment) => ({
      source: "review" as const,
      comment,
    })),
  ].filter((value) => isMonkeyScanComment(value.comment, dependencies));
}

function isMonkeyScanComment(
  comment: IssueComment | PullRequestReviewComment,
  dependencies: ReviewFixDependencies,
): boolean {
  const user = comment.user;
  if (
    !user ||
    user.login.trim().toLowerCase() !==
      dependencies.monkeyScanBotLogin.trim().toLowerCase()
  ) {
    return false;
  }
  return (
    dependencies.monkeyScanBotUserId === undefined ||
    user.id === dependencies.monkeyScanBotUserId
  );
}

function eligiblePullRequest(
  pullRequest: DraftPullRequest,
  repository: string,
  dependencies: ReviewFixDependencies,
): boolean {
  return !ineligibleReason(pullRequest, repository, dependencies);
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

function validateFindingCoverage(
  analysis: ReviewFixAnalysis,
  expectedComments: ReviewFixSubmission["commentRefs"],
): void {
  const actual = analysis.findings.map(commentKey);
  const expected = expectedComments.map(commentKey);
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw new Error(
      "review result must address every prepared MonkeyScan comment once",
    );
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
  if (analysis.tests.some((test) => test.status === "failed")) {
    throw new Error("fixed review result reports a failed validation command");
  }
}

async function finishWithoutPush(
  repository: string,
  pullRequestNumber: number,
  conversationCursor: number,
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
      { conversationCursor, reviewCursor, iterations, headSha, status },
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

function fingerprintComments(comments: SourcedComment[]): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        comments.map(({ source, comment }) => ({
          source,
          id: comment.id,
          body: comment.body,
          author: comment.user?.login ?? "",
          authorId: comment.user?.id ?? null,
          ...(source === "review"
            ? {
                path: (comment as PullRequestReviewComment).path,
                line: (comment as PullRequestReviewComment).line ?? null,
                originalLine:
                  (comment as PullRequestReviewComment).originalLine ?? null,
                diffHunk: (comment as PullRequestReviewComment).diffHunk ?? "",
                commitId: (comment as PullRequestReviewComment).commitId ?? "",
              }
            : {}),
        })),
      ),
    )
    .digest("hex")
    .slice(0, 20);
}

function toFinding({ source, comment }: SourcedComment): ReviewFinding {
  const reviewComment =
    source === "review" ? (comment as PullRequestReviewComment) : undefined;
  return {
    source,
    commentId: comment.id,
    body: truncate(comment.body, 4000),
    ...(comment.htmlUrl ? { htmlUrl: comment.htmlUrl } : {}),
    ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
    ...(reviewComment?.path ? { path: reviewComment.path } : {}),
    ...(reviewComment?.line !== undefined ? { line: reviewComment.line } : {}),
    ...(reviewComment?.originalLine !== undefined
      ? { originalLine: reviewComment.originalLine }
      : {}),
    ...(reviewComment?.startLine !== undefined
      ? { startLine: reviewComment.startLine }
      : {}),
    ...(reviewComment?.originalStartLine !== undefined
      ? { originalStartLine: reviewComment.originalStartLine }
      : {}),
    ...(reviewComment?.side ? { side: reviewComment.side } : {}),
    ...(reviewComment?.startSide ? { startSide: reviewComment.startSide } : {}),
    ...(reviewComment?.diffHunk
      ? { diffHunk: truncate(reviewComment.diffHunk, 8000) }
      : {}),
    ...(reviewComment?.commitId ? { commitId: reviewComment.commitId } : {}),
    ...(reviewComment?.originalCommitId
      ? { originalCommitId: reviewComment.originalCommitId }
      : {}),
    ...(reviewComment?.inReplyToId !== undefined
      ? { inReplyToId: reviewComment.inReplyToId }
      : {}),
    ...(reviewComment?.pullRequestReviewId !== undefined
      ? { pullRequestReviewId: reviewComment.pullRequestReviewId }
      : {}),
  };
}

function compareSourcedComments(
  left: SourcedComment,
  right: SourcedComment,
): number {
  return (
    left.comment.id - right.comment.id ||
    left.source.localeCompare(right.source)
  );
}

function commentKey(
  value: SourcedComment | { source: ReviewCommentSource; commentId: number },
): string {
  const commentId = "comment" in value ? value.comment.id : value.commentId;
  return `${value.source}:${commentId}`;
}

function nextCursor(
  source: ReviewCommentSource,
  previous: number,
  comments: ReviewFixSubmission["commentRefs"],
): number {
  return comments
    .filter((comment) => comment.source === source)
    .reduce(
      (maximum, comment) => Math.max(maximum, comment.commentId),
      previous,
    );
}

function skipped(
  repository: string,
  pullRequestNumber: number,
  reason: string,
): PreparedReviewFix {
  return { ok: true, skipped: true, reason, repository, pullRequestNumber };
}

function requireReviewIdentities(dependencies: ReviewFixDependencies): void {
  if (!dependencies.monkeyScanBotLogin.trim()) {
    throw new Error("MonkeyScan bot login is required");
  }
  if (dependencies.apply && !dependencies.botLogin?.trim()) {
    throw new Error("Draft PR bot login is required in apply mode");
  }
  if (
    dependencies.botLogin?.trim().toLowerCase() ===
    dependencies.monkeyScanBotLogin.trim().toLowerCase()
  ) {
    throw new Error(
      "MonkeyScan bot and Draft PR workflow bot must be different identities",
    );
  }
}

function repositoryCloneUrl(serverUrl: string, repository: string): string {
  const base = new URL(serverUrl);
  if (base.protocol !== "https:") {
    throw new Error("GitHub server URL must use HTTPS");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${repository}.git`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function sanitizeTitle(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function assertAllowedRepository(repository: string, allowed: string): void {
  if (!allowed.trim())
    throw new Error("Draft PR repository allowlist is required");
  if (repository.trim().toLowerCase() !== allowed.trim().toLowerCase()) {
    throw new Error("repository is outside the Draft PR allowlist");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
