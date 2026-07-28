import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("GitLab scheduler script", () => {
  it("runs without Node globals and ignores events emitted by the triage bot", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    let shellScript = "";
    let senderLogin = "";
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
    const script = await schedulerScript();

    new vm.Script(script).runInContext(context);
    const result = handlers.get("webhook.gitlab.issue")?.({
      payload: {
        body: {
          object_kind: "issue",
          user: { username: "triage-bot" },
          project: { path_with_namespace: "group/subgroup/project" },
          object_attributes: { action: "open", iid: 2 },
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      ignored: true,
      reason: "event was emitted by the triage bot",
    });
    expect(senderLogin).toBe("triage-bot");
    expect(shellScript).toContain("GITLAB_BOT_USERNAME");
  });

  it("passes prepare and apply values as per-command environment", async () => {
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
        shell(_script: string, options: { env: Record<string, string> }) {
          commands.push(options.env.TRIAGE_COMMAND ?? "");
          const result =
            options.env.TRIAGE_COMMAND === "prepare"
              ? {
                  ok: true,
                  repository: "group/project",
                  issueNumber: 2,
                  issueFingerprint: "fingerprint",
                  issue: { title: "test" },
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
    const script = await schedulerScript();

    new vm.Script(script).runInContext(context);
    const result = handlers.get("webhook.gitlab.issue")?.({
      payload: {
        body: {
          object_kind: "issue",
          user: { username: "author" },
          project: { path_with_namespace: "group/project" },
          object_attributes: { action: "open", iid: 2 },
        },
      },
    });

    expect(commands).toEqual(["prepare", "apply"]);
    expect(result).toEqual({
      ok: true,
      applied: false,
      commentAction: "dry-run",
    });
  });

  it("routes GitHub Issue events and ignores pull requests", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const providers: string[] = [];
    const toolProviders: string[] = [];
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
          providers.push(options.env.TRIAGE_PROVIDER ?? "");
          toolProviders.push(options.env.ISSUE_TRIAGE_PROVIDER ?? "");
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
    const script = await schedulerScript();
    new vm.Script(script).runInContext(context);

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

    expect(providers).toEqual(["github", "github"]);
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

    expect(providers).toEqual([
      "github",
      "github",
      "github",
      "github",
      "github",
      "github",
    ]);
    expect(toolProviders).toEqual(providers);
    expect(senderLogins).toEqual(["", "", "", "", "", ""]);
  });
});

async function schedulerScript(): Promise<string> {
  return readFile(
    new URL("../loaders/issue-triage.js", import.meta.url),
    "utf8",
  );
}
