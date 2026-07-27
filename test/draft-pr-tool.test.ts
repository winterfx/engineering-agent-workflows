import { describe, expect, it } from "vitest";
import type { DraftPrPolicy } from "../src/draft-pr/policy.js";
import type {
  DraftPrProvider,
  DraftPullRequest,
} from "../src/draft-pr/provider.js";
import type {
  DraftPrAnalysis,
  DraftPrInspection,
} from "../src/draft-pr/schema.js";
import { applyDraftPr, prepareDraftPr } from "../src/draft-pr/tool.js";
import {
  DraftPrWorkspaceLockError,
  type DraftPrWorkspace,
  type PreparedDraftPrWorkspace,
} from "../src/draft-pr/workspace.js";
import type {
  Issue,
  IssueCandidate,
  IssueComment,
} from "../src/issues/types.js";

const botLogin = "engineering-agent-bot";
const repository = "chaitin/agent-compose";
const issue: Issue = {
  number: 439,
  title: "Webhook insert can commit before the request fails",
  body: "The endpoint can report HTTP 500 after the INSERT commits.",
  state: "open",
  htmlUrl: "https://github.test/chaitin/agent-compose/issues/439",
  updatedAt: "2026-07-26T12:00:00Z",
  labels: ["bug", "agent:ready"],
  user: { login: "reporter", type: "User" },
};
const policy: DraftPrPolicy = {
  version: 1,
  readyLabel: "agent:ready",
  approvedLabel: "agent:approved",
  runningLabel: "agent:running",
  needsApprovalLabel: "agent:needs-approval",
  prOpenLabel: "agent:pr-open",
  failedLabel: "agent:failed",
  skipLabels: ["skip-triage"],
  blockedLabels: ["duplicate", "agent:pr-open", "agent:running"],
  branchPrefix: "codex/issue-",
  maxChangedFiles: 40,
  maxChangedLines: 1500,
  maxReviewComments: 50,
  maxFixIterations: 3,
  approvalPathPrefixes: [".github/workflows/", "migrations/"],
  labelColors: {
    "agent:running": "fbca04",
    "agent:needs-approval": "d93f0b",
    "agent:pr-open": "5319e7",
    "agent:failed": "b60205",
  },
};
const analysis: DraftPrAnalysis = {
  outcome: "implemented",
  prTitle: "fix(webhooks): return the committed event without rereading",
  summary: ["Return the normalized event after the INSERT commits."],
  tests: [
    {
      command: "go test ./pkg/webhooks/...",
      status: "passed",
      details: "Regression test passed.",
    },
  ],
  risk: { level: "low", reasons: ["Storage behavior is covered by tests."] },
  notes: [],
};

class FakeProvider implements DraftPrProvider {
  issue: Issue = { ...issue, labels: [...issue.labels] };
  comments: IssueComment[] = [];
  pullRequests: DraftPullRequest[] = [];
  ensuredLabels: string[] = [];
  addedLabels: string[][] = [];
  removedLabels: string[] = [];
  createdPullRequests: Array<{
    title: string;
    body: string;
    head: string;
    base: string;
  }> = [];

