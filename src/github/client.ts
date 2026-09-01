import type { Issue, IssueCandidate, IssueComment } from "../issues/types.js";
import { issueSearchText } from "../issues/search.js";
import type {
  PullRequest,
  PullRequestReview,
  PullRequestReviewComment,
} from "../pull-requests/types.js";
import { truncateText } from "../runtime/text.js";
import type {
  GitHubCheckRunAnnotationAPI,
  GitHubCheckRunAPI,
  GitHubCommentAPI,
  GitHubIssueAPI,
  GitHubLabelAPI,
  GitHubPullRequestAPI,
  GitHubPullRequestReviewAPI,
  GitHubPullRequestReviewCommentAPI,
  GitHubRepositoryAPI,
} from "./types.js";
import type {
  CheckRun,
  CheckRunAnnotation,
  CiFixProvider,
  ReviewFixProvider,
} from "../draft-pr/provider.js";
import { fetchWithRetry } from "./fetch-retry.js";

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GitHubClient implements CiFixProvider, ReviewFixProvider {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: ((milliseconds: number) => Promise<void>) | undefined;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token?.trim() ?? "";
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep;
  }

  async getIssue(repository: string, issueNumber: number): Promise<Issue> {
    const issue = await this.#request<GitHubIssueAPI>(
      "GET",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}`,
    );
    if (issue.pull_request) {
      throw new Error("GitHub pull request payload is not an Issue");
    }
    return normalizeIssue(issue);
  }

  async searchCandidates(
    repository: string,
    issue: Issue,
    limit: number,
  ): Promise<IssueCandidate[]> {
    const title = issueSearchText(issue.title);
    if (!title) return [];
    const query = new URLSearchParams({
      q: `repo:${repository} is:issue in:title ${title}`,
      per_page: String(Math.min(Math.max(limit + 1, 1), 100)),
    });
    const response = await this.#request<{ items?: GitHubIssueAPI[] }>(
      "GET",
      `/search/issues?${query.toString()}`,
    );
    return (response.items ?? [])
      .filter(
        (candidate) =>
          candidate.number !== issue.number && !candidate.pull_request,
      )
      .slice(0, limit)
      .map((candidate) => ({
        number: candidate.number,
        title: candidate.title,
        body: truncateText(candidate.body ?? "", 4000),
        state: candidate.state,
        labels: labelNames(candidate.labels),
        url: candidate.html_url,
      }));
  }

  async listComments(
    repository: string,
    issueNumber: number,
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request<GitHubCommentAPI[]>(
        "GET",
        `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch.map(normalizeComment));
      if (batch.length < 100) return comments;
    }
  }

  async ensureLabel(
    repository: string,
    name: string,
    color: string,
    description?: string,
  ): Promise<void> {
    const path = `/repos/${repositoryPath(repository)}/labels/${encodeURIComponent(name)}`;
    const response = await this.#rawRequest("GET", path);
    if (response.ok) return;
    if (response.status !== 404) {
      throw await responseError("GET", path, response);
    }
    await this.#request("POST", `/repos/${repositoryPath(repository)}/labels`, {
      name,
      color: normalizeColor(color),
      description:
        description?.trim() || "Managed by engineering-agent-workflows",
    });
  }

  async getRepositoryDefaultBranch(repository: string): Promise<string> {
    const value = await this.#request<GitHubRepositoryAPI>(
      "GET",
      `/repos/${repositoryPath(repository)}`,
    );
    const branch = value.default_branch?.trim();
    if (!branch) throw new Error("GitHub repository has no default branch");
    return branch;
  }

  async getPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequest> {
    const value = await this.#request<GitHubPullRequestAPI>(
      "GET",
      `/repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}`,
    );
    return normalizePullRequest(value);
  }

  async listOpenPullRequests(repository: string): Promise<PullRequest[]> {
    const values: PullRequest[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request<GitHubPullRequestAPI[]>(
        "GET",
        `/repos/${repositoryPath(repository)}/pulls?state=open&per_page=100&page=${page}`,
      );
      values.push(...batch.map(normalizePullRequest));
      if (batch.length < 100) return values;
    }
  }

  async listReviewComments(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReviewComment[]> {
    const comments: PullRequestReviewComment[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request<GitHubPullRequestReviewCommentAPI[]>(
        "GET",
        `/repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch.map(normalizeReviewComment));
      if (batch.length < 100) return comments;
    }
  }

  async getPullRequestReview(
    repository: string,
    pullRequestNumber: number,
    reviewId: number,
  ): Promise<PullRequestReview> {
    const review = await this.#request<GitHubPullRequestReviewAPI>(
      "GET",
      `/repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/reviews/${reviewId}`,
    );
    return normalizePullRequestReview(review);
  }

  async listPullRequestReviews(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request<GitHubPullRequestReviewAPI[]>(
        "GET",
        `/repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`,
      );
      reviews.push(...batch.map(normalizePullRequestReview));
      if (batch.length < 100) return reviews;
    }
  }

  async resolveReviewThreads(
    repository: string,
    pullRequestNumber: number,
    reviewCommentIds: number[],
  ): Promise<void> {
    if (reviewCommentIds.length === 0) return;
    const targetIds = new Set(reviewCommentIds);
    const [owner, name] = repositoryOwnerAndName(repository);
    const threadIds = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const page: GitHubReviewThreadsPageAPI = await this.#graphqlRequest<{
        repository: {
          pullRequest: { reviewThreads: GitHubReviewThreadsPageAPI };
        };
      }>(reviewThreadsQuery, {
        owner,
        name,
        number: pullRequestNumber,
        after,
      }).then((data) => data.repository.pullRequest.reviewThreads);
      for (const thread of page.nodes) {
        if (thread.isResolved) continue;
        if (
          thread.comments.nodes.some(
            (comment) =>
              comment.databaseId !== null && targetIds.has(comment.databaseId),
          )
        ) {
          threadIds.add(thread.id);
        }
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    for (const threadId of threadIds) {
      await this.#graphqlRequest(resolveReviewThreadMutation, { threadId });
    }
  }

  async replyToReviewComment(
    repository: string,
    pullRequestNumber: number,
    reviewCommentId: number,
    body: string,
  ): Promise<PullRequestReviewComment> {
    const comment = await this.#request<GitHubPullRequestReviewCommentAPI>(
      "POST",
      `/repos/${repositoryPath(repository)}/pulls/${pullRequestNumber}/comments/${reviewCommentId}/replies`,
      { body },
    );
    return normalizeReviewComment(comment);
  }

  async listCheckRuns(repository: string, ref: string): Promise<CheckRun[]> {
    if (!/^[0-9a-f]{40}$/.test(ref)) {
      throw new Error("invalid GitHub check run ref");
    }
    const runs: CheckRun[] = [];
    for (let page = 1; ; page += 1) {
      const value = await this.#request<{
        check_runs?: GitHubCheckRunAPI[];
      }>(
        "GET",
        `/repos/${repositoryPath(repository)}/commits/${ref}/check-runs?per_page=100&page=${page}`,
      );
      const batch = value.check_runs ?? [];
      runs.push(...batch.map(normalizeCheckRun));
      if (batch.length < 100) return runs;
    }
  }

  async listCheckRunAnnotations(
    repository: string,
    checkRunId: number,
  ): Promise<CheckRunAnnotation[]> {
    if (!Number.isSafeInteger(checkRunId) || checkRunId <= 0) {
      throw new Error("invalid GitHub check run ID");
    }
    const annotations: CheckRunAnnotation[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.#request<GitHubCheckRunAnnotationAPI[]>(
        "GET",
        `/repos/${repositoryPath(repository)}/check-runs/${checkRunId}/annotations?per_page=100&page=${page}`,
      );
      annotations.push(...batch.map(normalizeCheckRunAnnotation));
      if (batch.length < 100) return annotations;
    }
  }

  async listOpenPullRequestsByHead(
    repository: string,
    branch: string,
  ): Promise<PullRequest[]> {
    const owner = repository.split("/")[0]!;
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${branch}`,
      per_page: "100",
    });
    const values = await this.#request<GitHubPullRequestAPI[]>(
      "GET",
      `/repos/${repositoryPath(repository)}/pulls?${query.toString()}`,
    );
    return values.map(normalizePullRequest);
  }

  async createDraftPullRequest(
    repository: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<PullRequest> {
    const value = await this.#request<GitHubPullRequestAPI>(
      "POST",
      `/repos/${repositoryPath(repository)}/pulls`,
      { ...input, draft: true },
    );
    return normalizePullRequest(value);
  }

  async addLabels(
    repository: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    if (labels.length === 0) return;
    await this.#request(
      "POST",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/labels`,
      { labels },
    );
  }

  async removeLabel(
    repository: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    const path = `/repos/${repositoryPath(repository)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
    const response = await this.#rawRequest("DELETE", path);
    if (!response.ok && response.status !== 404) {
      throw await responseError("DELETE", path, response);
    }
  }

  async createComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    const comment = await this.#request<GitHubCommentAPI>(
      "POST",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
      { body },
    );
    return normalizeComment(comment);
  }

  async updateComment(
    repository: string,
    _issueNumber: number,
    commentID: number,
    body: string,
  ): Promise<IssueComment> {
    const comment = await this.#request<GitHubCommentAPI>(
      "PATCH",
      `/repos/${repositoryPath(repository)}/issues/comments/${commentID}`,
      { body },
    );
    return normalizeComment(comment);
  }

  async #request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#rawRequest(method, path, body);
    if (!response.ok) throw await responseError(method, path, response);
    return (await response.json()) as T;
  }

  async #graphqlRequest<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "engineering-agent-workflows/issue-triage",
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    const response = await fetchWithRetry({
      request: this.#fetch,
      input: `${this.#baseUrl}/graphql`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
      },
      operation: "GitHub GraphQL request",
      retryable: false,
      ...(this.#sleep ? { sleep: this.#sleep } : {}),
    });
    if (!response.ok) throw await responseError("POST", "/graphql", response);
    const payload = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) {
      throw new Error(
        `GitHub GraphQL request failed: ${payload.errors.map((error) => error.message).join("; ")}`,
      );
    }
    if (payload.data === undefined) {
      throw new Error("GitHub GraphQL request returned no data");
    }
    return payload.data;
  }

  #rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "engineering-agent-workflows/issue-triage",
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetchWithRetry({
      request: this.#fetch,
      input: `${this.#baseUrl}${path}`,
      init: {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      operation: `GitHub API ${method} ${path}`,
      retryable: method === "GET",
      ...(this.#sleep ? { sleep: this.#sleep } : {}),
    });
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

function repositoryOwnerAndName(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
  return [parts[0]!, parts[1]!];
}

interface GitHubReviewThreadsPageAPI {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{
    id: string;
    isResolved: boolean;
    comments: { nodes: Array<{ databaseId: number | null }> };
  }>;
}

const reviewThreadsQuery = `
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes { databaseId }
            }
          }
        }
      }
    }
  }
`;

const resolveReviewThreadMutation = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

function normalizeIssue(issue: GitHubIssueAPI): Issue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    htmlUrl: issue.html_url,
    updatedAt: issue.updated_at,
    labels: labelNames(issue.labels),
    ...(issue.user ? { user: normalizeUser(issue.user) } : {}),
  };
}

