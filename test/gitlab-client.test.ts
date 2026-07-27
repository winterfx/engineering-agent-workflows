import { describe, expect, it } from "vitest";
import { GitLabClient } from "../src/gitlab/client.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: Record<string, unknown>;
}

describe("GitLabClient", () => {
  it("authenticates and normalizes an Issue from a nested project path", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitLabClient({
      token: "api-token",
      baseUrl: "https://gitlab.test/api/v4/",
      fetch: recordingFetch(requests, () =>
        jsonResponse({
          iid: 410,
          title: "Broken API",
          description: "Observed in production",
          state: "opened",
          web_url: "https://gitlab.test/group/subgroup/project/-/issues/410",
          updated_at: "2026-07-24T10:00:00Z",
          labels: ["bug"],
          author: { username: "author" },
        }),
      ),
    });

    const issue = await client.getIssue("group/subgroup/project", 410);

    expect(issue).toEqual({
      number: 410,
      title: "Broken API",
      body: "Observed in production",
      state: "opened",
      htmlUrl: "https://gitlab.test/group/subgroup/project/-/issues/410",
      updatedAt: "2026-07-24T10:00:00Z",
      labels: ["bug"],
      user: { login: "author", type: "User" },
    });
    expect(requests[0]?.url).toBe(
      "https://gitlab.test/api/v4/projects/group%2Fsubgroup%2Fproject/issues/410",
    );
    expect(requests[0]?.headers.get("PRIVATE-TOKEN")).toBe("api-token");
  });

  it("loads every Note page and excludes GitLab system Notes", async () => {
    const requests: RecordedRequest[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `note ${index + 1}`,
      author: { username: "author" },
    }));
    firstPage[20] = {
      id: 21,
      body: "changed label",
      author: { username: "author" },
      system: true,
    } as (typeof firstPage)[number];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.test/api/v4",
      fetch: recordingFetch(requests, (request) =>
        request.url.includes("page=2")
          ? jsonResponse([{ id: 101, body: "new author information" }])
          : jsonResponse(firstPage, { "X-Next-Page": "2" }),
      ),
    });

    const comments = await client.listComments("example/project", 410);

    expect(comments).toHaveLength(100);
    expect(comments.some((comment) => comment.id === 21)).toBe(false);
    expect(comments.at(-1)?.body).toBe("new author information");
    expect(requests.map((request) => request.url)).toEqual([
      "https://gitlab.test/api/v4/projects/example%2Fproject/issues/410/notes?per_page=100&page=1&sort=asc&order_by=created_at",
      "https://gitlab.test/api/v4/projects/example%2Fproject/issues/410/notes?per_page=100&page=2&sort=asc&order_by=created_at",
    ]);
  });

  it("uses GitLab label, Issue, and Note write endpoints", async () => {
    const requests: RecordedRequest[] = [];
    const client = new GitLabClient({
      baseUrl: "https://gitlab.test/api/v4",
      fetch: recordingFetch(requests, (request) => {
        if (
          request.method === "GET" &&
          request.url.endsWith("/labels/priority%3AP1")
        ) {
          return jsonResponse({ message: "404 Label Not Found" }, {}, 404);
        }
        if (request.url.includes("/notes")) {
          return jsonResponse({
            id: 77,
            body: String(request.body?.body ?? ""),
          });
        }
        return jsonResponse({
          iid: 410,
          title: String(request.body?.title ?? "Updated title"),
          description: "body",
          state: "opened",
          web_url: "https://gitlab.test/example/project/-/issues/410",
          updated_at: "2026-07-24T10:00:00Z",
          labels: [],
        });
      }),
    });

    await client.ensureLabel(
      "example/project",
      "priority:P1",
      "ff0000",
      "Automated triage: high-priority impact",
    );
    await client.addLabels("example/project", 410, ["priority:P1", "bug"]);
    await client.removeLabel("example/project", 410, "priority:P3");
    await client.createComment("example/project", 410, "triage report");
    await client.updateComment("example/project", 410, 77, "new report");

    expect(
      requests.map(({ url, method, body }) => ({
        path: new URL(url).pathname,
        method,
        body,
      })),
    ).toEqual([
      {
        path: "/api/v4/projects/example%2Fproject/labels/priority%3AP1",
        method: "GET",
        body: undefined,
      },
      {
        path: "/api/v4/projects/example%2Fproject/labels",
        method: "POST",
        body: {
          name: "priority:P1",
          color: "#ff0000",
          description: "Automated triage: high-priority impact",
        },
      },
      {
        path: "/api/v4/projects/example%2Fproject/issues/410",
        method: "PUT",
        body: { add_labels: "priority:P1,bug" },
      },
      {
        path: "/api/v4/projects/example%2Fproject/issues/410",
        method: "PUT",
        body: { remove_labels: "priority:P3" },
      },
      {
        path: "/api/v4/projects/example%2Fproject/issues/410/notes",
        method: "POST",
        body: { body: "triage report" },
      },
      {
        path: "/api/v4/projects/example%2Fproject/issues/410/notes/77",
        method: "PUT",
        body: { body: "new report" },
      },
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
