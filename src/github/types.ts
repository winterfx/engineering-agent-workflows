export interface GitHubLabel {
  name: string;
}

export interface GitHubUser {
  login: string;
  type?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels: Array<GitHubLabel | string>;
  user?: GitHubUser;
  pull_request?: unknown;
}

export interface GitHubComment {
  id: number;
  body: string;
  user?: GitHubUser;
}

export interface GitHubIssuesWebhook {
  action: string;
  issue: GitHubIssue;
  repository: {
    full_name: string;
    default_branch?: string;
  };
  sender?: GitHubUser;
}

export interface LoaderEventEnvelope {
  topic?: string;
  payload?: {
    body?: unknown;
  };
}

export interface IssueCandidate {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
}

export function labelNames(issue: GitHubIssue): string[] {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label) => label.trim() !== "");
}
