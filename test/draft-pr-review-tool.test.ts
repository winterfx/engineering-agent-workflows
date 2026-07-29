import { describe, expect, it } from "vitest";
import type { DraftPrPolicy } from "../src/draft-pr/policy.js";
import type {
  DraftPullRequest,
  PullRequestReview,
  PullRequestReviewComment,
  ReviewFixProvider,
} from "../src/draft-pr/provider.js";
import {
  applyReviewFix,
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
const reviewId = 700;
const headSha = "a".repeat(40);
const botLogin = "engineering-agent-bot";
const reviewer = { login: "maintainer", id: 42, type: "User" };
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
  requiredValidationGates: ["task-prepare", "task-lint", "task-test-unit"],
  approvalPathPrefixes: [".github/workflows/"],
  labelColors: {},
};

class FakeProvider implements ReviewFixProvider {
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
  review: PullRequestReview = {
    id: reviewId,
    body: "Please fix the recovery behavior and add coverage.",
    state: "CHANGES_REQUESTED",
    commitId: headSha,
    authorAssociation: "MEMBER",
    user: reviewer,
    htmlUrl: `https://github.test/${repository}/pull/${pullRequestNumber}#pullrequestreview-${reviewId}`,
    submittedAt: "2026-07-27T01:00:00Z",
  };
  comments: IssueComment[] = [
    {
      id: 12,
      body: "Ordinary PR conversation comment.",
      user: reviewer,
    },
  ];
  reviewComments: PullRequestReviewComment[] = [
    reviewComment(
      11,
      "The error branch lacks a regression assertion.",
      "pkg/sessions/deletion_recovery_test.go",
      40,
    ),
    reviewComment(
      10,
      "LastError remains set after recovery finishes.",
      "pkg/sessions/deletion_recovery.go",
      104,
    ),
    {
      ...reviewComment(20, "Another review.", "pkg/other.go", 1),
      pullRequestReviewId: 701,
    },
    { ...reviewComment(21, "A reply.", "pkg/other.go", 2), inReplyToId: 10 },
    {
      ...reviewComment(22, "Another author's note.", "pkg/other.go", 3),
      user: { login: "external", id: 99 },
    },
  ];

