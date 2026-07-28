import { describe, expect, it } from "vitest";
import type { DraftPrPolicy } from "../src/draft-pr/policy.js";
import type {
  DraftPrProvider,
  DraftPullRequest,
  PullRequestReviewComment,
} from "../src/draft-pr/provider.js";
import {
  applyReviewFix,
  listReviewFixTargets,
  monkeyScanEventAuthorReason,
  prepareReviewFix,
  type ReviewFixDependencies,
} from "../src/draft-pr/review-tool.js";
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
const botLogin = "engineering-agent-bot";
const monkeyScanBotLogin = "monkeyscan[bot]";
const monkeyScanBotUserId = 9001;
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

class FakeProvider implements DraftPrProvider {
  pullRequest: DraftPullRequest = {
    number: pullRequestNumber,
    url: `https://github.test/${repository}/pull/${pullRequestNumber}`,
    state: "open",
    draft: true,
    head: "codex/issue-439",
    headSha,
    headRepository: repository,
    base: "main",
  };
  comments: IssueComment[] = [
    {
      id: 12,
      body: "Human review note",
      user: { login: "maintainer", id: 42, type: "User" },
    },
  ];
  reviewComments: PullRequestReviewComment[] = [
    monkeyReviewComment(
      11,
      "The error branch lacks a regression assertion.",
      "pkg/sessions/deletion_recovery_test.go",
      40,
    ),
    monkeyReviewComment(
      10,
      "LastError remains set after recovery finishes.",
      "pkg/sessions/deletion_recovery.go",
      104,
    ),
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
    return comment;
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
  async listReviewComments(): Promise<PullRequestReviewComment[]> {
    return this.reviewComments.map((comment) => ({
      ...comment,
      ...(comment.user ? { user: { ...comment.user } } : {}),
    }));
  }
  async listOpenPullRequestsByHead(): Promise<DraftPullRequest[]> {
    return [];
  }
  async createDraftPullRequest(): Promise<DraftPullRequest> {
    throw new Error("not used");
  }
}

class FakeWorkspace implements DraftPrWorkspace {
  preparedReviewCalls = 0;
  commitCalls = 0;
  cleanupCalls = 0;
  inspection: DraftPrInspection = {
    headCommit: headSha,
    changedFiles: ["pkg/webhooks/store.go", "pkg/webhooks/store_test.go"],
    additions: 18,
    deletions: 4,
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
    this.preparedReviewCalls += 1;
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
): ReviewFixDependencies {
  return {
    provider,
    workspace,
    policy,
    allowedRepository: repository,
    serverUrl: "https://github.test",
    apply,
    botLogin,
    monkeyScanBotLogin,
    monkeyScanBotUserId,
  };
}

describe("Draft PR MonkeyScan review fix", () => {
  it("batches two unprocessed MonkeyScan comments into one push", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );

    expect(prepared.findings?.map((finding) => finding.commentId)).toEqual([
      10, 11,
    ]);
    expect(prepared.findings).toEqual([
      expect.objectContaining({
        source: "review",
        path: "pkg/sessions/deletion_recovery.go",
        line: 104,
      }),
      expect.objectContaining({
        source: "review",
        path: "pkg/sessions/deletion_recovery_test.go",
        line: 40,
      }),
    ]);
    expect(workspace.preparedReviewCalls).toBe(1);

    const result = await applyReviewFix(
      repository,
      pullRequestNumber,
      submission(prepared),
      deps,
    );

    expect(result.outcome).toBe("fixed");
    expect(workspace.commitCalls).toBe(1);
    expect(workspace.cleanupCalls).toBe(1);
    const status = provider.comments.find((comment) => comment.id === 1000)!;
    expect(status.body).toContain("conversation=0 review=11 iterations=1");
    expect(status.body).toContain("status=fixed");
  });

