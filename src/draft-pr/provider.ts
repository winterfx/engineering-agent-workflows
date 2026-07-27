import type { IssuesClient } from "../issues/client.js";
import type {
  PullRequest,
  PullRequestReviewComment,
} from "../pull-requests/types.js";

export type DraftPullRequest = PullRequest;
export type { PullRequestReviewComment } from "../pull-requests/types.js";

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
