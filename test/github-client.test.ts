import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

describe("GitHubClient", () => {
  it("retries transient GET transport failures", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: (async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), {
              code: "UND_ERR_CONNECT_TIMEOUT",
            }),
          });
        }
        return jsonResponse({ default_branch: "main" });
      }) as typeof fetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(
      client.getRepositoryDefaultBranch("chaitin/agent-compose"),
    ).resolves.toBe("main");
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("reports exhausted GET retries with safe request context and cause", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause });
      }) as typeof fetch,
      sleep: async () => undefined,
    });

    const error = await client
      .getRepositoryDefaultBranch("chaitin/agent-compose")
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      message:
        "GitHub API GET /repos/chaitin/agent-compose transport failed after 3 attempts",
      cause: expect.objectContaining({ message: "fetch failed" }),
    });
  });

  it("retries transient GitHub gateway responses", async () => {
    const statuses = [503, 502, 200];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: (async () => {
        const status = statuses.shift() ?? 500;
        return status === 200
          ? jsonResponse({ default_branch: "main" })
          : new Response("unavailable", { status });
      }) as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(
      client.getRepositoryDefaultBranch("chaitin/agent-compose"),
    ).resolves.toBe("main");
    expect(statuses).toEqual([]);
  });

  it("does not retry GitHub write requests", async () => {
    let attempts = 0;
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: (async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(
      client.createComment("chaitin/agent-compose", 41, "report"),
    ).rejects.toThrow("failed after 1 attempt");
    expect(attempts).toBe(1);
  });

  it("uses Bearer auth and normalizes an Issue", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      token: "github-token",
      baseUrl: "https://github.test/",
      fetch: recordingFetch(requests, () =>
        jsonResponse({
          number: 41,
          title: "API returns HTTP 500",
          body: "The endpoint fails consistently.",
          state: "open",
          html_url: "https://github.test/chaitin/agent-compose/issues/41",
          updated_at: "2026-07-26T10:00:00Z",
          labels: [{ name: "bug" }],
          user: { login: "author", type: "User" },
        }),
      ),
    });

    const issue = await client.getIssue("chaitin/agent-compose", 41);

    expect(issue).toEqual({
      number: 41,
      title: "API returns HTTP 500",
      body: "The endpoint fails consistently.",
      state: "open",
      htmlUrl: "https://github.test/chaitin/agent-compose/issues/41",
      updatedAt: "2026-07-26T10:00:00Z",
      labels: ["bug"],
      user: { login: "author", type: "User" },
    });
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer github-token",
    );
    expect(requests[0]?.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("searches only Issues and excludes pull requests", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, () =>
        jsonResponse({
          items: [
            {
              number: 41,
              title: "Current issue",
              body: "same",
              state: "open",
              html_url: "https://github.test/current",
              updated_at: "2026-07-26T10:00:00Z",
              labels: [],
            },
            {
              number: 42,
              title: "Related API failure",
              body: "related",
              state: "open",
              html_url: "https://github.test/related",
              updated_at: "2026-07-26T10:00:00Z",
              labels: ["reliability"],
            },
            {
              number: 43,
              title: "API pull request",
              body: "not an issue",
              state: "open",
              html_url: "https://github.test/pull/43",
              updated_at: "2026-07-26T10:00:00Z",
              labels: [],
              pull_request: { url: "https://github.test/pulls/43" },
            },
          ],
        }),
      ),
    });

    const candidates = await client.searchCandidates(
      "chaitin/agent-compose",
      {
        number: 41,
        title: "API failure",
        body: "",
        state: "open",
        htmlUrl: "https://github.test/current",
        updatedAt: "2026-07-26T10:00:00Z",
        labels: [],
      },
      20,
    );

    expect(candidates.map((candidate) => candidate.number)).toEqual([42]);
    expect(requests[0]?.url).toContain("q=repo%3Achaitin%2Fagent-compose");
    expect(requests[0]?.url).toContain("is%3Aissue");
  });

  it("uses GitHub label and comment write endpoints", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, (request) => {
        if (request.method === "GET") {
          return jsonResponse({}, {}, 404);
        }
        if (request.url.includes("/comments")) {
          return jsonResponse({
            id: 9,
            body: String(request.body?.body ?? ""),
          });
        }
        return jsonResponse({
          number: 41,
          title: "Updated",
          body: "body",
          state: "open",
          html_url: "https://github.test/chaitin/agent-compose/issues/41",
          updated_at: "2026-07-26T10:00:00Z",
          labels: [],
        });
      }),
    });

    await client.ensureLabel(
      "chaitin/agent-compose",
      "priority:P1",
      "ff0000",
      "Automated triage: high-priority impact",
    );
    await client.addLabels("chaitin/agent-compose", 41, ["priority:P1"]);
    await client.removeLabel("chaitin/agent-compose", 41, "priority:P2");
    await client.createComment("chaitin/agent-compose", 41, "triage report");
    await client.updateComment(
      "chaitin/agent-compose",
      41,
      9,
      "updated report",
    );

    expect(
      requests.map(({ url, method, body }) => ({
        path: new URL(url).pathname,
        method,
        body,
      })),
    ).toEqual([
      {
        path: "/api/repos/chaitin/agent-compose/labels/priority%3AP1",
        method: "GET",
        body: undefined,
      },
      {
        path: "/api/repos/chaitin/agent-compose/labels",
        method: "POST",
        body: {
          name: "priority:P1",
          color: "ff0000",
          description: "Automated triage: high-priority impact",
        },
      },
      {
        path: "/api/repos/chaitin/agent-compose/issues/41/labels",
        method: "POST",
        body: { labels: ["priority:P1"] },
      },
      {
        path: "/api/repos/chaitin/agent-compose/issues/41/labels/priority%3AP2",
        method: "DELETE",
        body: undefined,
      },
      {
        path: "/api/repos/chaitin/agent-compose/issues/41/comments",
        method: "POST",
        body: { body: "triage report" },
      },
      {
        path: "/api/repos/chaitin/agent-compose/issues/comments/9",
        method: "PATCH",
        body: { body: "updated report" },
      },
    ]);
  });

  it("reads repository metadata and creates a Draft Pull Request", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, (request) => {
        if (
          request.method === "GET" &&
          request.url === "https://github.test/api/repos/chaitin/agent-compose"
        ) {
          return jsonResponse({ default_branch: "main" });
        }
        if (request.method === "GET") {
          return jsonResponse([
            {
              number: 440,
              html_url: "https://github.test/chaitin/agent-compose/pull/440",
              state: "open",
              draft: true,
              head: { ref: "codex/issue-439" },
              base: { ref: "main" },
            },
          ]);
        }
        return jsonResponse({
          number: 441,
          html_url: "https://github.test/chaitin/agent-compose/pull/441",
          state: "open",
          draft: true,
          head: { ref: String(request.body?.head ?? "") },
          base: { ref: String(request.body?.base ?? "") },
        });
      }),
    });

    expect(
      await client.getRepositoryDefaultBranch("chaitin/agent-compose"),
    ).toBe("main");
    const existing = await client.listOpenPullRequestsByHead(
      "chaitin/agent-compose",
      "codex/issue-439",
    );
    const created = await client.createDraftPullRequest(
      "chaitin/agent-compose",
      {
        title: "fix(webhooks): avoid ambiguous commit results",
        body: "Closes #439",
        head: "codex/issue-439",
        base: "main",
      },
    );

    expect(existing[0]?.number).toBe(440);
    expect(created).toMatchObject({ number: 441, draft: true });
    expect(requests[1]?.url).toContain("head=chaitin%3Acodex%2Fissue-439");
    expect(requests[2]?.body).toEqual({
      title: "fix(webhooks): avoid ambiguous commit results",
      body: "Closes #439",
      head: "codex/issue-439",
      base: "main",
      draft: true,
    });
  });

  it("reads managed Pull Request head metadata for review fixes", async () => {
    const requests: RecordedRequest[] = [];
    const pullRequest = {
      number: 440,
      html_url: "https://github.test/chaitin/agent-compose/pull/440",
      state: "open",
      draft: true,
      head: {
        ref: "codex/issue-439",
        sha: "a".repeat(40),
        repo: { full_name: "chaitin/agent-compose" },
      },
      base: { ref: "main" },
    };
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, (request) =>
        jsonResponse(
          request.url.endsWith("/pulls/440") ? pullRequest : [pullRequest],
        ),
      ),
    });

    const current = await client.getPullRequest("chaitin/agent-compose", 440);
    const open = await client.listOpenPullRequests("chaitin/agent-compose");

    expect(current).toMatchObject({
      head: "codex/issue-439",
      headSha: "a".repeat(40),
      headRepository: "chaitin/agent-compose",
    });
    expect(open).toHaveLength(1);
    expect(requests[1]?.url).toContain("pulls?state=open");
  });

  it("lists Pull Request review comments with inline diff context", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, () =>
        jsonResponse([
          {
            id: 501,
            body: "LastError remains set after recovery finishes.",
            user: { login: "monkeyscan[bot]", id: 9001, type: "Bot" },
            html_url:
              "https://github.test/chaitin/agent-compose/pull/440#discussion_r501",
            created_at: "2026-07-27T01:00:00Z",
            path: "pkg/sessions/deletion_recovery.go",
            line: 104,
            original_line: 104,
            side: "RIGHT",
            diff_hunk: "@@ -100,0 +101,4 @@",
            commit_id: "a".repeat(40),
            original_commit_id: "a".repeat(40),
            pull_request_review_id: 700,
          },
        ]),
      ),
    });

    const comments = await client.listReviewComments(
      "chaitin/agent-compose",
      440,
    );

    expect(comments).toEqual([
      expect.objectContaining({
        id: 501,
        path: "pkg/sessions/deletion_recovery.go",
        line: 104,
        originalLine: 104,
        side: "RIGHT",
        diffHunk: "@@ -100,0 +101,4 @@",
        commitId: "a".repeat(40),
        pullRequestReviewId: 700,
        user: { login: "monkeyscan[bot]", id: 9001, type: "Bot" },
      }),
    ]);
    expect(requests[0]?.url).toBe(
      "https://github.test/api/repos/chaitin/agent-compose/pulls/440/comments?per_page=100&page=1",
    );
  });

  it("reads a submitted Pull Request Review with trust metadata", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, () =>
        jsonResponse({
          id: 700,
          body: "Please address the recovery edge case.",
          state: "CHANGES_REQUESTED",
          commit_id: "a".repeat(40),
          author_association: "MEMBER",
          user: { login: "reviewer", id: 42, type: "User" },
          html_url:
            "https://github.test/chaitin/agent-compose/pull/440#pullrequestreview-700",
          submitted_at: "2026-07-27T01:00:00Z",
        }),
      ),
    });

    const review = await client.getPullRequestReview(
      "chaitin/agent-compose",
      440,
      700,
    );

    expect(review).toEqual({
      id: 700,
      body: "Please address the recovery edge case.",
      state: "CHANGES_REQUESTED",
      commitId: "a".repeat(40),
      authorAssociation: "MEMBER",
      user: { login: "reviewer", id: 42, type: "User" },
      htmlUrl:
        "https://github.test/chaitin/agent-compose/pull/440#pullrequestreview-700",
      submittedAt: "2026-07-27T01:00:00Z",
    });
    expect(requests[0]?.url).toBe(
      "https://github.test/api/repos/chaitin/agent-compose/pulls/440/reviews/700",
    );
  });

  it("lists failed check runs and annotations for a trusted commit SHA", async () => {
    const requests: RecordedRequest[] = [];
    const headSha = "a".repeat(40);
    const client = new GitHubClient({
      baseUrl: "https://github.test/api",
      fetch: recordingFetch(requests, (request) =>
        request.url.includes("/annotations")
          ? jsonResponse([
              {
                path: "pkg/webhooks/store.go",
                start_line: 42,
                end_line: 42,
                annotation_level: "failure",
                title: "Uncovered branch",
                message: "The committed error path is not covered.",
                raw_details: "coverage: 79.8%",
              },
            ])
          : jsonResponse({
              total_count: 1,
              check_runs: [
                {
                  id: 701,
                  name: "CI / Coverage gate",
                  status: "completed",
                  conclusion: "failure",
                  html_url: "https://github.test/checks/701",
                  check_suite: { id: 88001 },
                  output: {
                    title: "Coverage threshold not met",
                    summary: "Total coverage is below 80%.",
                    text: "Inspect the uncovered error branch.",
                  },
                },
              ],
            }),
      ),
    });

    const runs = await client.listCheckRuns("chaitin/agent-compose", headSha);
    const annotations = await client.listCheckRunAnnotations(
      "chaitin/agent-compose",
      701,
    );

    expect(runs).toEqual([
      expect.objectContaining({
        id: 701,
        checkSuiteId: 88001,
        name: "CI / Coverage gate",
        conclusion: "failure",
        output: expect.objectContaining({
          title: "Coverage threshold not met",
        }),
      }),
    ]);
    expect(annotations).toEqual([
      {
        path: "pkg/webhooks/store.go",
        startLine: 42,
        endLine: 42,
        level: "failure",
        title: "Uncovered branch",
        message: "The committed error path is not covered.",
        rawDetails: "coverage: 79.8%",
      },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      `https://github.test/api/repos/chaitin/agent-compose/commits/${headSha}/check-runs?per_page=100&page=1`,
      "https://github.test/api/repos/chaitin/agent-compose/check-runs/701/annotations?per_page=100&page=1",
    ]);
  });
});

function recordingFetch(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(rawBody
        ? { body: JSON.parse(rawBody) as Record<string, unknown> }
        : {}),
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
}

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
