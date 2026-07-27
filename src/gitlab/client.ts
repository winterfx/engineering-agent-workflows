import type { IssuesClient } from "../issues/client.js";
import { issueSearchText } from "../issues/search.js";
import type { Issue, IssueCandidate, IssueComment } from "../issues/types.js";
import { truncateText } from "../runtime/text.js";
import { isProjectPath } from "../issues/types.js";
import type { GitLabIssueAPI, GitLabNoteAPI } from "./types.js";

export interface GitLabClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class GitLabClient implements IssuesClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: GitLabClientOptions = {}) {
    this.#token = options.token?.trim() ?? "";
    this.#baseUrl = (options.baseUrl ?? "https://gitlab.com/api/v4").replace(
      /\/+$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async getIssue(project: string, issueNumber: number): Promise<Issue> {
    const issue = await this.#request<GitLabIssueAPI>(
      "GET",
      `${projectIssuesPath(project)}/${issueNumber}`,
    );
    return normalizeIssue(issue);
  }

  async searchCandidates(
    project: string,
    issue: Issue,
    limit: number,
  ): Promise<IssueCandidate[]> {
    const title = issueSearchText(issue.title);
    if (!title) return [];
    const query = new URLSearchParams({
      search: title,
      in: "title",
      scope: "all",
      per_page: String(Math.min(Math.max(limit + 1, 1), 100)),
      page: "1",
    });
    const candidates = await this.#request<GitLabIssueAPI[]>(
      "GET",
      `${projectIssuesPath(project)}?${query.toString()}`,
    );
    return candidates
      .filter((candidate) => candidate.iid !== issue.number)
      .slice(0, limit)
      .map((candidate) => ({
        number: candidate.iid,
        title: candidate.title,
        body: truncateText(candidate.description ?? "", 4000),
        state: candidate.state,
        labels: candidate.labels,
        url: candidate.web_url,
      }));
  }

  async listComments(
    project: string,
    issueNumber: number,
  ): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.#rawRequest(
        "GET",
        `${projectIssuesPath(project)}/${issueNumber}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`,
      );
      if (!response.ok) {
        throw await responseError("GET", response.url, response);
      }
      const batch = (await response.json()) as GitLabNoteAPI[];
      comments.push(
        ...batch.filter((note) => !note.system).map(normalizeComment),
      );
      if (!response.headers.get("X-Next-Page") && batch.length < 100) {
        return comments;
      }
    }
  }

  async ensureLabel(
    project: string,
    name: string,
    color: string,
    description?: string,
  ): Promise<void> {
    const path = `/projects/${projectID(project)}/labels/${encodeURIComponent(name)}`;
    const response = await this.#rawRequest("GET", path);
    if (response.ok) return;
    if (response.status !== 404) {
      throw await responseError("GET", path, response);
    }
    await this.#request("POST", `/projects/${projectID(project)}/labels`, {
      name,
      color: normalizeColor(color),
      description:
        description?.trim() || "Managed by engineering-agent-workflows",
    });
  }

  async addLabels(
    project: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    if (labels.length === 0) return;
    await this.#request("PUT", `${projectIssuesPath(project)}/${issueNumber}`, {
      add_labels: labels.join(","),
    });
  }

  async removeLabel(
    project: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    await this.#request("PUT", `${projectIssuesPath(project)}/${issueNumber}`, {
      remove_labels: label,
    });
  }

  async createComment(
    project: string,
    issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    const note = await this.#request<GitLabNoteAPI>(
      "POST",
      `${projectIssuesPath(project)}/${issueNumber}/notes`,
      { body },
    );
    return normalizeComment(note);
  }

  async updateComment(
    project: string,
    issueNumber: number,
    commentID: number,
    body: string,
  ): Promise<IssueComment> {
    const note = await this.#request<GitLabNoteAPI>(
      "PUT",
      `${projectIssuesPath(project)}/${issueNumber}/notes/${commentID}`,
      { body },
    );
    return normalizeComment(note);
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

  #rawRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "engineering-agent-workflows/issue-triage",
    };
    if (this.#token) headers["PRIVATE-TOKEN"] = this.#token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

function projectIssuesPath(project: string): string {
  return `/projects/${projectID(project)}/issues`;
}

function projectID(project: string): string {
  if (!isProjectPath(project)) {
    throw new Error(`invalid GitLab project path: ${project}`);
  }
  return encodeURIComponent(project);
}

function normalizeIssue(issue: GitLabIssueAPI): Issue {
  return {
    number: issue.iid,
    title: issue.title,
    body: issue.description,
    state: issue.state,
    htmlUrl: issue.web_url,
    updatedAt: issue.updated_at,
    labels: issue.labels,
    ...(issue.author
      ? {
          user: {
            login: issue.author.username,
            type: issue.author.bot ? "Bot" : "User",
          },
        }
      : {}),
  };
}

function normalizeComment(note: GitLabNoteAPI): IssueComment {
  return {
    id: note.id,
    body: note.body,
    ...(note.author
      ? {
          user: {
            login: note.author.username,
            type: note.author.bot ? "Bot" : "User",
          },
        }
      : {}),
  };
}

function normalizeColor(color: string): string {
  const normalized = color.trim().replace(/^#/, "");
  return `#${/^[0-9a-f]{6}$/i.test(normalized) ? normalized : "ededed"}`;
}

async function responseError(
  method: string,
  path: string,
  response: Response,
): Promise<Error> {
  const text = await response.text().catch(() => "");
  return new Error(
    `GitLab API ${method} ${path} failed with HTTP ${response.status}: ${truncateText(text, 1000)}`,
  );
}
