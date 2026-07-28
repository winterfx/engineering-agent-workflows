import type { IssueUser } from "../issues/types.js";

export interface PullRequest {
  number: number;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  headSha?: string;
  headRepository?: string;
  base: string;
}

export interface PullRequestReview {
  id: number;
  body: string;
  state: string;
  commitId: string;
  authorAssociation: string;
  user?: IssueUser;
  htmlUrl?: string;
  submittedAt?: string;
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
