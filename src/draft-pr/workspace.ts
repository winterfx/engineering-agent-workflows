import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DraftPrInspection } from "./schema.js";

export interface PreparedDraftPrWorkspace {
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export interface DraftPrWorkspace {
  prepare(input: {
    repository: string;
    issueNumber: number;
    cloneUrl: string;
    baseBranch: string;
    branch: string;
  }): Promise<PreparedDraftPrWorkspace>;
  prepareReview(input: {
    repository: string;
    pullRequestNumber: number;
    cloneUrl: string;
    baseBranch: string;
    branch: string;
    expectedHeadSha: string;
  }): Promise<PreparedDraftPrWorkspace>;
  inspect(workspacePath: string): Promise<DraftPrInspection>;
  commitAndPush(
    workspacePath: string,
    branch: string,
    title: string,
    cloneUrl: string,
  ): Promise<string>;
  cleanup(repository: string, issueNumber: number): Promise<void>;
  cleanupReview(repository: string, pullRequestNumber: number): Promise<void>;
}

export interface GitDraftPrWorkspaceOptions {
  root: string;
  token: string;
  authorName: string;
  authorEmail: string;
  lockTtlMs?: number;
}

export class GitDraftPrWorkspace implements DraftPrWorkspace {
  readonly #root: string;
  readonly #token: string;
  readonly #authorName: string;
  readonly #authorEmail: string;
  readonly #lockTtlMs: number;

