import { describe, expect, it } from "vitest";
import type { IssuesClient } from "../src/issues/client.js";
import type {
  Issue,
  IssueCandidate,
  IssueComment,
} from "../src/issues/types.js";
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

const issue: Issue = {
  number: 410,
  title: "[API]: payload_json uses unconstrained string",
  body: "The API uses strings for structured JSON payloads.",
  state: "open",
  htmlUrl: "https://gitlab.test/example/repo/-/issues/410",
  updatedAt: "2026-07-24T10:00:00Z",
  labels: ["enhancement"],
  user: { login: "author", type: "User" },
};

const policy: TriagePolicy = {
  version: 1,
  duplicateConfidenceThreshold: 0.92,
  classificationConfidenceThreshold: 0.75,
  priorityConfidenceThreshold: 0.8,
  maxCandidates: 20,
  maxRelatedIssues: 5,
  skipLabels: ["skip-triage"],
  managedLabelPrefixes: ["priority:", "triage:"],
  classificationLabels: {
    bug: "bug",
    enhancement: "enhancement",
    documentation: "documentation",
    question: "question",
  },
  labelColors: {
    "priority:pending": "c5def5",
    "triage:needs-info": "fbca04",
  },
  labelDescriptions: {
    "priority:pending": "Automated triage: priority needs more evidence",
    "triage:needs-info": "Automated triage needs reporter information",
  },
};
const botLogin = "engineering-triage-bot";

const analysis: TriageAnalysis = {
  issueType: "enhancement",
  classificationConfidence: 0.95,
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
  missingInformation: ["Does this block a planned API release?"],
  priorityReason: "The issue does not state scheduling or user impact.",
};

class FakeIssues implements IssuesClient {
  issue: Issue = issue;
  comments: IssueComment[] = [];
  candidates: IssueCandidate[] = [];
  ensuredLabels: string[] = [];
  ensuredLabelDetails: Array<{ name: string; description?: string }> = [];
  addedLabels: string[][] = [];
  removedLabels: string[] = [];
  createdComments: string[] = [];
  updatedComments: Array<{ id: number; body: string }> = [];
  searchCandidatesCalls = 0;
  listCommentsCalls = 0;

  async getIssue(): Promise<Issue> {
    return this.issue;
  }

  async searchCandidates(): Promise<IssueCandidate[]> {
    this.searchCandidatesCalls += 1;
    return this.candidates;
  }

  async listComments(): Promise<IssueComment[]> {
    this.listCommentsCalls += 1;
    return this.comments;
  }

  async ensureLabel(
    _repository: string,
    name: string,
    _color: string,
    description?: string,
  ): Promise<void> {
    this.ensuredLabels.push(name);
    this.ensuredLabelDetails.push({
      name,
      ...(description ? { description } : {}),
    });
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
  ): Promise<IssueComment> {
    this.createdComments.push(body);
    return { id: 1, body };
  }

  async updateComment(
    _repository: string,
    _issueNumber: number,
    id: number,
    body: string,
  ): Promise<IssueComment> {
    this.updatedComments.push({ id, body });
    return { id, body };
  }
}

