import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("Draft PR Scheduler script", () => {
  it("routes agent:ready through prepare, Agent, and apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentOptions: Record<string, unknown> = {};
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

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "apply",
    ]);
    expect(result).toEqual({
      ok: true,
      applied: false,
      outcome: "implemented",
    });
    expect(agentOptions.sandboxEnv).toEqual(
      expect.objectContaining({
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_APP_CLIENT_ID: "",
        GITHUB_APP_ID: "",
        GITHUB_APP_INSTALLATION_ID: "",
        GITHUB_APP_PRIVATE_KEY_BASE64: "",
      }),
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
        GITHUB_APP_CLIENT_ID: "",
        GITHUB_APP_ID: "",
        GITHUB_APP_INSTALLATION_ID: "",
        GITHUB_APP_PRIVATE_KEY_BASE64: "",
      }),
    );
    expect(workspacePreparation?.options.volumes).toEqual(agentOptions.volumes);
    const workspaceValidation = shellCalls.find(
      ({ options }) => options.env.DRAFT_PR_WORKSPACE_VALIDATE === "1",
    );
    expect(workspaceValidation?.script).toContain("set -eu");
    expect(workspaceValidation?.script).toContain("task prepare");
    expect(workspaceValidation?.script).toContain("task lint");
    expect(workspaceValidation?.script).toContain("task test:unit");
    expect(workspaceValidation?.script).toContain("[validation:failed:");
    expect(workspaceValidation?.script).toContain("[validation:case]");
    for (const variable of [
      "LLM_API_ENDPOINT",
      "LLM_API_PROTOCOL",
      "LLM_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "LLM_MODEL",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_ENDPOINT",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "CLAUDE_MODEL",
    ]) {
      expect(workspaceValidation?.script).toContain(variable);
    }
    expect(workspaceValidation?.script.indexOf("task prepare")).toBeLessThan(
      workspaceValidation?.script.indexOf("task lint") ?? -1,
    );
    expect(workspaceValidation?.script.indexOf("task lint")).toBeLessThan(
      workspaceValidation?.script.indexOf("task test:unit") ?? -1,
    );
    expect(workspaceValidation?.options.env).toEqual(
      expect.objectContaining({
        DRAFT_PR_WORKSPACE_PATH:
          "/draft-pr-workspaces/repositories/0123456789abcdef/issue-439",
        DRAFT_PR_APPLY: "0",
        CI: "1",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_APP_PRIVATE_KEY_BASE64: "",
        DRAFT_PR_GIT_TOKEN: "",
      }),
    );
    expect(workspaceValidation?.options.volumes).toEqual(agentOptions.volumes);
    const toolInvocation = shellCalls.find(
      ({ options }) => options.env.DRAFT_PR_COMMAND === "prepare",
    );
    expect(toolInvocation?.script).toContain(
      'export DRAFT_PR_TOOL="$WORKSPACE/workflow-repo/agents/draft-pr/tool/main.mjs"',
    );
    expect(JSON.parse(workflowPolicyJson)).toEqual(
      expect.objectContaining({
        version: 1,
        maxValidationFixIterations: 2,
        requiredValidationGates: [
          "task-prepare",
          "task-lint",
          "task-test-unit",
        ],
        allowedValidationFailureCases: [
          "TestConfigStoreCRUDCoverageWorkflows",
          "TestIntegrationConfigStoreCRUDCoverageWorkflows",
          "TestE2EConfigStoreCRUDCoverageWorkflows",
          "runtime command execution > injects runtime path environment into user commands",
        ],
      }),
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
      "webhook.github.workflow_run",
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

  it("retries only failed gates and records a canonical environment mismatch", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const validationScripts: string[] = [];
    let agentCalls = 0;
    let appliedAnalysis: Record<string, unknown> | undefined;
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
        shell(script: string, options: { env: Record<string, string> }) {
          const command = schedulerCommand(options.env);
          commands.push(command);
          if (command === "validate-workspace") {
            validationScripts.push(script);
            return validationScripts.length === 1
              ? {
                  success: false,
                  stdout:
                    "[validation:failed:1] task lint\n" +
                    "diagnostic mentions ] task test:unit but is not a failure marker",
                }
              : { success: true, stdout: "lint passed on retry" };
          }
          if (options.env.DRAFT_PR_COMMAND === "apply") {
            appliedAnalysis = JSON.parse(
              options.env.DRAFT_PR_SUBMISSION ?? "",
            ).analysis;
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
              : { ok: true, applied: true, outcome: "implemented" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          agentCalls += 1;
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix: validate webhook configuration",
              summary: ["Validate webhook configuration."],
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
        },
      },
    });

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "validate-workspace",
      "apply",
    ]);
    expect(agentCalls).toBe(1);
    expect(validationScripts[1]).toContain("task lint");
    expect(validationScripts[1]).not.toContain("task prepare");
    expect(validationScripts[1]).not.toContain("task test:unit");
    expect(appliedAnalysis?.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "task lint",
          status: "passed",
          details: expect.stringContaining("environment_mismatch"),
        }),
      ]),
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "implemented" });
  });

  it("applies a policy-allowlisted test failure without retrying the gate", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const agentPrompts: string[] = [];
    let appliedAnalysis: Record<string, unknown> | undefined;
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
          if (command === "validate-workspace") {
            return {
              success: false,
              stdout:
                "[validation:failed:1] task test:unit\n" +
                "[validation:case] --- FAIL: TestConfigStoreCRUDCoverageWorkflows (0.08s)\n" +
                "[validation:case] --- FAIL: TestIntegrationConfigStoreCRUDCoverageWorkflows (0.08s)\n" +
                "[validation:case] --- FAIL: TestE2EConfigStoreCRUDCoverageWorkflows (0.08s)\n" +
                "[validation:case] FAIL test/command.test.ts > runtime command execution > injects runtime path environment into user commands\n" +
                "RUNTIME_ROOT assertion failed",
            };
          }
          if (options.env.DRAFT_PR_COMMAND === "apply") {
            appliedAnalysis = JSON.parse(
              options.env.DRAFT_PR_SUBMISSION ?? "",
            ).analysis;
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
              : { ok: true, applied: true, outcome: "implemented" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(prompt: string) {
          agentPrompts.push(prompt);
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix: validate webhook configuration",
              summary: ["Validate webhook configuration."],
              tests: [],
              risk: {
                level: "medium",
                reasons: ["Full unit gate is pending."],
              },
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
        },
      },
    });

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "apply",
    ]);
    expect(agentPrompts).toHaveLength(1);
    expect(appliedAnalysis).toEqual(
      expect.objectContaining({
        outcome: "implemented",
        validationOverride: {
          classification: "allowlisted_test_failure",
          source: "policy",
          reason:
            "Allowlisted cases: TestConfigStoreCRUDCoverageWorkflows, TestIntegrationConfigStoreCRUDCoverageWorkflows, TestE2EConfigStoreCRUDCoverageWorkflows, runtime command execution > injects runtime path environment into user commands",
          failedCommands: ["task test:unit"],
          allowedFailureCases: [
            "TestConfigStoreCRUDCoverageWorkflows",
            "TestIntegrationConfigStoreCRUDCoverageWorkflows",
            "TestE2EConfigStoreCRUDCoverageWorkflows",
            "runtime command execution > injects runtime path environment into user commands",
          ],
        },
        tests: expect.arrayContaining([
          expect.objectContaining({
            command: "task test:unit",
            status: "failed",
            details: expect.stringContaining("was not retried"),
          }),
        ]),
      }),
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "implemented" });
  });

  it("repairs a failed local validation gate before apply", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const agentPrompts: string[] = [];
    const validationScripts: string[] = [];
    let validationCalls = 0;
    let inspectionCalls = 0;
    let appliedAnalysis: Record<string, unknown> | undefined;
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
        shell(script: string, options: { env: Record<string, string> }) {
          const command = schedulerCommand(options.env);
          commands.push(command);
          if (command === "validate-workspace") {
            validationScripts.push(script);
            validationCalls += 1;
            if (validationCalls > 2) {
              return { success: true, stdout: "validation passed" };
            }
            return {
              success: false,
              stdout:
                "[validation:failed:1] task lint\n" +
                "task lint: staticcheck failed",
            };
          }
          if (command === "inspect-validation") {
            inspectionCalls += 1;
            return {
              success: true,
              stdout: JSON.stringify({
                headCommit: "b".repeat(40),
                changeFingerprint: String(inspectionCalls).repeat(40),
              }),
            };
          }
          if (options.env.DRAFT_PR_COMMAND === "apply") {
            appliedAnalysis = JSON.parse(
              options.env.DRAFT_PR_SUBMISSION ?? "",
            ).analysis;
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
              : { ok: true, applied: true, outcome: "implemented" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(prompt: string) {
          agentPrompts.push(prompt);
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix: validate webhook configuration",
              summary: ["Validate webhook configuration."],
              tests:
                agentPrompts.length === 2
                  ? [
                      {
                        command: "task lint",
                        status: "passed",
                        details:
                          "Staticcheck initially failed and passed after correcting the implementation.",
                      },
                    ]
                  : [],
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
        },
      },
    });

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "validate-workspace",
      "apply",
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[0]).toContain("Run only focused checks");
    expect(agentPrompts[1]).toContain("fix_validation mode");
    expect(agentPrompts[1]).toContain("task lint: staticcheck failed");
    expect(agentPrompts[1]).toContain('"attempt":1');
    expect(validationScripts[1]).toContain("task lint");
    expect(validationScripts[1]).not.toContain("task prepare");
    expect(validationScripts[1]).not.toContain("task test:unit");
    expect(appliedAnalysis?.tests).toEqual([
      {
        command: "task prepare",
        status: "passed",
        details:
          "Trusted Scheduler validation passed after 1 local validation repair attempt.",
      },
      {
        command: "task lint",
        status: "passed",
        details:
          "Staticcheck initially failed and passed after correcting the implementation. Trusted Scheduler validation passed after 1 local validation repair attempt.",
      },
      {
        command: "task test:unit",
        status: "passed",
        details:
          "Trusted Scheduler validation passed after 1 local validation repair attempt.",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      applied: true,
      outcome: "implemented",
    });
  });

  it("blocks a validation repair that makes no repository changes", async () => {
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
          if (command === "validate-workspace") {
            return { success: false, stdout: "task lint failed" };
          }
          if (command === "inspect-validation") {
            return {
              success: true,
              stdout: JSON.stringify({
                headCommit: "b".repeat(40),
                changeFingerprint: "c".repeat(40),
              }),
            };
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
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix: validate webhook configuration",
              summary: ["Validate webhook configuration."],
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
        },
      },
    });

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "fail",
    ]);
    expect(failureMessage).toContain(
      "reported implemented without repository changes",
    );
    expect(failureMessage).toContain("potentially flaky rerun");
    expect(result).toEqual({ ok: true, applied: true, outcome: "failed" });
  });

  it("records failure after exhausting local validation repairs", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    let agentCalls = 0;
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
          if (command === "validate-workspace") {
            return {
              success: false,
              stdout:
                "[validation:failed:1] task test:unit\n" +
                "[validation:case] --- FAIL: TestUnexpectedRegression (0.01s)\n" +
                "task test:unit: assertion failed",
            };
          }
          if (command === "inspect-validation") {
            return {
              success: true,
              stdout: JSON.stringify({
                headCommit: "b".repeat(40),
                changeFingerprint: String(commands.length).repeat(40),
              }),
            };
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
          agentCalls += 1;
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "implemented",
              prTitle: "fix: validate webhook configuration",
              summary: ["Validate webhook configuration."],
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
        },
      },
    });

    expect(commands).toEqual([
      "prepare",
      "prepare-workspace",
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "validate-workspace",
      "validate-workspace",
      "fail",
    ]);
    expect(agentCalls).toBe(3);
    expect(failureMessage).toContain(
      "local validation remained failing after 2 repair attempts",
    );
    expect(failureMessage).toContain("task test:unit: assertion failed");
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
      "validate-workspace",
      "apply-review",
    ]);
    expect(calls[0]).toEqual(
      expect.objectContaining({ DRAFT_PR_REVIEW_ID: "700" }),
    );
    expect(result).toEqual({ ok: true, applied: true, outcome: "fixed" });
  });

  it("routes an allowlisted bot's COMMENTED Review into a review-fix batch", async () => {
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
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare-review"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  pullRequestNumber: 630,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-630",
                  branch: "codex/issue-629",
                  baseBranch: "main",
                  expectedHeadSha: "a".repeat(40),
                  reviewId: 5005431358,
                  reviewFingerprint: "b".repeat(20),
                  previousReviewCursor: 0,
                  previousIterations: 0,
                  findings: [
                    {
                      source: "review_comment",
                      commentId: 3841424677,
                      path: "pkg/agentcompose/api/project_handler.go",
                      line: 126,
                      body: "schedulerRuns silently degrades to nil.",
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
              commitTitle: "fix(api): restore scheduler run delegation",
              summary: ["Address the monkeyscan finding."],
              findings: [
                {
                  source: "review_comment",
                  commentId: 3841424677,
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
          pull_request: { number: 630 },
          review: {
            id: 5005431358,
            state: "commented",
            user: { login: "monkeyscan[bot]" },
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual([
      "prepare-review",
      "prepare-workspace",
      "validate-workspace",
      "apply-review",
    ]);
    expect(result).toEqual({ ok: true, applied: true, outcome: "fixed" });
  });

  it("ignores a COMMENTED Review from a non-allowlisted bot", async () => {
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
          return { success: true, stdout: JSON.stringify({ ok: true }) };
        },
        agent() {
          throw new Error("not used");
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const result = handlers.get("webhook.github.pull_request_review")?.({
      payload: {
        body: {
          action: "submitted",
          pull_request: { number: 630 },
          review: {
            id: 900,
            state: "commented",
            user: { login: "some-other-bot[bot]" },
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual([]);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        ignored: true,
        reason: "Review is not a change request",
      }),
    );
  });

  it("repairs a failed Review gate before apply and preserves dispositions", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const agentPrompts: string[] = [];
    let validationCalls = 0;
    let inspectionCalls = 0;
    let appliedAnalysis: Record<string, unknown> | undefined;
    const expectedHeadSha = "a".repeat(40);
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
          if (command === "validate-workspace") {
            validationCalls += 1;
            return validationCalls <= 2
              ? {
                  success: false,
                  stdout:
                    "[validation:failed:1] task test:unit\nassertion failed",
                }
              : { success: true, stdout: "validation passed" };
          }
          if (command === "inspect-validation") {
            inspectionCalls += 1;
            return {
              success: true,
              stdout: JSON.stringify({
                headCommit: expectedHeadSha,
                changeFingerprint: String(inspectionCalls).repeat(40),
              }),
            };
          }
          if (options.env.DRAFT_PR_COMMAND === "apply-review") {
            appliedAnalysis = JSON.parse(
              options.env.DRAFT_PR_SUBMISSION ?? "",
            ).analysis;
          }
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare-review"
              ? {
                  ok: true,
                  workspacePath:
                    "/draft-pr-workspaces/repositories/0123456789abcdef/pr-440",
                  branch: "codex/issue-439",
                  baseBranch: "main",
                  expectedHeadSha,
                  reviewId: 700,
                  reviewFingerprint: "b".repeat(20),
                  previousReviewCursor: 0,
                  previousIterations: 0,
                  findings: [
                    {
                      source: "review",
                      commentId: 700,
                      body: "Please address recovery behavior.",
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(prompt: string) {
          agentPrompts.push(prompt);
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "fix: address requested changes",
              summary: ["Address the Review finding."],
              findings: [
                {
                  source: "review",
                  commentId: 700,
                  disposition:
                    agentPrompts.length === 1 ? "fixed" : "not_reproducible",
                  reason: "Verified during focused repair.",
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
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "validate-workspace",
      "apply-review",
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[0]).toContain("Run only focused checks");
    expect(agentPrompts[1]).toContain("fix_review mode");
    expect(agentPrompts[1]).toContain('"attempt":1');
    expect(appliedAnalysis?.findings).toEqual([
      expect.objectContaining({
        commentId: 700,
        disposition: "fixed",
      }),
    ]);
    expect(appliedAnalysis?.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "task test:unit",
          status: "passed",
          details: expect.stringContaining("1 local validation repair attempt"),
        }),
      ]),
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

  it("routes a completed failed workflow run through CI prepare and apply", async () => {
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

    const result = handlers.get("webhook.github.workflow_run")?.({
      payload: {
        body: {
          action: "completed",
          workflow_run: {
            check_suite_id: 88001,
            head_sha: headSha,
            conclusion: "failure",
            pull_requests: [{ number: 440 }],
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual([
      "prepare-ci",
      "prepare-workspace",
      "validate-workspace",
      "apply-ci",
    ]);
    expect(result).toEqual({
      ok: true,
      repository: "chaitin/agent-compose",
      checkSuiteId: 88001,
      results: [{ ok: true, applied: true, outcome: "fixed" }],
    });
    expect(agentPrompt).toContain("fix_ci mode");
    expect(agentPrompt).toContain("CI / Coverage gate");
    expect(agentOptions.sandboxEnv).toEqual(
      expect.objectContaining({
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_APP_CLIENT_ID: "",
        GITHUB_APP_ID: "",
        GITHUB_APP_INSTALLATION_ID: "",
        GITHUB_APP_PRIVATE_KEY_BASE64: "",
      }),
    );
  });

  it("repairs a failed CI gate before apply and preserves dispositions", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const agentPrompts: string[] = [];
    let validationCalls = 0;
    let inspectionCalls = 0;
    let appliedAnalysis: Record<string, unknown> | undefined;
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
          if (command === "validate-workspace") {
            validationCalls += 1;
            return validationCalls <= 2
              ? {
                  success: false,
                  stdout: "[validation:failed:1] task lint\nstaticcheck failed",
                }
              : { success: true, stdout: "validation passed" };
          }
          if (command === "inspect-validation") {
            inspectionCalls += 1;
            return {
              success: true,
              stdout: JSON.stringify({
                headCommit: headSha,
                changeFingerprint: String(inspectionCalls).repeat(40),
              }),
            };
          }
          if (options.env.DRAFT_PR_COMMAND === "apply-ci") {
            appliedAnalysis = JSON.parse(
              options.env.DRAFT_PR_SUBMISSION ?? "",
            ).analysis;
          }
          const result =
            options.env.DRAFT_PR_COMMAND === "prepare-ci"
              ? {
                  ok: true,
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
                      name: "CI / lint",
                      conclusion: "failure",
                      output: { summary: "staticcheck failed" },
                      annotations: [],
                    },
                  ],
                }
              : { ok: true, applied: true, outcome: "fixed" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent(prompt: string) {
          agentPrompts.push(prompt);
          return {
            success: true,
            finalText: JSON.stringify({
              outcome: "fixed",
              commitTitle: "fix: satisfy lint",
              summary: ["Fix the lint failure."],
              failures: [
                {
                  checkRunId: 701,
                  disposition:
                    agentPrompts.length === 1 ? "fixed" : "not_reproducible",
                  reason: "Verified during focused repair.",
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

    const result = handlers.get("webhook.github.workflow_run")?.({
      payload: {
        body: {
          action: "completed",
          workflow_run: {
            check_suite_id: 88001,
            head_sha: headSha,
            conclusion: "failure",
            pull_requests: [{ number: 440 }],
          },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });

    expect(commands).toEqual([
      "prepare-ci",
      "prepare-workspace",
      "validate-workspace",
      "validate-workspace",
      "inspect-validation",
      "inspect-validation",
      "validate-workspace",
      "apply-ci",
    ]);
    expect(agentPrompts).toHaveLength(2);
    expect(agentPrompts[0]).toContain("Run only focused checks");
    expect(agentPrompts[1]).toContain("fix_ci mode");
    expect(agentPrompts[1]).toContain('"attempt":1');
    expect(appliedAnalysis?.failures).toEqual([
      expect.objectContaining({
        checkRunId: 701,
        disposition: "fixed",
      }),
    ]);
    expect(appliedAnalysis?.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "task lint",
          status: "passed",
          details: expect.stringContaining("1 local validation repair attempt"),
        }),
      ]),
    );
    expect(result).toEqual({
      ok: true,
      repository: "chaitin/agent-compose",
      checkSuiteId: 88001,
      results: [{ ok: true, applied: true, outcome: "fixed" }],
    });
  });

  it("ignores successful workflow runs without invoking a sandbox", async () => {
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

    const result = handlers.get("webhook.github.workflow_run")?.({
      payload: {
        body: {
          action: "completed",
          workflow_run: {
            check_suite_id: 88001,
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
      reason: "workflow run does not have a supported failure conclusion",
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
    : env.DRAFT_PR_WORKSPACE_VALIDATE === "1"
      ? "validate-workspace"
      : (env.DRAFT_PR_COMMAND ?? "");
}
