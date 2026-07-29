import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("GitHub Issue triage scheduler script", () => {
  it("registers only GitHub topics and passes comment senders to the bot guard", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    let shellScript = "";
    let senderLogin = "";
    let toolChunks: string[] = [];
    let workflowPolicyJson = "";
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        shell(script: string, options: { env: Record<string, string> }) {
          shellScript = script;
          senderLogin = options.env.TRIAGE_SENDER_LOGIN ?? "";
          workflowPolicyJson = options.env.WORKFLOW_POLICY_JSON ?? "";
          toolChunks = Object.entries(options.env)
            .filter(([name]) => name.startsWith("WORKFLOW_TOOL_CHUNK_"))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, value]) => value);
          return {
            success: true,
            stdout: JSON.stringify({
              ok: true,
              ignored: true,
              reason: "event was emitted by the triage bot",
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
          issue: { number: 41 },
          repository: { full_name: "chaitin/agent-compose" },
          sender: { login: "triage-bot" },
        },
      },
    });

    expect([...handlers.keys()].sort()).toEqual([
      "webhook.github.issue_comment",
      "webhook.github.issues",
    ]);
    expect(result).toEqual({
      ok: true,
      ignored: true,
      reason: "event was emitted by the triage bot",
    });
    expect(senderLogin).toBe("triage-bot");
    expect(shellScript).toContain("GITHUB_BOT_LOGIN");
    expect(shellScript).toContain('Buffer.from(source, "base64")');
    expect(toolChunks.length).toBeGreaterThan(1);
    expect(toolChunks.every((chunk) => chunk.length <= 60000)).toBe(true);
    expect(JSON.parse(workflowPolicyJson)).toEqual(
      expect.objectContaining({ version: 1 }),
    );
  });

  it("routes GitHub Issue events and ignores pull requests", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands: string[] = [];
    const senderLogins: string[] = [];
    const context = vm.createContext({
      scheduler: {
        on(
          topic: string,
          _triggerID: string,
          handler: (event: unknown) => unknown,
        ) {
          handlers.set(topic, handler);
        },
        shell(_script: string, options: { env: Record<string, string> }) {
          commands.push(options.env.TRIAGE_COMMAND ?? "");
          senderLogins.push(options.env.TRIAGE_SENDER_LOGIN ?? "");
          const result =
            options.env.TRIAGE_COMMAND === "prepare"
              ? {
                  ok: true,
                  repository: "chaitin/agent-compose",
                  issueNumber: 41,
                  issueFingerprint: "fingerprint",
                  issue: { title: "API failure" },
                  comments: [],
                  candidates: [],
                }
              : { ok: true, applied: false, commentAction: "dry-run" };
          return { success: true, stdout: JSON.stringify(result) };
        },
        agent() {
          return {
            success: true,
            finalText: JSON.stringify({ issueType: "bug" }),
          };
        },
      },
    });
    new vm.Script(await schedulerScript()).runInContext(context);

    const pullRequestResult = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "opened",
          issue: {
            number: 41,
            pull_request: { url: "https://github.test/pulls/41" },
          },
        },
      },
    });
    expect(pullRequestResult).toEqual({
      ok: true,
      ignored: true,
      reason: "pull request payload is not an issue",
    });

    const result = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "opened",
          issue: { number: 41 },
          repository: { full_name: "chaitin/agent-compose" },
          sender: { login: "author" },
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      applied: false,
      commentAction: "dry-run",
    });

    for (const action of ["labeled", "unlabeled"]) {
      const labelResult = handlers.get("webhook.github.issues")?.({
        payload: {
          body: {
            action,
            label: { name: "skip-triage" },
            issue: { number: 41 },
            repository: { full_name: "chaitin/agent-compose" },
            sender: { login: "maintainer" },
          },
        },
      });
      expect(labelResult).toEqual({
        ok: true,
        applied: false,
        commentAction: "dry-run",
      });
    }

    const unrelatedLabelResult = handlers.get("webhook.github.issues")?.({
      payload: {
        body: {
          action: "labeled",
          label: { name: "agent:ready" },
          issue: { number: 41 },
          repository: { full_name: "chaitin/agent-compose" },
        },
      },
    });
    expect(unrelatedLabelResult).toEqual({
      ok: true,
      ignored: true,
      reason: "label change is not a triage control event",
    });

    expect(commands).toEqual([
      "prepare",
      "apply",
      "prepare",
      "apply",
      "prepare",
      "apply",
    ]);
    expect(senderLogins).toEqual(["", "", "", "", "", ""]);
  });
});

async function schedulerScript(): Promise<string> {
  return readFile(
    new URL("../agents/issue-triage/scheduler.js", import.meta.url),
    "utf8",
  );
}
