import { isProjectPath } from "../issues/types.js";

export interface DraftPrTargetEnvironment {
  DRAFT_PR_EXPECTED_REPOSITORY?: string;
  DRAFT_PR_EXPECTED_ISSUE?: string;
  DRAFT_PR_EXPECTED_PULL_REQUEST?: string;
}

export function assertBoundReviewTarget(
  repository: string,
  pullRequestNumber: number,
  apply: boolean,
  environment: DraftPrTargetEnvironment,
): void {
  const expectedRepository =
    environment.DRAFT_PR_EXPECTED_REPOSITORY?.trim() ?? "";
  const expectedPullRequestText =
    environment.DRAFT_PR_EXPECTED_PULL_REQUEST?.trim() ?? "";
  if (!expectedRepository && !expectedPullRequestText) {
    if (apply) {
      throw new Error(
        "Draft PR review apply mode requires a scheduler-bound Pull Request target",
      );
    }
    return;
  }
  if (!expectedRepository || !expectedPullRequestText) {
    throw new Error("incomplete scheduler-bound Draft PR review target");
  }
  const expectedPullRequestNumber = Number(expectedPullRequestText);
  if (
    !isProjectPath(expectedRepository) ||
    !Number.isSafeInteger(expectedPullRequestNumber) ||
    expectedPullRequestNumber <= 0
  ) {
    throw new Error("invalid scheduler-bound Draft PR review target");
  }
  if (
    repository !== expectedRepository ||
    pullRequestNumber !== expectedPullRequestNumber
  ) {
    throw new Error(
      `requested Pull Request ${repository}#${pullRequestNumber} does not match the scheduler-bound review target`,
    );
  }
}

export function assertBoundDraftPrTarget(
  repository: string,
  issueNumber: number,
  apply: boolean,
  environment: DraftPrTargetEnvironment,
): void {
  const expectedRepository =
    environment.DRAFT_PR_EXPECTED_REPOSITORY?.trim() ?? "";
  const expectedIssueText = environment.DRAFT_PR_EXPECTED_ISSUE?.trim() ?? "";
  if (!expectedRepository && !expectedIssueText) {
    if (apply) {
      throw new Error(
        "Draft PR apply mode requires a scheduler-bound Issue target",
      );
    }
    return;
  }
  if (!expectedRepository || !expectedIssueText) {
    throw new Error("incomplete scheduler-bound Draft PR target");
  }
  const expectedIssueNumber = Number(expectedIssueText);
  if (
    !isProjectPath(expectedRepository) ||
    !Number.isSafeInteger(expectedIssueNumber) ||
    expectedIssueNumber <= 0
  ) {
    throw new Error("invalid scheduler-bound Draft PR target");
  }
  if (
    repository !== expectedRepository ||
    issueNumber !== expectedIssueNumber
  ) {
    throw new Error(
      `requested Issue ${repository}#${issueNumber} does not match the scheduler-bound Draft PR target`,
    );
  }
}
