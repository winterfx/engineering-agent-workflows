import { describe, expect, it } from "vitest";
import type {
  GitHubIssueUpdate,
  GitHubIssuesClient,
} from "../src/github/client.js";
import type {
  GitHubComment,
  GitHubIssue,
  IssueCandidate,
} from "../src/github/types.js";
import {
  commentMarker,
  issueFingerprint,
} from "../src/issue-triage/comment.js";
import type { IssueTriageDefinition } from "../src/issue-triage/definition.js";
import type {
  TriageModel,
  TriageModelInput,
} from "../src/issue-triage/model.js";
import type { TriageAnalysis } from "../src/issue-triage/schema.js";
import { runIssueTriageWorkflow } from "../src/issue-triage/workflow.js";

const issue: GitHubIssue = {
  number: 410,
  title: "[API]: payload_json uses unconstrained string",
  body: "The API uses strings for structured JSON payloads.",
  state: "open",
  html_url: "https://github.test/example/repo/issues/410",
  updated_at: "2026-07-24T10:00:00Z",
  labels: [{ name: "enhancement" }],
  user: { login: "author", type: "User" },
};

const definition: IssueTriageDefinition = {
  policy: {
    version: 1,
    duplicateConfidenceThreshold: 0.92,
    titleConfidenceThreshold: 0.85,
    classificationConfidenceThreshold: 0.75,
    priorityConfidenceThreshold: 0.8,
    maxCandidates: 20,
    maxRelatedIssues: 5,
    managedLabelPrefixes: ["priority:", "triage:", "area:"],
    labelColors: {
      "priority:pending": "c5def5",
      "triage:needs-info": "fbca04",
      "area:api": "1d76db",
    },
  },
  agentText: { instructions: "instructions", prompt: "prompt" },
};

const modelAnalysis: TriageAnalysis = {
  normalizedTitle: "[API] Define structured payload types",
  summary: "The API lacks an explicit contract for structured payloads.",
  issueType: "enhancement",
  area: "api",
  classificationConfidence: 0.95,
  titleConfidence: 0.95,
  priorityConfidence: 0.9,
  facts: {
    environment: "unknown",
    productionImpact: "unknown",
    securityImpact: "none",
    dataLoss: null,
    coreFlowBlocked: null,
    workaround: "unknown",
    affectedScope: "unknown",
    slaRisk: null,
    releaseBlocker: null,
  },
  duplicate: {
    issueNumber: null,
    confidence: 0,
    reason: "No duplicate found.",
  },
  relatedIssues: [],
  acceptanceCriteria: ["Define explicit structured field types."],
  missingInformation: ["Does this block a planned API release?"],
  priorityReason: "The issue does not state scheduling or user impact.",
};

function webhook(sender = "author"): unknown {
  return {
    topic: "webhook.github.issues",
    payload: {
      body: {
        action: "opened",
        issue,
        repository: { full_name: "example/repo", default_branch: "main" },
        sender: { login: sender, type: "User" },
      },
    },
  };
}

class FakeModel implements TriageModel {
  calls = 0;

  async analyze(_input: TriageModelInput): Promise<TriageAnalysis> {
    this.calls += 1;
    return modelAnalysis;
  }
}

class FakeGitHub implements GitHubIssuesClient {
  comments: GitHubComment[] = [];
  candidates: IssueCandidate[] = [];
  ensuredLabels: string[] = [];
  updates: GitHubIssueUpdate[] = [];
  createdComments: string[] = [];
  updatedComments: Array<{ id: number; body: string }> = [];

  async getIssue(): Promise<GitHubIssue> {
    return issue;
  }

  async searchCandidates(): Promise<IssueCandidate[]> {
    return this.candidates;
  }

  async listComments(): Promise<GitHubComment[]> {
    return this.comments;
  }

  async ensureLabel(_repository: string, name: string): Promise<void> {
    this.ensuredLabels.push(name);
  }

  async updateIssue(
    _repository: string,
    _issueNumber: number,
    update: GitHubIssueUpdate,
  ): Promise<GitHubIssue> {
    this.updates.push(update);
    return { ...issue, ...update };
  }

  async createComment(
    _repository: string,
    _issueNumber: number,
    body: string,
  ): Promise<GitHubComment> {
    this.createdComments.push(body);
    return { id: 1, body };
  }

  async updateComment(
    _repository: string,
    id: number,
    body: string,
  ): Promise<GitHubComment> {
    this.updatedComments.push({ id, body });
    return { id, body };
  }
}

describe("runIssueTriageWorkflow", () => {
  it("returns a dry-run proposal without writing to GitHub", async () => {
    const github = new FakeGitHub();
    const model = new FakeModel();

    const result = await runIssueTriageWorkflow(
      webhook(),
      { apply: false },
      { github, model, definition },
    );

    expect(result.applied).toBe(false);
    expect(result.decision?.priority).toBe("pending");
    expect(result.proposedComment).toContain(
      "no repository code was inspected",
    );
    expect(github.updates).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("applies a normalized title, managed labels, and one comment", async () => {
    const github = new FakeGitHub();

    const result = await runIssueTriageWorkflow(
      webhook(),
      { apply: true },
      { github, model: new FakeModel(), definition },
    );

    expect(result.commentAction).toBe("created");
    expect(github.updates).toHaveLength(1);
    expect(github.updates[0]?.title).toBe(
      "[API] Define structured payload types",
    );
    expect(github.updates[0]?.labels).toEqual(
      expect.arrayContaining([
        "enhancement",
        "priority:pending",
        "triage:needs-info",
        "area:api",
      ]),
    );
    expect(github.createdComments).toHaveLength(1);
  });

  it("skips content already marked by the triage comment", async () => {
    const github = new FakeGitHub();
    const fingerprint = issueFingerprint(issue);
    github.comments = [
      {
        id: 5,
        body: `${commentMarker(issue.number, fingerprint)}\nold report`,
      },
    ];
    const model = new FakeModel();

    const result = await runIssueTriageWorkflow(
      webhook(),
      { apply: true },
      { github, model, definition },
    );

    expect(result.skipped).toBe(true);
    expect(model.calls).toBe(0);
  });

  it("ignores events emitted by the configured bot", async () => {
    const github = new FakeGitHub();
    const model = new FakeModel();

    const result = await runIssueTriageWorkflow(
      webhook("triage-bot"),
      { apply: true, botLogin: "triage-bot" },
      { github, model, definition },
    );

    expect(result.ignored).toBe(true);
    expect(model.calls).toBe(0);
    expect(github.updates).toEqual([]);
  });
});
