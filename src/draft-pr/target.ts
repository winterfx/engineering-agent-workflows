import { assertBoundTarget } from "../runtime/target-binding.js";

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
  assertBoundTarget({
    repository,
    targetNumber: pullRequestNumber,
    apply,
    expectedRepository: environment.DRAFT_PR_EXPECTED_REPOSITORY,
    expectedTarget: environment.DRAFT_PR_EXPECTED_PULL_REQUEST,
    errors: {
      missing:
        "Draft PR review apply mode requires a scheduler-bound Pull Request target",
      incomplete: "incomplete scheduler-bound Draft PR review target",
      invalid: "invalid scheduler-bound Draft PR review target",
      mismatch: () =>
        `requested Pull Request ${repository}#${pullRequestNumber} does not match the scheduler-bound review target`,
    },
  });
}

export function assertBoundDraftPrTarget(
  repository: string,
  issueNumber: number,
  apply: boolean,
  environment: DraftPrTargetEnvironment,
): void {
  assertBoundTarget({
    repository,
    targetNumber: issueNumber,
    apply,
    expectedRepository: environment.DRAFT_PR_EXPECTED_REPOSITORY,
    expectedTarget: environment.DRAFT_PR_EXPECTED_ISSUE,
    errors: {
      missing: "Draft PR apply mode requires a scheduler-bound Issue target",
      incomplete: "incomplete scheduler-bound Draft PR target",
      invalid: "invalid scheduler-bound Draft PR target",
      mismatch: () =>
        `requested Issue ${repository}#${issueNumber} does not match the scheduler-bound Draft PR target`,
    },
  });
}