  async getIssue(): Promise<Issue> {
    return { ...this.issue, labels: [...this.issue.labels] };
  }
  async searchCandidates(): Promise<IssueCandidate[]> {
    return [];
  }
  async listComments(): Promise<IssueComment[]> {
    return this.comments.map((comment) => ({ ...comment }));
  }
  async ensureLabel(_repository: string, name: string): Promise<void> {
    this.ensuredLabels.push(name);
  }
  async addLabels(
    _repository: string,
    _issueNumber: number,
    labels: string[],
  ): Promise<void> {
    this.addedLabels.push(labels);
    this.issue.labels = [...new Set([...this.issue.labels, ...labels])];
  }
  async removeLabel(
    _repository: string,
    _issueNumber: number,
    label: string,
  ): Promise<void> {
    this.removedLabels.push(label);
    this.issue.labels = this.issue.labels.filter((value) => value !== label);
  }
  async createComment(
    _repository: string,
    _issueNumber: number,
    body: string,
  ): Promise<IssueComment> {
    const comment = {
      id: this.comments.length + 1,
      body,
      user: { login: botLogin, type: "Bot" },
    };
    this.comments.push(comment);
    return comment;
  }
  async updateComment(
    _repository: string,
    _issueNumber: number,
    commentID: number,
    body: string,
  ): Promise<IssueComment> {
    const comment = this.comments.find((value) => value.id === commentID)!;
    comment.body = body;
    return { ...comment };
  }
  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }
  async getPullRequest(): Promise<DraftPullRequest> {
    return this.pullRequests[0]!;
  }
  async listOpenPullRequests(): Promise<DraftPullRequest[]> {
    return this.pullRequests;
  }
  async listReviewComments(): Promise<[]> {
    return [];
  }
  async listOpenPullRequestsByHead(): Promise<DraftPullRequest[]> {
    return this.pullRequests;
  }
  async createDraftPullRequest(
    _repository: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<DraftPullRequest> {
    this.createdPullRequests.push(input);
    return {
      number: 440,
      url: "https://github.test/chaitin/agent-compose/pull/440",
      state: "open",
      draft: true,
      head: input.head,
      base: input.base,
    };
  }
}

class FakeWorkspace implements DraftPrWorkspace {
  prepareCalls = 0;
  inspectCalls = 0;
  commitCalls = 0;
  cleanupCalls = 0;
  prepareError?: Error;
  inspection: DraftPrInspection = {
    headCommit: "a".repeat(40),
    changedFiles: ["pkg/webhooks/store.go", "pkg/webhooks/store_test.go"],
    additions: 24,
    deletions: 8,
    diffCheckPassed: true,
    secretFindingPaths: [],
  };

