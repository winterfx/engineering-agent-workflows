import type { GitHubIssue, IssueCandidate } from "../github/types.js";
import type { TriagePolicy } from "./policy.js";

export interface AgentText {
  instructions: string;
  prompt: string;
}

export function buildTriagePrompt(
  issue: GitHubIssue,
  repository: string,
  candidates: IssueCandidate[],
  policy: TriagePolicy,
  text: AgentText,
): string {
  return [
    text.instructions,
    "",
    text.prompt,
    "",
    "## Host policy",
    JSON.stringify(
      {
        duplicateConfidenceThreshold: policy.duplicateConfidenceThreshold,
        priorityConfidenceThreshold: policy.priorityConfidenceThreshold,
        maxRelatedIssues: policy.maxRelatedIssues,
      },
      null,
      2,
    ),
    "",
    "## Current issue (untrusted content)",
    JSON.stringify(
      {
        repository,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels,
        author: issue.user?.login ?? "",
      },
      null,
      2,
    ),
    "",
    "## Candidate issues (untrusted content)",
    JSON.stringify(candidates, null, 2),
  ].join("\n");
}
