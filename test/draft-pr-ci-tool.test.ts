import { describe, expect, it } from "vitest";
import type { DraftPrPolicy } from "../src/draft-pr/policy.js";
import type {
  CheckRun,
  CheckRunAnnotation,
  CiFixProvider,
  DraftPullRequest,
} from "../src/draft-pr/provider.js";
import {
  applyCiFix,
  prepareCiFix,
  type CiFixDependencies,
} from "../src/draft-pr/ci-tool.js";
import type { DraftPrInspection } from "../src/draft-pr/schema.js";
import type {
  DraftPrWorkspace,
  PreparedDraftPrWorkspace,
} from "../src/draft-pr/workspace.js";
import type {
  Issue,
  IssueCandidate,
  IssueComment,
} from "../src/issues/types.js";

const repository = "chaitin/agent-compose";
const pullRequestNumber = 440;
const headSha = "a".repeat(40);
const checkSuiteId = 88001;
const botLogin = "engineering-agent-bot";
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
  approvalPathPrefixes: [".github/workflows/"],
  labelColors: {},
};

class FakeProvider implements CiFixProvider {
  pullRequest: DraftPullRequest = {
    number: pullRequestNumber,
    url: `https://github.test/${repository}/pull/${pullRequestNumber}`,
    state: "open",
    draft: false,
    head: "codex/issue-439",
    headSha,
    headRepository: repository,
    base: "main",
  };
  comments: IssueComment[] = [];
  checkCalls = 0;
  checkRuns: CheckRun[] = [
    {
      id: 701,
      checkSuiteId,
      name: "CI / Coverage gate",
      status: "completed",
      conclusion: "failure",
      htmlUrl: "https://github.test/checks/701",
      output: {
        title: "Coverage threshold not met",
        summary: "Total coverage 79.8% is below 80%.",
        text: "pkg/webhooks/store.go has uncovered error handling.",
      },
    },
  ];
  annotations: CheckRunAnnotation[] = [
    {
      path: "pkg/webhooks/store.go",
      startLine: 42,
      endLine: 42,
      level: "failure",
      message: "New code is not covered.",
    },
  ];

  async getIssue(): Promise<Issue> {
    throw new Error("not used");
  }
  async searchCandidates(): Promise<IssueCandidate[]> {
    return [];
  }
  async listComments(): Promise<IssueComment[]> {
    return this.comments.map((comment) => ({
      ...comment,
      ...(comment.user ? { user: { ...comment.user } } : {}),
    }));
  }
  async ensureLabel(): Promise<void> {}
  async addLabels(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async createComment(
    _repository: string,
    _number: number,
    body: string,
  ): Promise<IssueComment> {
    const comment: IssueComment = {
      id: 1000,
      body,
      user: { login: botLogin, type: "Bot" },
    };
    this.comments.push(comment);
    return { ...comment };
  }
  async updateComment(
    _repository: string,
    _number: number,
    commentId: number,
    body: string,
  ): Promise<IssueComment> {
    const comment = this.comments.find((value) => value.id === commentId)!;
    comment.body = body;
    return { ...comment };
  }
  async getRepositoryDefaultBranch(): Promise<string> {
    return "main";
  }
  async getPullRequest(): Promise<DraftPullRequest> {
    return { ...this.pullRequest };
  }
  async listOpenPullRequests(): Promise<DraftPullRequest[]> {
    return [{ ...this.pullRequest }];
  }
  async listReviewComments(): Promise<[]> {
    return [];
  }
  async listOpenPullRequestsByHead(): Promise<DraftPullRequest[]> {
    return [];
  }
  async createDraftPullRequest(): Promise<DraftPullRequest> {
    throw new Error("not used");
  }
  async listCheckRuns(): Promise<CheckRun[]> {
    this.checkCalls += 1;
    return this.checkRuns.map((run) => ({
      ...run,
      output: { ...run.output },
    }));
  }
  async listCheckRunAnnotations(): Promise<CheckRunAnnotation[]> {
    return this.annotations.map((annotation) => ({ ...annotation }));
  }
}

class FakeWorkspace implements DraftPrWorkspace {
  prepareCalls = 0;
  commitCalls = 0;
  cleanupCalls = 0;
  inspection: DraftPrInspection = {
    headCommit: headSha,
    changedFiles: ["pkg/webhooks/store_test.go"],
    additions: 18,
    deletions: 0,
    diffCheckPassed: true,
    secretFindingPaths: [],
  };