  async getIssue(): Promise<Issue> {
    throw new Error("not used");
  }
  async searchCandidates(): Promise<IssueCandidate[]> {
    return [];
  }
  async listComments(): Promise<IssueComment[]> {
    return structuredClone(this.comments);
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
  async getPullRequestReview(): Promise<PullRequestReview> {
    return structuredClone(this.review);
  }
  async listOpenPullRequests(): Promise<DraftPullRequest[]> {
    return [{ ...this.pullRequest }];
  }
  async listReviewComments(): Promise<PullRequestReviewComment[]> {
    return structuredClone(this.reviewComments);
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
  };
}

describe("Draft PR requested-changes review fix", () => {
  it("batches one trusted Review body and its inline comments into one push", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      deps,
    );

    expect(prepared.findings).toEqual([
      expect.objectContaining({
        source: "review",
        commentId: reviewId,
        body: provider.review.body,
      }),
      expect.objectContaining({
        source: "review_comment",
        commentId: 10,
        path: "pkg/sessions/deletion_recovery.go",
        line: 104,
      }),
      expect.objectContaining({
        source: "review_comment",
        commentId: 11,
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
    expect(status.body).toContain("review=700 iterations=1");
    expect(status.body).toContain("status=fixed");
  });

  it("does not treat ordinary PR conversation comments as findings", async () => {
    const provider = new FakeProvider();
    provider.comments.unshift({
      id: 500,
      body: "Please also change an unrelated file.",
      user: reviewer,
    });

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      dependencies(provider, new FakeWorkspace()),
    );

    expect(prepared.findings).toHaveLength(3);
    expect(
      prepared.findings?.map((finding) => finding.commentId),
    ).not.toContain(500);
  });

  it("handles one inline finding when the Review body is empty", async () => {
    const provider = new FakeProvider();
    provider.review.body = "";
    provider.reviewComments = [
      reviewComment(
        10,
        "Fix this branch.",
        "pkg/sessions/deletion_recovery.go",
        104,
      ),
    ];

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      dependencies(provider, new FakeWorkspace()),
    );

    expect(prepared.findings).toEqual([
      expect.objectContaining({
        source: "review_comment",
        commentId: 10,
        body: "Fix this branch.",
      }),
    ]);
  });

  it("pauses instead of silently truncating an oversized Review", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const limitedPolicy = { ...policy, maxReviewComments: 2 };

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      {
        ...dependencies(provider, workspace),
        policy: limitedPolicy,
      },
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: expect.stringContaining("exceeding the automatic limit of 2"),
      }),
    );
    expect(workspace.preparedReviewCalls).toBe(0);
    expect(provider.comments.at(-1)?.body).toContain("status=needs-approval");
  });

  it.each([
    ["APPROVED", "MEMBER", headSha, "not a change request"],
    ["CHANGES_REQUESTED", "CONTRIBUTOR", headSha, "not a trusted"],
    ["CHANGES_REQUESTED", "MEMBER", "c".repeat(40), "stale head"],
  ])(
    "skips ineligible Review state=%s association=%s",
    async (state, association, commitId, expectedReason) => {
      const provider = new FakeProvider();
      provider.review.state = state;
      provider.review.authorAssociation = association;
      provider.review.commitId = commitId;
      const workspace = new FakeWorkspace();

      const prepared = await prepareReviewFix(
        repository,
        pullRequestNumber,
        reviewId,
        dependencies(provider, workspace),
      );

      expect(prepared).toEqual(
        expect.objectContaining({
          skipped: true,
          reason: expect.stringContaining(expectedReason),
        }),
      );
      expect(workspace.preparedReviewCalls).toBe(0);
    },
  );

  it("does not replay an already processed Review", async () => {
    const provider = new FakeProvider();
    provider.comments.push({
      id: 1000,
      body: `<!-- engineering-agent-workflows:review-fix:v3 review=${reviewId} iterations=1 head=${headSha} status=fixed -->\n## Review follow-up`,
      user: { login: botLogin, type: "Bot" },
    });
    const workspace = new FakeWorkspace();

    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      dependencies(provider, workspace),
    );

    expect(prepared).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "Pull Request Review was already processed",
      }),
    );
    expect(workspace.preparedReviewCalls).toBe(0);
  });

  it("rejects a changed Review before pushing", async () => {
    const provider = new FakeProvider();
    const workspace = new FakeWorkspace();
    const deps = dependencies(provider, workspace);
    const prepared = await prepareReviewFix(
      repository,
      pullRequestNumber,
      reviewId,
      deps,
    );
    provider.review.body = "Changed after preparation.";

    await expect(
      applyReviewFix(repository, pullRequestNumber, submission(prepared), deps),
    ).rejects.toThrow("Review changed");
    expect(workspace.commitCalls).toBe(0);
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
      reviewId,
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
  });
});

function submission(prepared: Awaited<ReturnType<typeof prepareReviewFix>>) {
  const findingRefs = prepared.findings!.map((finding) => ({
    source: finding.source,
    commentId: finding.commentId,
  }));
  return {
    reviewId: prepared.reviewId!,
    reviewFingerprint: prepared.reviewFingerprint!,
    findingRefs,
    workspacePath: prepared.workspacePath!,
    branch: prepared.branch!,
    baseBranch: prepared.baseBranch!,
    expectedHeadSha: prepared.expectedHeadSha!,
    previousReviewCursor: prepared.previousReviewCursor!,
    previousIterations: prepared.previousIterations!,
    analysis: {
      outcome: "fixed" as const,
      commitTitle: "fix(webhooks): address requested changes",
      summary: ["Address the requested changes."],
      findings: findingRefs.map((finding) => ({
        ...finding,
        disposition: "fixed" as const,
        reason: "Validated and covered by focused tests.",
      })),
      tests: [],
      risk: { level: "low" as const, reasons: ["Focused change."] },
      notes: [],
    },
  };
}

function reviewComment(
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
    diffHunk: `@@ -${line},1 +${line},1 @@`,
    commitId: headSha,
    originalCommitId: headSha,
    pullRequestReviewId: reviewId,
    user: reviewer,
  };
}