function normalizeComment(comment: GitHubCommentAPI): IssueComment {
  return {
    id: comment.id,
    body: comment.body,
    ...(comment.html_url ? { htmlUrl: comment.html_url } : {}),
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
    ...(comment.user ? { user: normalizeUser(comment.user) } : {}),
  };
}

function normalizePullRequest(value: GitHubPullRequestAPI): PullRequest {
  return {
    number: value.number,
    url: value.html_url,
    state: value.state,
    draft: value.draft ?? false,
    head: value.head.ref,
    ...(value.head.sha ? { headSha: value.head.sha } : {}),
    ...(value.head.repo?.full_name
      ? { headRepository: value.head.repo.full_name }
      : {}),
    base: value.base.ref,
  };
}

function normalizeReviewComment(
  comment: GitHubPullRequestReviewCommentAPI,
): PullRequestReviewComment {
  return {
    id: comment.id,
    body: comment.body,
    path: comment.path,
    ...(comment.user ? { user: normalizeUser(comment.user) } : {}),
    ...(comment.html_url ? { htmlUrl: comment.html_url } : {}),
    ...(comment.created_at ? { createdAt: comment.created_at } : {}),
    ...(comment.line != null ? { line: comment.line } : {}),
    ...(comment.original_line != null
      ? { originalLine: comment.original_line }
      : {}),
    ...(comment.start_line != null ? { startLine: comment.start_line } : {}),
    ...(comment.original_start_line != null
      ? { originalStartLine: comment.original_start_line }
      : {}),
    ...(comment.side ? { side: comment.side } : {}),
    ...(comment.start_side ? { startSide: comment.start_side } : {}),
    ...(comment.diff_hunk ? { diffHunk: comment.diff_hunk } : {}),
    ...(comment.commit_id ? { commitId: comment.commit_id } : {}),
    ...(comment.original_commit_id
      ? { originalCommitId: comment.original_commit_id }
      : {}),
    ...(comment.in_reply_to_id !== undefined
      ? { inReplyToId: comment.in_reply_to_id }
      : {}),
    ...(comment.pull_request_review_id !== undefined
      ? { pullRequestReviewId: comment.pull_request_review_id }
      : {}),
  };
}