  async prepare(): Promise<PreparedDraftPrWorkspace> {
    throw new Error("not used");
  }
  async prepareReview(input: {
    branch: string;
    baseBranch: string;
  }): Promise<PreparedDraftPrWorkspace> {
    this.prepareCalls += 1;
    return {
      path: `/draft-pr-workspaces/repositories/0123456789abcdef/pr-${pullRequestNumber}`,
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseCommit: headSha,
    };
  }
  async inspect(): Promise<DraftPrInspection> {
    return this.inspection;
  }
  async commitAndPush(): Promise<string> {
    this.commitCalls += 1;
    return "b".repeat(40);
  }
  async cleanup(): Promise<void> {}
  async cleanupReview(): Promise<void> {
    this.cleanupCalls += 1;
  }
}

function dependencies(
  provider: FakeProvider,
  workspace: FakeWorkspace,
  apply = true,
): CiFixDependencies {
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

describe("Draft PR CI fix", () => {
  it("validates a failed suite and pushes one focused fix", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);

    const prepared = await prepareCiFix(
      repository,
      pullRequestNumber,
      headSha,
      checkSuiteId,
      deps,
    );

    expect(prepared.failures).toEqual([
      expect.objectContaining({
        checkRunId: 701,
        name: "CI / Coverage gate",
        annotations: [
          expect.objectContaining({ path: "pkg/webhooks/store.go" }),
        ],
      }),
    ]);
    expect(workspace.prepareCalls).toBe(1);
    expect(provider.comments[0]?.body).toContain("status=fixing");

    const result = await applyCiFix(
      repository,
      pullRequestNumber,
      submission(prepared),
      deps,
    );

    expect(result).toMatchObject({
      applied: true,
      outcome: "fixed",
      commit: "b".repeat(40),
    });
    expect(workspace.commitCalls).toBe(1);
    expect(workspace.cleanupCalls).toBe(1);
    expect(provider.comments[0]?.body).toContain(
      `suite=${checkSuiteId} attempts=1 head=${"b".repeat(40)} status=fixed`,
    );
  });

  it("ignores a stale check suite before reading its check runs", async () => {
    const provider = new FakeProvider();
    provider.pullRequest.headSha = "b".repeat(40);
    const workspace = new FakeWorkspace();

    const prepared = await prepareCiFix(
      repository,
      pullRequestNumber,
      headSha,
      checkSuiteId,
      dependencies(provider, workspace),
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "CI event is for a stale Pull Request head",
      }),
    );
    expect(provider.checkCalls).toBe(0);
    expect(workspace.prepareCalls).toBe(0);
  });

  it("pauses instead of pushing changes to an approval-gated path", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    workspace.inspection.changedFiles = [".github/workflows/ci.yml"];
    const deps = dependencies(provider, workspace);
    const prepared = await prepareCiFix(
      repository,
      pullRequestNumber,
      headSha,
      checkSuiteId,
      deps,
    );

    const result = await applyCiFix(
      repository,
      pullRequestNumber,
      submission(prepared),
      deps,
    );

    expect(result.outcome).toBe("needs_approval");
    expect(workspace.commitCalls).toBe(0);
    expect(provider.comments[0]?.body).toContain("status=needs-approval");
  });

  it("stops after the configured automatic fix attempt limit", async () => {
    const provider = new FakeProvider();
    provider.comments.push({
      id: 1000,
      body: `<!-- engineering-agent-workflows:ci-fix:v1 suite=77000 attempts=3 head=${headSha} status=failed -->\n## CI follow-up`,
      user: { login: botLogin, type: "Bot" },
    });
    const workspace = new FakeWorkspace();
    const prepared = await prepareCiFix(
      repository,
      pullRequestNumber,
      headSha,
      checkSuiteId,
      dependencies(provider, workspace),
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "automatic CI fix iteration limit reached",
      }),
    );
    expect(provider.checkCalls).toBe(0);
    expect(provider.comments[0]?.body).toContain("status=needs-approval");
  });
});

function submission(prepared: Awaited<ReturnType<typeof prepareCiFix>>) {
  const checkRefs = prepared.failures!.map((failure) => ({
    checkRunId: failure.checkRunId,
  }));
  return {
    checkSuiteId: prepared.checkSuiteId,
    failuresFingerprint: prepared.failuresFingerprint!,
    checkRefs,
    workspacePath: prepared.workspacePath!,
    branch: prepared.branch!,
    baseBranch: prepared.baseBranch!,
    expectedHeadSha: prepared.expectedHeadSha!,
    previousAttempts: prepared.previousAttempts!,
    analysis: {
      outcome: "fixed" as const,
      commitTitle: "test(webhooks): cover committed error response",
      summary: ["Cover the previously untested error branch."],
      failures: checkRefs.map((failure) => ({
        ...failure,
        disposition: "fixed" as const,
        reason: "The focused coverage test now exercises the branch.",
      })),
      tests: [
        {
          command: "go test ./pkg/webhooks/...",
          status: "passed" as const,
          details: "Focused tests and coverage gate passed locally.",
        },
      ],
      risk: { level: "low" as const, reasons: ["Test-only change."] },
      notes: [],
    },
  };
}
