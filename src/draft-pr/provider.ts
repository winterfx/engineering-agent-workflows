import type { IssuesClient } from "../issues/client.js";
import type { IssueUser } from "../issues/types.js";

export interface DraftPullRequest {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  headSha?: string;
  headRepository?: string;
  base: string;
}

export interface PullRequestReviewComment {
  id: number;
  body: string;
  user?: IssueUser;
  htmlUrl?: string;
  createdAt?: string;
  path: string;
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

export interface DraftPrProvider extends IssuesClient {
  getRepositoryDefaultBranch(repository: string): Promise<string>;
  getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<DraftPullRequest>;
  listOpenPullRequests(repository: string): Promise<DraftPullRequest[]>;
  listReviewComments(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReviewComment[]>;
  listOpenPullRequestsByHead(
    repository: string,
    branch: string,
  ): Promise<DraftPullRequest[]>;
  createDraftPullRequest(
    repository: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<DraftPullRequest>;
}