function normalizePullRequestReview(
  review: GitHubPullRequestReviewAPI,
): PullRequestReview {
  return {
    id: review.id,
    body: review.body ?? "",
    state: review.state,
    commitId: review.commit_id,
    authorAssociation: review.author_association,
    ...(review.user ? { user: normalizeUser(review.user) } : {}),
    ...(review.html_url ? { htmlUrl: review.html_url } : {}),
    ...(review.submitted_at ? { submittedAt: review.submitted_at } : {}),
  };
}

function normalizeCheckRun(value: GitHubCheckRunAPI): CheckRun {
  const checkSuiteId = value.check_suite?.id;
  if (!Number.isSafeInteger(checkSuiteId) || checkSuiteId! <= 0) {
    throw new Error(`GitHub check run ${value.id} has no valid check suite ID`);
  }
  return {
    id: value.id,
    checkSuiteId: checkSuiteId!,
    name: truncateText(value.name ?? "", 300),
    status: value.status,
    ...(value.conclusion ? { conclusion: value.conclusion } : {}),
    ...(value.html_url ? { htmlUrl: value.html_url } : {}),
    output: {
      title: truncateText(value.output?.title ?? "", 1000),
      summary: truncateText(value.output?.summary ?? "", 8000),
      text: truncateText(value.output?.text ?? "", 8000),
    },
  };
}

function normalizeCheckRunAnnotation(
  value: GitHubCheckRunAnnotationAPI,
): CheckRunAnnotation {
  return {
    path: truncateText(value.path ?? "", 1000),
    startLine: value.start_line,
    endLine: value.end_line,
    level: truncateText(value.annotation_level ?? "", 50),
    message: truncateText(value.message ?? "", 2000),
    ...(value.title ? { title: truncateText(value.title, 500) } : {}),
    ...(value.raw_details
      ? { rawDetails: truncateText(value.raw_details, 4000) }
      : {}),
  };
}

function normalizeUser(user: { login: string; id?: number; type?: string }) {
  return {
    login: user.login,
    ...(user.id !== undefined ? { id: user.id } : {}),
    ...(user.type ? { type: user.type } : {}),
  };
}

function labelNames(labels: Array<GitHubLabelAPI | string>): string[] {
  return labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label) => label.trim() !== "");
}

function normalizeColor(color: string): string {
  const normalized = color.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(normalized) ? normalized : "ededed";
}

async function responseError(
  method: string,
  path: string,
  response: Response,
): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(
    `GitHub API ${method} ${path} failed with HTTP ${response.status}: ${truncateText(text, 1000)}`,
  );
}
