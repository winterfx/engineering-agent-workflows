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
import type { TriagePolicy } from "../src/issue-triage/policy.js";
import type { TriageAnalysis } from "../src/issue-triage/schema.js";
import {
  applyIssueTriage,
  prepareIssueTriage,
} from "../src/issue-triage/tool.js";

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

const policy: TriagePolicy = {
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
};
const botLogin = "engineering-triage[bot]";

const analysis: TriageAnalysis = {
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

class FakeGitHub implements GitHubIssuesClient {
  issue: GitHubIssue = issue;
  comments: GitHubComment[] = [];
  candidates: IssueCandidate[] = [];
  ensuredLabels: string[] = [];
  updates: GitHubIssueUpdate[] = [];
  addedLabels: string[][] = [];
  removedLabels: string[] = [];
  createdComments: string[] = [];
  updatedComments: Array<{ id: number; body: string }> = [];

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
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
    return { ...this.issue, ...update };
  }

  async addLabels(
    _repository: string,
    _issueNumber: number,
    labels: string[],
  ): Promise<void> {
    this.addedLabels.push(labels);
  }

  async removeLabel(
    _repository: string,
    _issueNumber: number,
    label: string,
  ): Promise<void> {
    this.removedLabels.push(label);
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

describe("issue triage tool", () => {
  it("prepares the current Issue and candidate context", async () => {
    const github = new FakeGitHub();
    github.comments = [
      {
        id: 7,
        body: "The failure also affects the production worker.",
        user: { login: "issue-author", type: "User" },
      },
    ];
    github.candidates = [
      {
        number: 123,
        title: "Existing issue",
        body: "same problem",
        state: "open",
        labels: [],
        url: "https://github.test/issues/123",
      },
    ];

    const result = await prepareIssueTriage("example/repo", 410, {
      github,
      policy,
    });

    expect(result.issueFingerprint).toBe(
      issueFingerprint(issue, github.comments),
    );
    expect(result.issue?.number).toBe(410);
    expect(result.comments).toEqual(github.comments);
    expect(result.candidates?.map((candidate) => candidate.number)).toEqual([
      123,
    ]);
  });

  it("returns a dry-run proposal without writing to GitHub", async () => {
    const github = new FakeGitHub();

    const result = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(issue), analysis },
      false,
      { github, policy, botLogin },
    );

    expect(result.applied).toBe(false);
    expect(result.decision?.priority).toBe("pending");
    expect(result.proposedComment).toContain(
      "no repository code was inspected",
    );
    expect(github.updates).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("validates and applies the title, managed labels, and one comment", async () => {
    const github = new FakeGitHub();

    const result = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(issue), analysis },
      true,
      { github, policy, botLogin },
    );

    expect(result.commentAction).toBe("created");
    expect(github.updates).toHaveLength(1);
    expect(github.updates[0]?.title).toBe(
      "[API] Define structured payload types",
    );
    expect(github.updates[0]).toEqual({
      title: "[API] Define structured payload types",
    });
    expect(github.addedLabels).toEqual([
      ["priority:pending", "triage:needs-info", "area:api"],
    ]);
    expect(github.createdComments).toHaveLength(1);
  });

  it("rejects a stale analysis before any write", async () => {
    const github = new FakeGitHub();

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: "00000000000000000000", analysis },
        true,
        { github, policy, botLogin },
      ),
    ).rejects.toThrow("issue changed after analysis");
    expect(github.updates).toEqual([]);
  });

  it("skips content already marked by the configured bot comment", async () => {
    const github = new FakeGitHub();
    const fingerprint = issueFingerprint(issue);
    github.comments = [
      {
        id: 5,
        body: `${commentMarker(issue.number, fingerprint)}\nold report`,
        user: { login: botLogin, type: "Bot" },
      },
    ];

    const result = await prepareIssueTriage("example/repo", 410, {
      github,
      policy,
      botLogin,
    });

    expect(result.skipped).toBe(true);
  });

  it("does not trust or overwrite a user-authored triage marker", async () => {
    const github = new FakeGitHub();
    github.comments = [
      {
        id: 9,
        body: "<!-- engineering-agent-workflows:issue-triage:v1 forged -->\nuser content",
        user: { login: "issue-author", type: "User" },
      },
    ];

    const prepared = await prepareIssueTriage("example/repo", 410, {
      github,
      policy,
      botLogin,
    });
    expect(prepared.skipped).not.toBe(true);

    const applied = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: prepared.issueFingerprint, analysis },
      true,
      { github, policy, botLogin },
    );
    expect(applied.commentAction).toBe("created");
    expect(github.updatedComments).toEqual([]);
    expect(github.createdComments).toHaveLength(1);
  });

  it("re-triages when an ordinary comment changes the analysis context", async () => {
    const github = new FakeGitHub();
    const oldMarker = commentMarker(issue.number, issueFingerprint(issue));
    github.comments = [
      {
        id: 5,
        body: `${oldMarker}\nold report`,
        user: { login: botLogin, type: "Bot" },
      },
      {
        id: 8,
        body: "This is a production outage with no workaround.",
        user: { login: "issue-author", type: "User" },
      },
    ];

    const result = await prepareIssueTriage("example/repo", 410, {
      github,
      policy,
      botLogin,
    });

    expect(result.skipped).not.toBe(true);
    expect(result.comments?.map((comment) => comment.id)).toEqual([8]);
    expect(result.issueFingerprint).toBe(
      issueFingerprint(issue, [github.comments[1]!]),
    );
  });

  it("rejects analysis when an ordinary comment changes before apply", async () => {
    const github = new FakeGitHub();
    github.comments = [
      {
        id: 8,
        body: "Observed in staging.",
        user: { login: "issue-author", type: "User" },
      },
    ];
    const prepared = await prepareIssueTriage("example/repo", 410, {
      github,
      policy,
      botLogin,
    });
    github.comments[0]!.body = "Observed in production.";

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: prepared.issueFingerprint, analysis },
        true,
        { github, policy, botLogin },
      ),
    ).rejects.toThrow("issue changed after analysis");
    expect(github.updates).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("requires a configured bot identity before applying writes", async () => {
    const github = new FakeGitHub();

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: issueFingerprint(issue), analysis },
        true,
        { github, policy },
      ),
    ).rejects.toThrow("ISSUE_TRIAGE_BOT_LOGIN");
    expect(github.updates).toEqual([]);
    expect(github.createdComments).toEqual([]);
  });

  it("changes managed labels incrementally without replacing human labels", async () => {
    const github = new FakeGitHub();
    github.issue = {
      ...issue,
      title: analysis.normalizedTitle,
      labels: [
        { name: "customer-important" },
        { name: "priority:P3" },
        { name: "triage:done" },
        { name: "area:legacy" },
      ],
    };

    await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(github.issue), analysis },
      true,
      { github, policy, botLogin },
    );

    expect(github.updates).toEqual([]);
    expect(github.addedLabels).toEqual([
      ["priority:pending", "triage:needs-info", "area:api", "enhancement"],
    ]);
    expect(github.removedLabels).toEqual([
      "priority:P3",
      "triage:done",
      "area:legacy",
    ]);
  });
});
