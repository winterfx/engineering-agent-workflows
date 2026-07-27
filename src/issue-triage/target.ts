import { assertBoundTarget } from "../runtime/target-binding.js";

export interface IssueTargetEnvironment {
  ISSUE_TRIAGE_EXPECTED_REPOSITORY?: string;
  ISSUE_TRIAGE_EXPECTED_ISSUE?: string;
}

export function assertBoundIssueTarget(
  repository: string,
  issueNumber: number,
  apply: boolean,
  environment: IssueTargetEnvironment,
): void {
  assertBoundTarget({
    repository,
    targetNumber: issueNumber,
    apply,
    expectedRepository: environment.ISSUE_TRIAGE_EXPECTED_REPOSITORY,
    expectedTarget: environment.ISSUE_TRIAGE_EXPECTED_ISSUE,
    errors: {
      missing:
        "apply mode requires a scheduler-bound Issue target; set ISSUE_TRIAGE_EXPECTED_REPOSITORY and ISSUE_TRIAGE_EXPECTED_ISSUE",
      incomplete: "incomplete scheduler-bound Issue target",
      invalid: "invalid scheduler-bound Issue target",
      mismatch: (expectedRepository, expectedIssueNumber) =>
        `requested Issue ${repository}#${issueNumber} does not match scheduler-bound target ${expectedRepository}#${expectedIssueNumber}`,
    },
  });
}
