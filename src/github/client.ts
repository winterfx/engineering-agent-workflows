import type { GitHubComment, GitHubIssue, IssueCandidate } from "./types.js";

export interface GitHubIssueUpdate {
  title?: string;
  labels?: string[];
}

export interface GitHubIssuesClient {
  getIssue(repository: string, issueNumber: number): Promise<GitHubIssue>;
  searchCandidates(
    repository: string,
    issue: GitHubIssue,
    limit: number,
  ): Promise<IssueCandidate[]>;
  listComments(
    repository: string,
    issueNumber: number,
  ): Promise<GitHubComment[]>;
  ensureLabel(repository: string, name: string, color: string): Promise<void>;
  updateIssue(
    repository: string,
    issueNumber: number,
    update: GitHubIssueUpdate,
  ): Promise<GitHubIssue>;
  createComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubComment>;
  updateComment(
    repository: string,
    commentID: number,
    body: string,
  ): Promise<GitHubComment>;
}

export interface GitHubClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class GitHubClient implements GitHubIssuesClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token?.trim() ?? "";
    this.#baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async getIssue(
    repository: string,
    issueNumber: number,
  ): Promise<GitHubIssue> {
    return this.#request<GitHubIssue>(
      "GET",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}`,
    );
  }

  async searchCandidates(
    repository: string,
    issue: GitHubIssue,
    limit: number,
  ): Promise<IssueCandidate[]> {
    const title = searchText(issue.title);
    if (!title) {
      return [];
    }
    const query = new URLSearchParams({
      q: `repo:${repository} is:issue in:title ${title}`,
      per_page: String(Math.min(Math.max(limit + 1, 1), 100)),
    });
    const response = await this.#request<{ items?: GitHubIssue[] }>(
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
        body: truncate(candidate.body ?? "", 4000),
        state: candidate.state,
        labels: candidate.labels.map((label) =>
          typeof label === "string" ? label : label.name,
        ),
        url: candidate.html_url,
      }));
  }

  async listComments(
    repository: string,
    issueNumber: number,
  ): Promise<GitHubComment[]> {
    return this.#request<GitHubComment[]>(
      "GET",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments?per_page=100`,
    );
  }

  async ensureLabel(
    repository: string,
    name: string,
    color: string,
  ): Promise<void> {
    const path = `/repos/${repositoryPath(repository)}/labels/${encodeURIComponent(name)}`;
    const response = await this.#rawRequest("GET", path);
    if (response.ok) {
      return;
    }
    if (response.status !== 404) {
      throw await responseError("GET", path, response);
    }
    await this.#request("POST", `/repos/${repositoryPath(repository)}/labels`, {
      name,
      color,
      description: "Managed by engineering-agent-workflows issue triage",
    });
  }

  async updateIssue(
    repository: string,
    issueNumber: number,
    update: GitHubIssueUpdate,
  ): Promise<GitHubIssue> {
    return this.#request<GitHubIssue>(
      "PATCH",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}`,
      update,
    );
  }

  async createComment(
    repository: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.#request<GitHubComment>(
      "POST",
      `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
      { body },
    );
  }

  async updateComment(
    repository: string,
    commentID: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.#request<GitHubComment>(
      "PATCH",
      `/repos/${repositoryPath(repository)}/issues/comments/${commentID}`,
      { body },
    );
  }

  async #request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#rawRequest(method, path, body);
    if (!response.ok) {
      throw await responseError(method, path, response);
    }
    return (await response.json()) as T;
  }

  #rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "engineering-agent-workflows/issue-triage",
    };
    if (this.#token) {
      headers.Authorization = `Bearer ${this.#token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

function searchText(title: string): string {
  return title
    .replace(/^\[[^\]]+\]\s*:?[\s]*/, "")
    .replace(/["'`:+(){}[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

async function responseError(
  method: string,
  path: string,
  response: Response,
): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(
    `GitHub API ${method} ${path} failed with HTTP ${response.status}: ${truncate(text, 1000)}`,
  );
}