  it("ignores PR conversation comments while processing inline review comments", async () => {
    const provider = new FakeProvider();
    provider.comments.unshift(
      monkeyComment(10, "Conversation-level recovery finding."),
    );
    provider.reviewComments = [provider.reviewComments[1]!];
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );

    expect(
      prepared.findings?.map(({ source, commentId }) => ({
        source,
        commentId,
      })),
    ).toEqual([{ source: "review", commentId: 10 }]);

    const result = await applyReviewFix(
      repository,
      pullRequestNumber,
      submission(prepared),
      deps,
    );

    expect(result.outcome).toBe("fixed");
    expect(workspace.commitCalls).toBe(1);
    expect(
      provider.comments.find((comment) => comment.id === 1000)?.body,
    ).toContain("conversation=0 review=10 iterations=1");
  });

  it("does not treat MonkeyScan PR conversation comments as findings", async () => {
    const provider = new FakeProvider();
    provider.reviewComments = [];
    provider.comments.unshift(
      monkeyComment(11, "New conversation finding."),
      monkeyComment(10, "Old conversation finding."),
    );
    provider.comments.push({
      id: 1000,
      body: `<!-- engineering-agent-workflows:review-fix:v1 cursor=10 iterations=1 head=${headSha} status=fixed -->\n## MonkeyScan follow-up`,
      user: { login: botLogin, type: "Bot" },
    });
    const workspace = new FakeWorkspace();

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      dependencies(provider, workspace),
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "no unprocessed MonkeyScan review comments",
      }),
    );
    expect(workspace.preparedReviewCalls).toBe(0);
  });

  it("rejects a changed Pull Request head before pushing", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );
    provider.pullRequest.headSha = "c".repeat(40);

    await expect(
      applyReviewFix(repository, pullRequestNumber, submission(prepared), deps),
    ).rejects.toThrow("head changed");
    expect(workspace.commitCalls).toBe(0);
  });

  it("reconciliation finds an open managed Draft PR with pending comments", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();

    const result = await listReviewFixTargets(
      repository,
      dependencies(provider, workspace),
    );

    expect(result.targets).toEqual([{ pullRequestNumber, headSha }]);
  });

  it("validates webhook authors against the configured MonkeyScan identity", () => {
    const deps = dependencies(new FakeProvider(), new FakeWorkspace());

    expect(
      monkeyScanEventAuthorReason(
        monkeyScanBotLogin.toUpperCase(),
        monkeyScanBotUserId,
        deps,
      ),
    ).toBeUndefined();
    expect(monkeyScanEventAuthorReason("maintainer", 42, deps)).toBe(
      "review author is not MonkeyScan",
    );
    expect(monkeyScanEventAuthorReason(monkeyScanBotLogin, 42, deps)).toBe(
      "MonkeyScan user ID mismatch",
    );
    deps.botLogin = monkeyScanBotLogin;
    expect(
      monkeyScanEventAuthorReason(
        monkeyScanBotLogin,
        monkeyScanBotUserId,
        deps,
      ),
    ).toBe("workflow status comment is not a MonkeyScan finding");
  });

  it("skips reconciliation in dry-run before validating or listing targets", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    deps.apply = false;
    deps.allowedRepository = "";

    const result = await listReviewFixTargets("", deps);

    expect(result).toEqual({
      ok: true,
      ignored: true,
      reason: "review reconciliation is disabled in dry-run",
      repository: "",
      targets: [],
    });
  });

  it("rejects identical scanner and workflow bot identities", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    deps.botLogin = monkeyScanBotLogin.toUpperCase();

    await expect(listReviewFixTargets(repository, deps)).rejects.toThrow(
      "must be different identities",
    );
    expect(workspace.preparedReviewCalls).toBe(0);
  });

  it("stops reconciliation at the iteration limit without advancing the cursor", async () => {
    const provider = new FakeProvider();
    provider.comments.push({
      id: 1000,
      body: `<!-- engineering-agent-workflows:review-fix:v1 cursor=10 iterations=3 head=${headSha} status=failed -->\n## MonkeyScan follow-up`,
      user: { login: botLogin, type: "Bot" },
    });
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);

    const listed = await listReviewFixTargets(repository, deps);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );

    expect(listed.targets).toEqual([]);
    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "automatic MonkeyScan fix iteration limit reached",
      }),
    );
    expect(
      provider.comments.find((comment) => comment.id === 1000)?.body,
    ).toContain("conversation=10 review=0 iterations=3");
    expect(
      provider.comments.find((comment) => comment.id === 1000)?.body,
    ).toContain("status=needs-approval");
    expect(workspace.preparedReviewCalls).toBe(0);
  });

  it("requires no_change to mark every finding not reproducible", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    workspace.inspection = {
      ...workspace.inspection,
      changedFiles: [],
      additions: 0,
      deletions: 0,
    };
    const deps = dependencies(provider, workspace);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );
    const input = submission(prepared);

    await expect(
      applyReviewFix(
        repository,
        pullRequestNumber,
        {
          ...input,
          analysis: {
            ...input.analysis,
            outcome: "no_change",
            findings: input.analysis.findings.map((finding) => ({
              ...finding,
              disposition: "fixed",
            })),
          },
        },
        deps,
      ),
    ).rejects.toThrow("requires every finding to be not reproducible");
    expect(workspace.commitCalls).toBe(0);
  });

  it("rejects fixed output containing an approval-gated finding", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      deps,
    );
    const input = submission(prepared);

    await expect(
      applyReviewFix(
        repository,
        pullRequestNumber,
        {
          ...input,
          analysis: {
            ...input.analysis,
            findings: input.analysis.findings.map((finding, index) => ({
              ...finding,
              disposition: index === 0 ? "needs_approval" : "fixed",
            })),
          },
        },
        deps,
      ),
    ).rejects.toThrow("cannot contain approval-gated findings");
    expect(workspace.commitCalls).toBe(0);
  });
});