  async prepare(input: {
    branch: string;
    baseBranch: string;
  }): Promise<PreparedDraftPrWorkspace> {
    this.prepareCalls += 1;
    if (this.prepareError) throw this.prepareError;
    return {
      path: "/draft-pr-workspaces/repositories/repo/issue-439",
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseCommit: "a".repeat(40),
    };
  }
  async prepareReview(input: {
    branch: string;
    baseBranch: string;
  }): Promise<PreparedDraftPrWorkspace> {
    return this.prepare(input);
  }
  async inspect(): Promise<DraftPrInspection> {
    this.inspectCalls += 1;
    return this.inspection;
  }
  async commitAndPush(
    _workspacePath: string,
    _branch: string,
    _title: string,
    _cloneUrl: string,
  ): Promise<string> {
    this.commitCalls += 1;
    return "b".repeat(40);
  }
  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
  }
  async cleanupReview(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

function dependencies(
  provider: FakeProvider,
  workspace: FakeWorkspace,
  apply = true,
) {
  return {
    provider,
    workspace,
    policy,
    allowedRepository: repository,
    serverUrl: "https://github.test",
    apply,
    botLogin,
  };
}

function submission(prepared: Awaited<ReturnType<typeof prepareDraftPr>>) {
  return {
    issueFingerprint: prepared.issueFingerprint!,
    trigger: prepared.trigger,
    workspacePath: prepared.workspacePath!,
    branch: prepared.branch!,
    baseBranch: prepared.baseBranch!,
    baseCommit: prepared.baseCommit!,
    analysis,
  };
}

describe("Draft PR tool", () => {
  it("does not clean another run's workspace when the Issue lock is held", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    workspace.prepareError = new DraftPrWorkspaceLockError("Issue");

    const result = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      dependencies(provider, workspace),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe(
      "another Draft PR run already holds the Issue lock",
    );
    expect(workspace.prepareCalls).toBe(1);
    expect(workspace.cleanupCalls).toBe(0);
  });

  it("skips Issues carrying skip-triage before preparing a workspace", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    provider.issue.labels.push("SKIP-TRIAGE");

    const result = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      dependencies(provider, workspace),
    );

    expect(result.skipped).toBe(true);
    expect(workspace.prepareCalls).toBe(0);
    expect(provider.addedLabels).toEqual([]);
  });

  it("claims agent:ready and creates one Draft Pull Request", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);

    const prepared = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      deps,
    );
    const result = await applyDraftPr(
      repository,
      issue.number,
      submission(prepared),
      deps,
    );

    expect(prepared.skipped).not.toBe(true);
    expect(provider.issue.labels).not.toContain("agent:ready");
    expect(provider.issue.labels).not.toContain("agent:running");
    expect(provider.issue.labels).toContain("agent:pr-open");
    expect(workspace.commitCalls).toBe(1);
    expect(workspace.cleanupCalls).toBe(1);
    expect(provider.createdPullRequests).toEqual([
      expect.objectContaining({
        title: analysis.prTitle,
        head: "codex/issue-439",
        base: "main",
      }),
    ]);
    expect(provider.createdPullRequests[0]?.body).toContain("Closes #439");
    expect(result.pullRequestUrl).toContain("/pull/440");
    expect(provider.comments).toHaveLength(1);
    expect(provider.comments[0]?.body).toContain("Draft Pull Request:");
  });

  it("requires approval for policy-gated paths without pushing", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    workspace.inspection = {
      ...workspace.inspection,
      changedFiles: [".github/workflows/release.yml"],
    };
    const deps = dependencies(provider, workspace);
    const prepared = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      deps,
    );

    const result = await applyDraftPr(
      repository,
      issue.number,
      submission(prepared),
      deps,
    );

    expect(result.outcome).toBe("needs_approval");
    expect(workspace.commitCalls).toBe(0);
    expect(provider.issue.labels).toContain("agent:needs-approval");
    expect(provider.issue.labels).not.toContain("agent:running");
  });

  it("resumes an approval-gated implementation only from the paired labels", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    workspace.inspection = {
      ...workspace.inspection,
      changedFiles: [".github/workflows/release.yml"],
    };
    provider.issue.labels = ["bug", "agent:approved"];
    const deps = dependencies(provider, workspace);

    const missingGate = await prepareDraftPr(
      repository,
      issue.number,
      "approved",
      deps,
    );
    expect(missingGate.skipped).toBe(true);
    expect(workspace.prepareCalls).toBe(0);

    provider.issue.labels.push("agent:needs-approval");
    const prepared = await prepareDraftPr(
      repository,
      issue.number,
      "approved",
      deps,
    );
    const result = await applyDraftPr(
      repository,
      issue.number,
      submission(prepared),
      deps,
    );

    expect(result.outcome).toBe("implemented");
    expect(workspace.commitCalls).toBe(1);
    expect(provider.issue.labels).not.toContain("agent:approved");
    expect(provider.issue.labels).not.toContain("agent:needs-approval");
    expect(provider.issue.labels).toContain("agent:pr-open");
  });

  it("skips when the stable Issue branch already has an open Pull Request", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    provider.pullRequests = [
      {
        number: 440,
        url: "https://github.test/chaitin/agent-compose/pull/440",
        state: "open",
        draft: true,
        head: "codex/issue-439",
        base: "main",
      },
    ];

    const result = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      dependencies(provider, workspace),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("open Pull Request already exists");
    expect(workspace.prepareCalls).toBe(0);
  });

  it("returns a dry-run proposal without provider writes", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace, false);
    const prepared = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      deps,
    );

    const result = await applyDraftPr(
      repository,
      issue.number,
      submission(prepared),
      deps,
    );

    expect(result.applied).toBe(false);
    expect(result.proposedTitle).toBe(analysis.prTitle);
    expect(provider.addedLabels).toEqual([]);
    expect(provider.createdPullRequests).toEqual([]);
    expect(workspace.commitCalls).toBe(0);
    expect(workspace.cleanupCalls).toBe(1);
  });

  it("rejects reported test failures before pushing", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    const prepared = await prepareDraftPr(
      repository,
      issue.number,
      "ready",
      deps,
    );
    const input = submission(prepared);
    input.analysis = {
      ...analysis,
      tests: [
        { command: "go test ./...", status: "failed", details: "failed" },
      ],
    };

    await expect(
      applyDraftPr(repository, issue.number, input, deps),
    ).rejects.toThrow("failed validation");
    expect(workspace.commitCalls).toBe(0);
    expect(provider.createdPullRequests).toEqual([]);
  });
});
