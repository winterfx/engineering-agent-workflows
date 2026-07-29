import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("Draft PR Scheduler script", () => {
  it("routes agent:ready through prepare, Agent, and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentOptions: Record<string, unknown> = {};
    let toolChunks: string[] = [];
    let workflowPolicyJson = "";
    const shellCalls: Array<{
      script: string;
      options: Record<string, unknown> & { env: Record<string, string> };
    }> = [];
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
        shell(
          script: string,
          options: Record<string, unknown> & {
            env: Record<string, string>;
          },
        ) {
          shellCalls.push({ script, options });
          commands.push(schedulerCommand(options.env));
          workflowPolicyJson = options.env.WORKFLOW_POLICY_JSON ?? "";
          toolChunks = Object.entries(options.env)
            .filter(([name]) => name.startsWith("WORKFLOW_TOOL_CHUNK_"))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value);
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
            text:
              "Agent progress with {embedded: 'text'}\n" +
              JSON.stringify({
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

    expect(commands).toEqual(["prepare", "prepare-workspace", "apply"]);
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
    const workspacePreparation = shellCalls.find(
      ({ options }) => options.env.DRAFT_PR_WORKSPACE_PREPARE === "1",
    );
    expect(workspacePreparation?.script).toContain("buf generate");
    expect(workspacePreparation?.options.env).toEqual(
      expect.objectContaining({
        DRAFT_PR_WORKSPACE_PATH:
          "/draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
      }),
    );
    expect(workspacePreparation?.options.volumes).toEqual(agentOptions.volumes);
    expect(toolChunks.length).toBeGreaterThan(1);
    expect(toolChunks.every((chunk) => chunk.length <= 60000)).toBe(true);
    expect(JSON.parse(workflowPolicyJson)).toEqual(
      expect.objectContaining({ version: 1 }),
    );
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

  it("registers Review and CI triggers without PR comments or reconciliation", async () => {
    const topics: string[] = [];
    const triggerIDs: string[] = [];
    const intervalIDs: string[] = [];
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          triggerID: string,
          _handler: (event: unknown) => unknown,
        ) {
          topics.push(topic);
          triggerIDs.push(triggerID);
        },
        interval(triggerID: string) {
          intervalIDs.push(triggerID);
        },
      },
    });

    new vm.Script(await schedulerScript()).runInContext(context);

    expect(topics).toEqual([
      "webhook.github.issues",
      "webhook.github.pull_request_review",
      "webhook.github.check_suite",
    ]);
    expect(topics).not.toContain("webhook.github.issue_comment");
    expect(topics).not.toContain("webhook.github.pull_request_review_comment");
    expect(triggerIDs).toEqual([
      "github-draft-pr-v1",
      "github-draft-pr-requested-changes-v1",
      "github-draft-pr-ci-fix-v1",
    ]);
    expect(intervalIDs).toEqual([]);
  });

  it("records agent failures through the deterministic tool", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let failureMessage = "";
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
          commands.push(schedulerCommand(options.env));
          if (options.env.DRAFT_PR_COMMAND === "fail") {
            failureMessage = options.env.DRAFT_PR_FAILURE ?? "";
          }
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

    expect(commands).toEqual(["prepare", "prepare-workspace", "fail"]);
    expect(failureMessage).toBe("agent failed");
    expect(result).toEqual({ ok: true, applied: true, outcome: "failed" });
  });

  it("records protobuf preparation failures before starting the Agent", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let failureMessage = "";
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
          const command = schedulerCommand(options.env);
          commands.push(command);
          if (command === "prepare-workspace") {
            return { success: false, stdout: "buf generate failed" };
          }
          if (options.env.DRAFT_PR_COMMAND === "fail") {
            failureMessage = options.env.DRAFT_PR_FAILURE ?? "";
          }
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
          throw new Error("Agent must not start after preparation fails");
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

    expect(commands).toEqual(["prepare", "prepare-workspace", "fail"]);
    expect(failureMessage).toContain(
      "Draft PR workspace preparation failed: buf generate failed",
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "failed" });
  });

  it("routes a requested-changes Review into one review-fix batch", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const calls: Array<Record<string, string>> = [];
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
          calls.push(options.env);
          const command = schedulerCommand(options.env);
          commands.push(command);
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
                  reviewId: 700,
                  reviewFingerprint: "b".repeat(20),
                  previousReviewCursor: 0,
                  previousIterations: 0,
                  findings: [
                    {
                      source: "review",
                      commentId: 700,
                      body: "Please address the recovery behavior.",
                    },
                    {
                      source: "review_comment",
                      commentId: 10,
                      path: "pkg/sessions/deletion_recovery.go",
                      line: 104,
                      body: "Inline finding",
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
              commitTitle: "fix: address requested changes",
              summary: ["Address the Review findings."],
              findings: [
                {
                  source: "review",
                  commentId: 700,
                  disposition: "fixed",
                  reason: "Covered by tests.",
                },
                {
                  source: "review_comment",
                  commentId: 10,
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

    const result = handlers.get("webhook.github.pull_request_review")?.({
      payload: {
        body: {
          action: "submitted",
          pull_request: { number: 440 },
          review: { id: 700, state: "changes_requested" },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual([
      "prepare-review",
      "prepare-workspace",
      "apply-review",
    ]);
    expect(calls[0]).toEqual(
      expect.objectContaining({ DRAFT_PR_REVIEW_ID: "700" }),
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "fixed" });
  });

  it.each(["approved", "commented"])(
    "ignores a submitted %s Review",
    async (state) => {
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
          shell() {
            calls += 1;
          },
        },
      });
      new vm.Script(await schedulerScript()).runInContext(context);

      const result = handlers.get("webhook.github.pull_request_review")?.({
        payload: {
          body: {
            action: "submitted",
            pull_request: { number: 440 },
            review: { id: 700, state },
            repository: { full_name: "chaitin/agent-compose" },
          },
        },
      });

      expect(result).toEqual({
        ok: true,
        ignored: true,
        reason: "Review is not a change request",
      });
      expect(calls).toBe(0);
    },
  );

  it("preserves the review cursor when an Agent attempt fails", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const calls: Array<Record<string, string>> = [];
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
                  reviewId: 700,
                  reviewFingerprint: "b".repeat(20),
                  previousReviewCursor: 3,
                  previousIterations: 1,
                  findings: [
                    {
                      source: "review",
                      commentId: 700,
                      body: "Requested changes.",
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

    const result = handlers.get("webhook.github.pull_request_review")?.({
      payload: {
        body: {
          action: "submitted",
          pull_request: { number: 440 },
          review: { id: 700, state: "changes_requested" },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(calls.map(schedulerCommand)).toEqual([
      "prepare-review",
      "prepare-workspace",
      "fail-review",
    ]);
    expect(calls[2]).toEqual(
      expect.objectContaining({
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
          commands.push(schedulerCommand(options.env));
          return { success: false, stdout: "provider unavailable" };
        },
        agent() {
          throw new Error("must not run");
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    expect(() =>
      handlers.get("webhook.github.pull_request_review")?.({
        payload: {
          body: {
            action: "submitted",
            pull_request: { number: 440 },
            review: { id: 700, state: "changes_requested" },
            repository: { full_name: "chaitin/agent-compose" },
          },
        },
      }),
    ).toThrow("Draft PR review tool failed");
    expect(commands).toEqual(["prepare-review"]);
  });

  it("routes a completed failed check suite through CI prepare and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentPrompt = "";
    let agentOptions: Record<string, unknown> = {};
    const headSha = "a".repeat(40);
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
          const command = schedulerCommand(options.env);
          commands.push(command);
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare-ci"
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

    expect(commands).toEqual(["prepare-ci", "prepare-workspace", "apply-ci"]);
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
  return readFile(
    new URL("../agents/draft-pr/scheduler.js", import.meta.url),
    "utf8",
  );
}

function schedulerCommand(env: Record<string, string>): string {
  return env.DRAFT_PR_WORKSPACE_PREPARE === "1"
    ? "prepare-workspace"
    : (env.DRAFT_PR_COMMAND ?? "");
}