function submission(prepared: Awaited<ReturnType<typeof prepareReviewFix>>) {
  const commentRefs = prepared.findings!.map((finding) => ({
    source: finding.source,
    commentId: finding.commentId,
  }));
  return {
    commentsFingerprint: prepared.commentsFingerprint!,
    commentRefs,
    workspacePath: prepared.workspacePath!,
    branch: prepared.branch!,
    baseBranch: prepared.baseBranch!,
    expectedHeadSha: prepared.expectedHeadSha!,
    previousConversationCursor: prepared.previousConversationCursor!,
    previousReviewCursor: prepared.previousReviewCursor!,
    previousIterations: prepared.previousIterations!,
    analysis: {
      outcome: "fixed" as const,
      commitTitle: "fix(webhooks): address MonkeyScan findings",
      summary: ["Keep the committed result and cover the error branch."],
      findings: commentRefs.map((comment) => ({
        ...comment,
        disposition: "fixed" as const,
        reason: "Validated and covered by the focused regression test.",
      })),
      tests: [
        {
          command: "go test ./pkg/webhooks/...",
          status: "passed" as const,
          details: "Focused regression tests passed.",
        },
      ],
      risk: { level: "low" as const, reasons: ["Focused change."] },
      notes: [],
    },
  };
}

function monkeyComment(id: number, body: string): IssueComment {
  return {
    id,
    body,
    htmlUrl: `https://github.test/${repository}/pull/${pullRequestNumber}#issuecomment-${id}`,
    createdAt: `2026-07-26T12:00:${id}Z`,
    user: {
      login: monkeyScanBotLogin,
      id: monkeyScanBotUserId,
      type: "Bot",
    },
  };
}

function monkeyReviewComment(
  id: number,
  body: string,
  path: string,
  line: number,
): PullRequestReviewComment {
  return {
    id,
    body,
    path,
    line,
    diffHunk: `@@ -${line},0 +${line},1 @@`,
    commitId: headSha,
    htmlUrl: `https://github.test/${repository}/pull/${pullRequestNumber}#discussion_r${id}`,
    createdAt: `2026-07-26T12:00:${id}Z`,
    user: {
      login: monkeyScanBotLogin,
      id: monkeyScanBotUserId,
      type: "Bot",
    },
  };
}
