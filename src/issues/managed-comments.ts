export const ISSUE_TRIAGE_COMMENT_PREFIX =
  "<!-- engineering-agent-workflows:issue-triage:v1";

export function isIssueTriageComment(body: string): boolean {
  return body.startsWith(ISSUE_TRIAGE_COMMENT_PREFIX);
}
