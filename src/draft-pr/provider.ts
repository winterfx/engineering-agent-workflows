import type { IssuesClient } from "../issues/client.js";
import type {
  PullRequest,
  PullRequestReview,
  PullRequestReviewComment,
} from "../pull-requests/types.js";

export type DraftPullRequest = PullRequest;
export type {
  PullRequestReview,
  PullRequestReviewComment,
} from "../pull-requests/types.js";

export interface CheckRunAnnotation {
  path: string;
  startLine: number;
  endLine: number;
  level: string;
  message: string;
  title?: string;
  rawDetails?: string;
}

export interface CheckRun {
  id: number;
  checkSuiteId: number;
  name: string;
  status: string;
  conclusion?: string;
  htmlUrl?: string;
  output: {
    title: string;
    summary: string;
    text: string;
  };
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

export interface ReviewFixProvider extends DraftPrProvider {
  getPullRequestReview(
    repository: string,
    pullRequestNumber: number,
    reviewId: number,
  ): Promise<PullRequestReview>;
}

export interface CiFixProvider extends DraftPrProvider {
  listCheckRuns(repository: string, ref: string): Promise<CheckRun[]>;
  listCheckRunAnnotations(
    repository: string,
    checkRunId: number,
  ): Promise<CheckRunAnnotation[]>;
}
