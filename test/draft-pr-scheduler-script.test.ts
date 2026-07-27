import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("Draft PR Scheduler script", () => {
  it("routes agent:ready through prepare, Agent, and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentOptions: Record<string, unknown> = {};
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          commands.push(options.env.DRAFT_PR_COMMAND ?? "");
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  issueNumber: 439,
                  trigger: "ready",
                  approved: false,
                  issueFingerprint: "a".repeat(20),
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  baseCommit: "b".repeat(40),
                  issue: { title: "Webhook failure" },
                  comments: [],
                }
              : { ok: true, applied: false, outcome: "implemented" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(_prompt: string, options: Record<string, unknown>) {
          agentOptions = options;
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix(webhooks): avoid ambiguous commit results",
              summary: ["Return the committed event."],
              tests: [],
              risk: { level: "low", reasons: [] },
              notes: [],
            }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "labeled",
          label: { name: "agent:ready" },
          issue: { number: 439 },
          repository: { full_name: "chaitin/agent-compose" },
          sender: { login: "maintainer" },
        },
      },
    });

    expect(commands).toEqual(["prepare", "apply"]);
    expect(result).toEqual({
      ok: true,
      applied: false,
      outcome: "implemented",
    });
    expect(agentOptions.sandboxEnv).toEqual(
      expect.objectContaining({ GITHUB_TOKEN: "", GH_TOKEN: "" }),
    );
    expect(agentOptions.volumes).toEqual([
      expect.objectContaining({
        source:
          "./.draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
        target: "/draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
        readOnly: false,
      }),
    ]);
  });

  it("ignores unrelated labels without invoking a sandbox", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    let calls = 0;
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell() {
          calls += 1;
          return { success: true, stdout: "{}" };
        },
        agent() {
          calls += 1;
          return { success: true, finalText: "{}" };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "labeled",
          label: { name: "bug" },
          issue: { number: 439 },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      ignored: true,
      reason: "unmanaged label: bug",
    });
    expect(calls).toBe(0);
  });

  it("records agent failures through the deterministic tool", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          commands.push(options.env.DRAFT_PR_COMMAND ?? "");
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare"
              ? {
                  ok: true,
                  trigger: "ready",
                  issueFingerprint: "a".repeat(20),
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  baseCommit: "b".repeat(40),
                }
              : { ok: true, applied: true, outcome: "failed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          return { success: false, text: "agent failed" };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "labeled",
          label: { name: "agent:ready" },
          issue: { number: 439 },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual(["prepare", "fail"]);
    expect(result).toEqual({ ok: true, applied: true, outcome: "failed" });
  });

  it("batches MonkeyScan PR comments through review prepare and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let reviewAgentOptions: Record<string, unknown> = {};
    const context = vm.createContext({
      process: {
        env: {
          MONKEYSCAN_BOT_LOGIN: "monkeyscan[bot]",
          MONKEYSCAN_BOT_USER_ID: "9001",
        },
      },
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          const command = options.env.DRAFT_PR_COMMAND ?? "";
          commands.push(command);
          const result =
            command === "prepare-review"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  pullRequestNumber: 440,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  expectedHeadSha: "a".repeat(40),
                  commentsFingerprint: "b".repeat(20),
                  previousConversationCursor: 0,
                  previousReviewCursor: 0,
                  previousIterations: 0,
                  findings: [
                    {
                      source: "review",
                      commentId: 10,
                      body: "first finding",
                    },
                    {
                      source: "review",
                      commentId: 11,
                      body: "second finding",
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(_prompt: string, options: Record<string, unknown>) {
          reviewAgentOptions = options;
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "fix: address MonkeyScan findings",
              summary: ["Address both findings."],
              findings: [10, 11].map((commentId) => ({
                source: "review",
                commentId,
                disposition: "fixed",
                reason: "Covered by tests.",
              })),
              tests: [],
              risk: { level: "low", reasons: [] },
              notes: [],
            }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.issue_comment")?.({
      payload: {
        body: {
          action: "created",
          issue: { number: 440, pull_request: { url: "pull" } },
          comment: {
            id: 11,
            user: { login: "monkeyscan[bot]", id: 9001 },
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual(["prepare-review", "apply-review"]);
    expect(result).toEqual({ ok: true, applied: true, outcome: "fixed" });
    expect(reviewAgentOptions.volumes).toEqual([
      expect.objectContaining({
        source: "./.draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
        readOnly: false,
      }),
    ]);
  });

  it.each([
    {
      topic: "webhook.github.pull_request_review_comment",
      body: {
        action: "created",
        pull_request: { number: 440 },
        comment: {
          id: 11,
          user: { login: "monkeyscan[bot]", id: 9001 },
        },
        repository: { full_name: "chaitin/agent-compose" },
      },
    },
    {
      topic: "webhook.github.pull_request_review",
      body: {
        action: "submitted",
        pull_request: { number: 440 },
        review: {
          id: 700,
          user: { login: "monkeyscan[bot]", id: 9001 },
        },
        repository: { full_name: "chaitin/agent-compose" },
      },
    },
  ])("routes MonkeyScan $topic into one review-fix batch", async (fixture) => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const context = vm.createContext({
      process: {
        env: {
          MONKEYSCAN_BOT_LOGIN: "monkeyscan[bot]",
          MONKEYSCAN_BOT_USER_ID: "9001",
        },
      },
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          const command = options.env.DRAFT_PR_COMMAND ?? "";
          commands.push(command);
          const result =
            command === "prepare-review"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  pullRequestNumber: 440,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  expectedHeadSha: "a".repeat(40),
                  commentsFingerprint: "b".repeat(20),
                  previousConversationCursor: 0,
                  previousReviewCursor: 0,
                  previousIterations: 0,
                  findings: [
                    {
                      source: "review",
                      commentId: 10,
                      path: "pkg/sessions/deletion_recovery.go",
                      line: 104,
                      diffHunk: "@@ -100,0 +101,4 @@",
                      body: "first inline finding",
                    },
                    {
                      source: "review",
                      commentId: 11,
                      path: "pkg/sessions/deletion_recovery_test.go",
                      line: 40,
                      diffHunk: "@@ -36,0 +37,4 @@",
                      body: "second inline finding",
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "fix: address inline MonkeyScan findings",
              summary: ["Address both inline findings."],
              findings: [10, 11].map((commentId) => ({
                source: "review",
                commentId,
                disposition: "fixed",
                reason: "Covered by tests.",
              })),
              tests: [],
              risk: { level: "low", reasons: [] },
              notes: [],
            }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get(fixture.topic)?.({
      payload: { body: fixture.body },
    });

    expect(commands).toEqual(["prepare-review", "apply-review"]);
    expect(result).toEqual({ ok: true, applied: true, outcome: "fixed" });
  });

  it("preserves the review cursor when an Agent attempt fails", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const calls: Array<Record<string, string>> = [];
    const context = vm.createContext({
      process: {
        env: {
          MONKEYSCAN_BOT_LOGIN: "monkeyscan[bot]",
          MONKEYSCAN_BOT_USER_ID: "9001",
        },
      },
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          calls.push(options.env);
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare-review"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  pullRequestNumber: 440,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  expectedHeadSha: "a".repeat(40),
                  commentsFingerprint: "b".repeat(20),
                  previousConversationCursor: 7,
                  previousReviewCursor: 3,
                  previousIterations: 1,
                  findings: [
                    {
                      source: "review",
                      commentId: 10,
                      body: "first finding",
                    },
                    {
                      source: "review",
                      commentId: 11,
                      body: "second finding",
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "failed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          return { success: false, text: "agent failed" };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.issue_comment")?.({
      payload: {
        body: {
          action: "created",
          issue: { number: 440, pull_request: { url: "pull" } },
          comment: {
            id: 11,
            user: { login: "monkeyscan[bot]", id: 9001 },
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(calls.map((call) => call.DRAFT_PR_COMMAND)).toEqual([
      "prepare-review",
      "fail-review",
    ]);
    expect(calls[1]).toEqual(
      expect.objectContaining({
        DRAFT_PR_CONVERSATION_CURSOR: "7",
        DRAFT_PR_REVIEW_CURSOR: "3",
        DRAFT_PR_REVIEW_ITERATIONS: "2",
        DRAFT_PR_REVIEW_HEAD: "a".repeat(40),
      }),
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "failed" });
  });

  it("does not write review state when preparation fails before validation", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const context = vm.createContext({
      process: {
        env: {
          MONKEYSCAN_BOT_LOGIN: "monkeyscan[bot]",
          MONKEYSCAN_BOT_USER_ID: "9001",
        },
      },
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          commands.push(options.env.DRAFT_PR_COMMAND ?? "");
          return { success: false, stdout: "provider unavailable" };
        },
        agent() {
          throw new Error("must not run");
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    expect(() =>
      handlers.get("webhook.github.issue_comment")?.({
        payload: {
          body: {
            action: "created",
            issue: { number: 440, pull_request: { url: "pull" } },
            comment: {
              id: 11,
              user: { login: "monkeyscan[bot]", id: 9001 },
            },
            repository: { full_name: "chaitin/agent-compose" },
          },
        },
      }),
    ).toThrow("Draft PR review tool failed");
    expect(commands).toEqual(["prepare-review"]);
  });

  it("reconciles a pending comment whose overlapping webhook was skipped", async () => {
    let intervalHandler: (() => unknown) | undefined;
    const commands: string[] = [];
    const context = vm.createContext({
      process: {
        env: {
          DRAFT_PR_APPLY: "1",
          DRAFT_PR_ALLOWED_REPOSITORY: "chaitin/agent-compose",
          MONKEYSCAN_BOT_LOGIN: "monkeyscan[bot]",
          MONKEYSCAN_BOT_USER_ID: "9001",
        },
      },
      scheduler: {
        on() {},
        interval(
          _triggerID: string,
          handler: () => unknown,
          _milliseconds: number,
        ) {
          intervalHandler = handler;
        },
        shell(_script: string, options: { env: Record<string, string> }) {
          const command = options.env.DRAFT_PR_COMMAND ?? "";
          commands.push(command);
          const result =
            command === "list-review-targets"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  targets: [
                    { pullRequestNumber: 440, headSha: "a".repeat(40) },
                  ],
                }
              : command === "prepare-review"
                ? {
                    ok: true,
                    repository: "chaitin/agent-compose",
                    pullRequestNumber: 440,
                    workspacePath:
                      "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                    branch: "codex/issue-439",
                    baseBranch: "main",
                    expectedHeadSha: "a".repeat(40),
                    commentsFingerprint: "b".repeat(20),
                    previousConversationCursor: 4,
                    previousReviewCursor: 11,
                    previousIterations: 1,
                    findings: [
                      {
                        source: "review",
                        commentId: 12,
                        body: "late finding",
                      },
                    ],
                  }
                : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "fix: address late MonkeyScan finding",
              summary: ["Address the late finding."],
              findings: [
                {
                  source: "review",
                  commentId: 12,
                  disposition: "fixed",
                  reason: "Covered by tests.",
                },
              ],
              tests: [],
              risk: { level: "low", reasons: [] },
              notes: [],
            }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = intervalHandler?.();

    expect(commands).toEqual([
      "list-review-targets",
      "prepare-review",
      "apply-review",
    ]);
    expect(result).toEqual({
      ok: true,
      repository: "chaitin/agent-compose",
      results: [{ ok: true, applied: true, outcome: "fixed" }],
    });
  });

  it("routes a completed failed check suite through CI prepare and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentPrompt = "";
    let agentOptions: Record<string, unknown> = {};
    const headSha = "a".repeat(40);
    const context = vm.createContext({
      process: { env: {} },
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell(_script: string, options: { env: Record<string, string> }) {
          const command = options.env.DRAFT_PR_COMMAND ?? "";
          commands.push(command);
          const result =
            command === "prepare-ci"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  pullRequestNumber: 440,
                  checkSuiteId: 88001,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  expectedHeadSha: headSha,
                  failuresFingerprint: "b".repeat(20),
                  previousAttempts: 0,
                  failures: [
                    {
                      checkRunId: 701,
                      name: "CI / Coverage gate",
                      conclusion: "failure",
                      output: {
                        title: "Coverage threshold not met",
                        summary: "79.8% is below 80%.",
                        text: "",
                      },
                      annotations: [],
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(prompt: string, options: Record<string, unknown>) {
          agentPrompt = prompt;
          agentOptions = options;
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "test: cover the missed branch",
              summary: ["Add focused coverage."],
              failures: [
                {
                  checkRunId: 701,
                  disposition: "fixed",
                  reason: "Focused test passes locally.",
                },
              ],
              tests: [],
              risk: { level: "low", reasons: [] },
              notes: [],
            }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.check_suite")?.({
      payload: {
        body: {
          action: "completed",
          check_suite: {
            id: 88001,
            head_sha: headSha,
            conclusion: "failure",
            pull_requests: [{ number: 440 }],
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual(["prepare-ci", "apply-ci"]);
    expect(result).toEqual({
      ok: true,
      repository: "chaitin/agent-compose",
      checkSuiteId: 88001,
      results: [{ ok: true, applied: true, outcome: "fixed" }],
    });
    expect(agentPrompt).toContain("fix_ci mode");
    expect(agentPrompt).toContain("CI / Coverage gate");
    expect(agentOptions.sandboxEnv).toEqual(
      expect.objectContaining({ GITHUB_TOKEN: "", GH_TOKEN: "" }),
    );
  });

  it("ignores successful check suites without invoking a sandbox", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    let calls = 0;
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        interval() {},
        shell() {
          calls += 1;
          return { success: true, stdout: "{}" };
        },
        agent() {
          calls += 1;
          return { success: true, finalText: "{}" };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.check_suite")?.({
      payload: {
        body: {
          action: "completed",
          check_suite: {
            id: 88001,
            head_sha: "a".repeat(40),
            conclusion: "success",
            pull_requests: [{ number: 440 }],
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      ignored: true,
      reason: "check suite does not have a supported failure conclusion",
    });
    expect(calls).toBe(0);
  });
});

async function schedulerScript(): Promise<string> {
  return readFile(new URL("../loaders/draft-pr.js", import.meta.url), "utf8");
}
