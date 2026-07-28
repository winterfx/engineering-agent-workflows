import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitDraftPrWorkspace,
  gitCurlResolveEnvironment,
} from "../src/draft-pr/workspace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Git Draft PR workspace", () => {
  it("scopes a configured GitHub resolve override to Git curl", () => {
    expect(gitCurlResolveEnvironment("github.com:443:172.18.0.1")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.curloptResolve",
      GIT_CONFIG_VALUE_0: "github.com:443:172.18.0.1",
    });
    expect(() =>
      gitCurlResolveEnvironment("example.com:443:172.18.0.1"),
    ).toThrow("must use github.com:443:<IPv4>");
  });

  it("inspects staged and untracked changes without moving HEAD", async () => {
    const { workspace, workspacePath, head } = await localWorkspace();
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    await writeFile(path.join(workspacePath, "new.txt"), "new\n");

    const inspection = await workspace.inspect(workspacePath);

    expect(inspection.headCommit).toBe(head);
    expect(inspection.changedFiles).toEqual(["new.txt", "tracked.txt"]);
    expect(inspection.diffCheckPassed).toBe(true);
    expect(inspection.additions).toBeGreaterThan(0);
    expect(inspection.secretFindingPaths).toEqual([]);
  });

  it("reports only paths when added lines resemble credential material", async () => {
    const { workspace, workspacePath } = await localWorkspace();
    await writeFile(
      path.join(workspacePath, "secret.txt"),
      "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n",
    );

    const inspection = await workspace.inspect(workspacePath);

    expect(inspection.secretFindingPaths).toEqual(["secret.txt"]);
  });

  it("rejects a replaced Git config before authenticated push", async () => {
    const { workspace, workspacePath } = await localWorkspace();
    await writeFile(path.join(workspacePath, "tracked.txt"), "changed\n");
    await workspace.inspect(workspacePath);
    const configPath = path.join(workspacePath, ".git", "config");
    const replacementPath = path.join(workspacePath, "replacement-config");
    await writeFile(replacementPath, "[credential]\n\thelper = malicious\n");
    await rm(configPath);
    await symlink(replacementPath, configPath);

    await expect(
      workspace.commitAndPush(
        workspacePath,
        "codex/issue-439",
        "fix: test",
        "https://github.com/chaitin/agent-compose.git",
      ),
    ).rejects.toThrow("Git config was replaced");
  });
});

async function localWorkspace(): Promise<{
  workspace: GitDraftPrWorkspace;
  workspacePath: string;
  head: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "draft-pr-workspace-"));
  temporaryRoots.push(root);
  const repository = "chaitin/agent-compose";
  const key = crypto
    .createHash("sha256")
    .update(repository)
    .digest("hex")
    .slice(0, 16);
  const workspacePath = path.join(root, "repositories", key, "issue-439");
  await mkdir(workspacePath, { recursive: true });
  git(workspacePath, "init");
  git(workspacePath, "config", "user.name", "Test");
  git(workspacePath, "config", "user.email", "test@example.com");
  await writeFile(path.join(workspacePath, "tracked.txt"), "original\n");
  git(workspacePath, "add", "tracked.txt");
  git(workspacePath, "commit", "-m", "initial");
  const head = git(workspacePath, "rev-parse", "HEAD").trim();
  return {
    workspace: new GitDraftPrWorkspace({
      root,
      token: "test-token",
      authorName: "Test",
      authorEmail: "test@example.com",
    }),
    workspacePath,
    head,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
