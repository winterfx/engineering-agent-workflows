import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.js";
import type { GitHubComment } from "../src/github/types.js";

describe("GitHubClient comments", () => {
  it("loads every comment page so recent author replies are available", async () => {
    const requests: string[] = [];
    const firstPage: GitHubComment[] = Array.from(
      { length: 100 },
      (_, index) => ({
        id: index + 1,
        body: `comment ${index + 1}`,
      }),
    );
    const secondPage: GitHubComment[] = [
      { id: 101, body: "new author information" },
    ];
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const body = url.includes("page=2") ? secondPage : firstPage;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new GitHubClient({
      baseUrl: "https://github.test",
      fetch: fetchMock,
    });

    const comments = await client.listComments("example/repo", 410);

    expect(comments).toHaveLength(101);
    expect(comments.at(-1)?.body).toBe("new author information");
    expect(requests).toEqual([
      "https://github.test/repos/example/repo/issues/410/comments?per_page=100&page=1",
      "https://github.test/repos/example/repo/issues/410/comments?per_page=100&page=2",
    ]);
  });
});
