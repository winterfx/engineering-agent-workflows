export interface GitLabUser {
  username: string;
  bot?: boolean;
}

export interface GitLabIssueAPI {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  updated_at: string;
  labels: string[];
  author?: GitLabUser;
}

export interface GitLabNoteAPI {
  id: number;
  body: string;
  system?: boolean;
  author?: GitLabUser;
}

export interface GitLabIssueWebhook {
  object_kind: "issue";
  event_type?: string;
  user?: GitLabUser;
  user_username?: string;
  project: {
    path_with_namespace: string;
    default_branch?: string;
  };
  object_attributes: {
    iid: number;
    action: string;
  };
}

export interface GitLabNoteWebhook {
  object_kind: "note";
  event_type?: string;
  user?: GitLabUser;
  user_username?: string;
  project: {
    path_with_namespace: string;
    default_branch?: string;
  };
  object_attributes: {
    noteable_type: string;
  };
  issue?: {
    iid: number;
  };
}