  constructor(options: GitDraftPrWorkspaceOptions) {
    this.#root = path.resolve(options.root);
    this.#token = options.token.trim();
    this.#authorName = options.authorName.trim();
    this.#authorEmail = options.authorEmail.trim();
    this.#lockTtlMs = options.lockTtlMs ?? 4 * 60 * 60 * 1000;
    if (!this.#token)
      throw new Error("GitHub token is required for Git workspace preparation");
    if (!this.#authorName || !this.#authorEmail) {
      throw new Error("Git author name and email are required");
    }
  }

  async prepare(input: {
    repository: string;
    issueNumber: number;
    cloneUrl: string;
    baseBranch: string;
    branch: string;
  }): Promise<PreparedDraftPrWorkspace> {
    validateCloneUrl(input.cloneUrl);
    validateGitRef(input.baseBranch, "base branch");
    validateGitRef(input.branch, "working branch");
    const paths = this.#paths(input.repository, "issue", input.issueNumber);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await this.#acquireLock(paths.lock);
    try {
      await rm(paths.workspace, { recursive: true, force: true });
      await mkdir(path.dirname(paths.workspace), { recursive: true });
      const env = await this.#authenticatedGitEnvironment();
      await runGit(
        [
          "clone",
          "--no-tags",
          "--depth=1",
          "--branch",
          input.baseBranch,
          "--",
          input.cloneUrl,
          paths.workspace,
        ],
        { cwd: this.#root, env },
      );
      const existing = await runGit(
        ["ls-remote", "--heads", "origin", `refs/heads/${input.branch}`],
        { cwd: paths.workspace, env },
      );
      if (existing.stdout.trim()) {
        throw new Error(`remote branch already exists: ${input.branch}`);
      }
      await runGit(["checkout", "-b", input.branch], {
        cwd: paths.workspace,
        env,
      });
      const baseCommit = (
        await runGit(["rev-parse", "HEAD"], { cwd: paths.workspace, env })
      ).stdout.trim();
      return {
        path: paths.workspace,
        branch: input.branch,
        baseBranch: input.baseBranch,
        baseCommit,
      };
    } catch (error) {
      await this.cleanup(input.repository, input.issueNumber);
      throw error;
    }
  }

  async prepareReview(input: {
    repository: string;
    pullRequestNumber: number;
    cloneUrl: string;
    baseBranch: string;
    branch: string;
    expectedHeadSha: string;
  }): Promise<PreparedDraftPrWorkspace> {
    validateCloneUrl(input.cloneUrl);
    validateGitRef(input.baseBranch, "base branch");
    validateGitRef(input.branch, "Pull Request branch");
    if (!/^[0-9a-f]{40}$/.test(input.expectedHeadSha)) {
      throw new Error("invalid expected Pull Request head SHA");
    }
    const paths = this.#paths(input.repository, "pr", input.pullRequestNumber);
    await mkdir(path.dirname(paths.lock), { recursive: true });
    await this.#acquireLock(paths.lock, "Pull Request");
    try {
      await rm(paths.workspace, { recursive: true, force: true });
      await mkdir(path.dirname(paths.workspace), { recursive: true });
      const env = await this.#authenticatedGitEnvironment();
      await runGit(
        [
          "clone",
          "--no-tags",
          "--depth=1",
          "--branch",
          input.branch,
          "--",
          input.cloneUrl,
          paths.workspace,
        ],
        { cwd: this.#root, env },
      );
      const headCommit = (
        await runGit(["rev-parse", "HEAD"], { cwd: paths.workspace, env })
      ).stdout.trim();
      if (headCommit !== input.expectedHeadSha) {
        throw new Error(
          "Pull Request head changed during workspace preparation",
        );
      }
      return {
        path: paths.workspace,
        branch: input.branch,
        baseBranch: input.baseBranch,
        baseCommit: headCommit,
      };
    } catch (error) {
      await this.cleanupReview(input.repository, input.pullRequestNumber);
      throw error;
    }
  }

  async inspect(workspacePath: string): Promise<DraftPrInspection> {
    const resolved = this.#assertWorkspacePath(workspacePath);
    const env = this.#localGitEnvironment();
    await runGit(["add", "-A"], { cwd: resolved, env });
    const [head, names, stats, check, diff] = await Promise.all([
      runGit(["rev-parse", "HEAD"], { cwd: resolved, env }),
      runGit(["diff", "--cached", "--name-only", "-z"], {
        cwd: resolved,
        env,
      }),
      runGit(["diff", "--cached", "--numstat"], { cwd: resolved, env }),
      runGit(["diff", "--cached", "--check"], {
        cwd: resolved,
        env,
        allowFailure: true,
      }),
      runGit(
        [
          "diff",
          "--cached",
          "--unified=0",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
        ],
        {
          cwd: resolved,
          env,
          maxOutputBytes: 8 * 1024 * 1024,
        },
      ),
    ]);
    const changedFiles = names.stdout.split("\0").filter(Boolean);
    let additions = 0;
    let deletions = 0;
    for (const line of stats.stdout.split("\n")) {
      const [added, deleted] = line.split("\t");
      if (/^\d+$/.test(added ?? "")) additions += Number(added);
      if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
    }
    return {
      headCommit: head.stdout.trim(),
      changedFiles,
      additions,
      deletions,
      diffCheckPassed: check.exitCode === 0,
      secretFindingPaths: scanAddedLinesForSecrets(diff.stdout),
    };
  }

  async commitAndPush(
    workspacePath: string,
    branch: string,
    title: string,
    cloneUrl: string,
  ): Promise<string> {
    const resolved = this.#assertWorkspacePath(workspacePath);
    validateGitRef(branch, "working branch");
    validateCloneUrl(cloneUrl);
    await this.#writeTrustedGitConfig(resolved, cloneUrl);
    const localEnv = this.#localGitEnvironment();
    await runGit(
      [
        "-c",
        `user.name=${this.#authorName}`,
        "-c",
        `user.email=${this.#authorEmail}`,
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        title,
      ],
      { cwd: resolved, env: localEnv },
    );
    const authenticatedEnv = await this.#authenticatedGitEnvironment();
    await runGit(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "push",
        "--no-verify",
        "--set-upstream",
        "origin",
        branch,
      ],
      {
        cwd: resolved,
        env: authenticatedEnv,
      },
    );
    return (
      await runGit(["rev-parse", "HEAD"], { cwd: resolved, env: localEnv })
    ).stdout.trim();
  }

  async cleanup(repository: string, issueNumber: number): Promise<void> {
    const paths = this.#paths(repository, "issue", issueNumber);
    await rm(paths.workspace, { recursive: true, force: true });
    await rm(paths.lock, { recursive: true, force: true });
  }

  async cleanupReview(
    repository: string,
    pullRequestNumber: number,
  ): Promise<void> {
    const paths = this.#paths(repository, "pr", pullRequestNumber);
    await rm(paths.workspace, { recursive: true, force: true });
    await rm(paths.lock, { recursive: true, force: true });
  }

  #paths(
    repository: string,
    kind: "issue" | "pr",
    number: number,
  ): {
    workspace: string;
    lock: string;
  } {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(
        `${kind === "issue" ? "Issue" : "Pull Request"} number must be a positive integer`,
      );
    }
    const key = crypto
      .createHash("sha256")
      .update(repository.trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
    return {
      workspace: path.join(
        this.#root,
        "repositories",
        key,
        `${kind}-${number}`,
      ),
      lock: path.join(this.#root, ".locks", `${key}-${kind}-${number}`),
    };
  }

  #assertWorkspacePath(value: string): string {
    const resolved = path.resolve(value);
    const expectedPrefix = `${path.join(this.#root, "repositories")}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix)) {
      throw new Error("workspace path is outside the configured Draft PR root");
    }
    return resolved;
  }

  async #acquireLock(lockPath: string, target = "Issue"): Promise<void> {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= this.#lockTtlMs) {
      throw new Error(`another Draft PR run already holds the ${target} lock`);
    }
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
  }

  #localGitEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  async #authenticatedGitEnvironment(): Promise<NodeJS.ProcessEnv> {
    await mkdir(this.#root, { recursive: true });
    const askPass = path.join(this.#root, ".git-askpass.sh");
    await writeFile(
      askPass,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  *Username*) printf "%s" "x-access-token" ;;',
        '  *) printf "%s" "$DRAFT_PR_GIT_TOKEN" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(askPass, 0o700);
    return {
      ...this.#localGitEnvironment(),
      GIT_ASKPASS: askPass,
      DRAFT_PR_GIT_TOKEN: this.#token,
    };
  }

  async #writeTrustedGitConfig(
    workspacePath: string,
    cloneUrl: string,
  ): Promise<void> {
    const gitDirectory = path.join(workspacePath, ".git");
    const gitDirectoryInfo = await lstat(gitDirectory);
    if (!gitDirectoryInfo.isDirectory() || gitDirectoryInfo.isSymbolicLink()) {
      throw new Error("prepared workspace .git directory was replaced");
    }
    const configPath = path.join(gitDirectory, "config");
    const configInfo = await lstat(configPath);
    if (!configInfo.isFile() || configInfo.isSymbolicLink()) {
      throw new Error("prepared workspace Git config was replaced");
    }
    await writeFile(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tfilemode = true",
        "\tbare = false",
        "\tlogallrefupdates = true",
        "\thooksPath = /dev/null",
        '[remote "origin"]',
        `\turl = ${cloneUrl}`,
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
}

interface RunGitOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  maxOutputBytes?: number;
}

async function runGit(
  args: string[],
  options: RunGitOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const safeArgs = options.cwd
    ? ["-c", `safe.directory=${options.cwd}`, ...args]
    : args;
  return new Promise((resolve, reject) => {
    const child = spawn("git", safeArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const max = options.maxOutputBytes ?? 2 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let size = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size <= max) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size <= max) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      if (size > max) {
        reject(new Error("git command output exceeded the configured limit"));
      } else if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `git ${args[0] ?? "command"} failed: ${stderr.trim().slice(-2000)}`,
          ),
        );
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    });
  });
}

function validateCloneUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Draft PR clone URL must be credential-free HTTPS");
  }
}

function validateGitRef(value: string, name: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

function scanAddedLinesForSecrets(diff: string): string[] {
  const findings = new Set<string>();
  let currentPath = "unknown";
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bghp_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i,
  ];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) currentPath = line.slice(6);
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (patterns.some((pattern) => pattern.test(line)))
      findings.add(currentPath);
  }
  return [...findings].sort();
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