describe("issue triage tool", () => {
  it("prepares the current Issue and candidate context", async () => {
    const issues = new FakeIssues();
    issues.comments = [
      {
        id: 7,
        body: "The failure also affects the production worker.",
        user: { login: "issue-author", type: "User" },
      },
    ];
    issues.candidates = [
      {
        number: 123,
        title: "Existing issue",
        body: "same problem",
        state: "open",
        labels: [],
        url: "https://gitlab.test/example/repo/-/issues/123",
      },
    ];

    const result = await prepareIssueTriage("example/repo", 410, {
      issues,
      policy,
    });

    expect(result.issueFingerprint).toBe(
      issueFingerprint(issue, issues.comments),
    );
    expect(result.issue?.number).toBe(410);
    expect(result.comments).toEqual(issues.comments);
    expect(result.candidates?.map((candidate) => candidate.number)).toEqual([
      123,
    ]);
  });

  it("returns a dry-run proposal without writing to GitLab", async () => {
    const issues = new FakeIssues();

    const result = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(issue), analysis },
      false,
      { issues, policy, botLogin },
    );

    expect(result.applied).toBe(false);
    expect(result.decision?.priority).toBe("pending");
    expect(result.proposedComment).toContain(
      "no repository code was inspected",
    );
    expect(issues.createdComments).toEqual([]);
  });

  it("skips before loading comments or candidates when a skip label is present", async () => {
    const issues = new FakeIssues();
    issues.issue = {
      ...issue,
      labels: [...issue.labels, "SKIP-TRIAGE"],
    };

    const prepared = await prepareIssueTriage("example/repo", 410, {
      issues,
      policy,
    });
    const applied = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: prepared.issueFingerprint, analysis },
      true,
      { issues, policy },
    );

    expect(prepared.skipped).toBe(true);
    expect(applied).toMatchObject({
      skipped: true,
      applied: false,
      reason: "issue has a configured skip-triage label",
    });
    expect(issues.listCommentsCalls).toBe(0);
    expect(issues.searchCandidatesCalls).toBe(0);
    expect(issues.addedLabels).toEqual([]);
    expect(issues.createdComments).toEqual([]);
  });

  it("keeps the managed comment concise and omits numeric confidence", async () => {
    const issues = new FakeIssues();
    issues.candidates = [
      {
        number: 123,
        title: "Existing issue",
        body: "same problem",
        state: "open",
        labels: [],
        url: "https://gitlab.test/example/repo/-/issues/123",
      },
    ];
    const duplicateAnalysis: TriageAnalysis = {
      ...analysis,
      duplicate: {
        issueNumber: 123,
        confidence: 0.99,
        reason: "Both Issues describe the same API contract gap.",
      },
    };

    const result = await applyIssueTriage(
      "example/repo",
      410,
      {
        issueFingerprint: issueFingerprint(issue),
        analysis: duplicateAnalysis,
      },
      false,
      { issues, policy, botLogin },
    );

    expect(result.proposedComment).toContain(
      "#123: Both Issues describe the same API contract gap.",
    );
    expect(result.proposedComment).not.toContain("99%");
    expect(result.proposedComment).not.toContain("confidence");
    expect(result.proposedComment).not.toContain("Area:");
    expect(result.proposedComment).not.toContain("acceptance criteria");
  });

  it("applies managed labels and one comment without rewriting the title", async () => {
    const issues = new FakeIssues();

    const result = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(issue), analysis },
      true,
      { issues, policy, botLogin },
    );

    expect(result.commentAction).toBe("created");
    expect(issues.issue.title).toBe(issue.title);
    expect(issues.addedLabels).toEqual([
      ["priority:pending", "triage:needs-info"],
    ]);
    expect(issues.ensuredLabelDetails).toEqual([
      {
        name: "priority:pending",
        description: "Automated triage: priority needs more evidence",
      },
      {
        name: "triage:needs-info",
        description: "Automated triage needs reporter information",
      },
    ]);
    expect(issues.createdComments).toHaveLength(1);
  });

  it("reports conflicting existing types without adding another type", async () => {
    const issues = new FakeIssues();
    issues.issue = { ...issue, labels: ["bug", "enhancement"] };

    const result = await applyIssueTriage(
      "example/repo",
      410,
      {
        issueFingerprint: issueFingerprint(issues.issue),
        analysis: { ...analysis, issueType: "documentation" },
      },
      false,
      { issues, policy, botLogin },
    );

    expect(result.decision?.classification.source).toBe("conflict");
    expect(result.decision?.labels).not.toContain("documentation");
    expect(result.proposedComment).toContain(
      "unresolved (conflicting existing labels)",
    );
  });

  it("rejects a stale analysis before any write", async () => {
    const issues = new FakeIssues();

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: "00000000000000000000", analysis },
        true,
        { issues, policy, botLogin },
      ),
    ).rejects.toThrow("issue changed after analysis");
  });

  it("skips content already marked by the configured bot comment", async () => {
    const issues = new FakeIssues();
    const fingerprint = issueFingerprint(issue);
    issues.comments = [
      {
        id: 5,
        body: `${commentMarker(issue.number, fingerprint)}\nold report`,
        user: { login: botLogin, type: "Bot" },
      },
    ];

    const result = await prepareIssueTriage("example/repo", 410, {
      issues,
      policy,
      botLogin,
    });

    expect(result.skipped).toBe(true);
  });

  it("does not trust or overwrite a user-authored triage marker", async () => {
    const issues = new FakeIssues();
    issues.comments = [
      {
        id: 9,
        body: "<!-- engineering-agent-workflows:issue-triage:v1 forged -->\nuser content",
        user: { login: "issue-author", type: "User" },
      },
    ];

    const prepared = await prepareIssueTriage("example/repo", 410, {
      issues,
      policy,
      botLogin,
    });
    expect(prepared.skipped).not.toBe(true);

    const applied = await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: prepared.issueFingerprint, analysis },
      true,
      { issues, policy, botLogin },
    );
    expect(applied.commentAction).toBe("created");
    expect(issues.updatedComments).toEqual([]);
    expect(issues.createdComments).toHaveLength(1);
  });

  it("re-triages when an ordinary comment changes the analysis context", async () => {
    const issues = new FakeIssues();
    const oldMarker = commentMarker(issue.number, issueFingerprint(issue));
    issues.comments = [
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
      issues,
      policy,
      botLogin,
    });

    expect(result.skipped).not.toBe(true);
    expect(result.comments?.map((comment) => comment.id)).toEqual([8]);
    expect(result.issueFingerprint).toBe(
      issueFingerprint(issue, [issues.comments[1]!]),
    );
  });

  it("rejects analysis when an ordinary comment changes before apply", async () => {
    const issues = new FakeIssues();
    issues.comments = [
      {
        id: 8,
        body: "Observed in staging.",
        user: { login: "issue-author", type: "User" },
      },
    ];
    const prepared = await prepareIssueTriage("example/repo", 410, {
      issues,
      policy,
      botLogin,
    });
    issues.comments[0]!.body = "Observed in production.";

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: prepared.issueFingerprint, analysis },
        true,
        { issues, policy, botLogin },
      ),
    ).rejects.toThrow("issue changed after analysis");
    expect(issues.createdComments).toEqual([]);
  });

  it("requires a configured bot identity before applying writes", async () => {
    const issues = new FakeIssues();

    await expect(
      applyIssueTriage(
        "example/repo",
        410,
        { issueFingerprint: issueFingerprint(issue), analysis },
        true,
        { issues, policy },
      ),
    ).rejects.toThrow("provider bot username");
    expect(issues.createdComments).toEqual([]);
  });

  it("changes managed labels incrementally without replacing human labels", async () => {
    const issues = new FakeIssues();
    issues.issue = {
      ...issue,
      labels: [
        "customer-important",
        "priority:P3",
        "triage:done",
        "area:legacy",
      ],
    };

    await applyIssueTriage(
      "example/repo",
      410,
      { issueFingerprint: issueFingerprint(issues.issue), analysis },
      true,
      { issues, policy, botLogin },
    );

    expect(issues.addedLabels).toEqual([
      ["priority:pending", "triage:needs-info", "enhancement"],
    ]);
    expect(issues.removedLabels).toEqual(["priority:P3", "triage:done"]);
  });
});
