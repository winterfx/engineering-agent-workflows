export interface IssueUser {
  login: string;
  id?: number;
  type?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  htmlUrl: string;
  updatedAt: string;
  labels: string[];
  user?: IssueUser;
}

export interface IssueComment {
  id: number;
  body: string;
  htmlUrl?: string;
  createdAt?: string;
  user?: IssueUser;
}

export interface IssueCandidate {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
}

export function isProjectPath(value: string): boolean {
  return /^[^/\s]+(?:\/[^/\s]+)+$/.test(value);
}
