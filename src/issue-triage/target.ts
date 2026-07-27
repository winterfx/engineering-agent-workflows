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
  const expectedRepository =
    environment.ISSUE_TRIAGE_EXPECTED_REPOSITORY?.trim() ?? "";
  const expectedIssueText =
    environment.ISSUE_TRIAGE_EXPECTED_ISSUE?.trim() ?? "";

  if (!expectedRepository && !expectedIssueText) {
    if (apply) {
      throw new Error(
        "apply mode requires a scheduler-bound Issue target; set ISSUE_TRIAGE_EXPECTED_REPOSITORY and ISSUE_TRIAGE_EXPECTED_ISSUE",
      );
    }
    return;
  }
  if (!expectedRepository || !expectedIssueText) {
    throw new Error("incomplete scheduler-bound Issue target");
  }

  const expectedIssueNumber = Number(expectedIssueText);
  if (
    !isProjectPath(expectedRepository) ||
    !Number.isSafeInteger(expectedIssueNumber) ||
    expectedIssueNumber <= 0
  ) {
    throw new Error("invalid scheduler-bound Issue target");
  }
  if (
    repository !== expectedRepository ||
    issueNumber !== expectedIssueNumber
  ) {
    throw new Error(
      `requested Issue ${repository}#${issueNumber} does not match scheduler-bound target ${expectedRepository}#${expectedIssueNumber}`,
    );
  }
}
import { isProjectPath } from "../issues/types.js";
