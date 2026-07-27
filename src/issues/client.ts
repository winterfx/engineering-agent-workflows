import type { Issue, IssueCandidate, IssueComment } from "./types.js";

export interface IssuesClient {
  getIssue(project: string, issueNumber: number): Promise<Issue>;
  searchCandidates(
    project: string,
    issue: Issue,
    limit: number,
  ): Promise<IssueCandidate[]>;
  listComments(project: string, issueNumber: number): Promise<IssueComment[]>;
  ensureLabel(
    project: string,
    name: string,
    color: string,
    description?: string,
  ): Promise<void>;
  addLabels(
    project: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void>;
  removeLabel(
    project: string,
    issueNumber: number,
    label: string,
  ): Promise<void>;
  createComment(
    project: string,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment>;
  updateComment(
    project: string,
    issueNumber: number,
    commentID: number,
    body: string,
  ): Promise<IssueComment>;
}
