export interface GitHubUserAPI {
  login: string;
  id?: number;
  type?: string;
}

export interface GitHubLabelAPI {
  name: string;
}

export interface GitHubIssueAPI {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  labels: Array<GitHubLabelAPI | string>;
  user?: GitHubUserAPI;
  pull_request?: unknown;
}

export interface GitHubCommentAPI {
  id: number;
  body: string;
  html_url?: string;
  created_at?: string;
  user?: GitHubUserAPI;
}

export interface GitHubPullRequestReviewCommentAPI {
  id: number;
  body: string;
  user?: GitHubUserAPI;
  html_url?: string;
  created_at?: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: string;
  start_side?: string;
  diff_hunk?: string;
  commit_id?: string;
  original_commit_id?: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number;
}

export interface GitHubRepositoryAPI {
  default_branch: string;
}

export interface GitHubPullRequestAPI {
  number: number;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha?: string; repo?: { full_name: string } | null };
  base: { ref: string };
}

export interface GitHubCheckRunAPI {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string;
  check_suite?: { id?: number } | null;
  output?: {
    title?: string | null;
    summary?: string | null;
    text?: string | null;
  };
}

export interface GitHubCheckRunAnnotationAPI {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
  title?: string | null;
  raw_details?: string | null;
}
