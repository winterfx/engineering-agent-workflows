import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveGitHubToken } from "../src/github/app-auth.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
}

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const privateKeyBase64 = Buffer.from(privateKey).toString("base64");

describe("GitHub App authentication", () => {
  it("keeps a configured static token as a backwards-compatible override", async () => {
    const token = await resolveGitHubToken(
      "chaitin/agent-compose",
      {
        GITHUB_TOKEN: " legacy-token ",
        GITHUB_APP_CLIENT_ID: "Iv1.app-client",
        GITHUB_APP_PRIVATE_KEY_BASE64: "not-used",
      },
      {
        fetch: (() => {
          throw new Error("fetch should not be called");
        }) as typeof fetch,
      },
    );

    expect(token).toBe("legacy-token");
  });

  it("discovers the repository installation and creates a signed token", async () => {
    const requests: RecordedRequest[] = [];
    const now = Date.UTC(2026, 6, 29, 10, 0, 0);
    const token = await resolveGitHubToken(
      "chaitin/agent-compose",
      {
        GITHUB_APP_CLIENT_ID: "Iv1.app-client",
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
        GITHUB_API_URL: "https://github.test/api/",
      },
      {
        now: () => now,
        fetch: recordingFetch(requests, (request) =>
          request.method === "GET"
            ? jsonResponse({ id: 987654 })
            : jsonResponse({
                token: "ghs_installation-token",
                expires_at: "2026-07-29T11:00:00Z",
              }),
        ),
      },
    );

    expect(token).toBe("ghs_installation-token");
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://github.test/api/repos/chaitin/agent-compose/installation",
        method: "GET",
      },
      {
        url: "https://github.test/api/app/installations/987654/access_tokens",
        method: "POST",
      },
    ]);

    const jwt = requests[0]?.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "");
    expect(jwt).toBeTruthy();
    const [header, payload, signature] = jwt!.split(".");
    expect(
      JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    ).toEqual({ alg: "RS256", typ: "JWT" });
    expect(
      JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
    ).toEqual({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 9 * 60,
      iss: "Iv1.app-client",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keyPair.publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(requests[1]?.headers.get("Authorization")).toBe(`Bearer ${jwt}`);
    expect(requests[0]?.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28");
  });

  it("uses App ID and a configured installation without discovery", async () => {
    const requests: RecordedRequest[] = [];
    const token = await resolveGitHubToken(
      "chaitin/agent-compose",
      {
        GITHUB_APP_ID: "123456",
        GITHUB_APP_INSTALLATION_ID: "987654",
        GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
      },
      {
        fetch: recordingFetch(requests, () =>
          jsonResponse({ token: "installation-token" }),
        ),
      },
    );

    expect(token).toBe("installation-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        url: "https://api.github.com/app/installations/987654/access_tokens",
        method: "POST",
      }),
    );
    const jwt = requests[0]?.headers.get("Authorization")?.slice(7) ?? "";
    const payload = jwt.split(".")[1] ?? "";
    expect(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    ).toEqual(expect.objectContaining({ iss: "123456" }));
  });

  it("rejects incomplete or invalid App configuration before a request", async () => {
    await expect(
      resolveGitHubToken("chaitin/agent-compose", {
        GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
      }),
    ).rejects.toThrow("GITHUB_APP_CLIENT_ID or GITHUB_APP_ID");

    await expect(
      resolveGitHubToken("chaitin/agent-compose", {
        GITHUB_APP_CLIENT_ID: "Iv1.app-client",
      }),
    ).rejects.toThrow("GITHUB_APP_PRIVATE_KEY_BASE64");

    await expect(
      resolveGitHubToken("chaitin/agent-compose", {
        GITHUB_APP_CLIENT_ID: "Iv1.app-client",
        GITHUB_APP_INSTALLATION_ID: "not-an-id",
        GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
      }),
    ).rejects.toThrow("must be a positive integer");
  });

  it("reports installation lookup failures without exposing the JWT", async () => {
    await expect(
      resolveGitHubToken(
        "chaitin/agent-compose",
        {
          GITHUB_APP_CLIENT_ID: "Iv1.app-client",
          GITHUB_APP_PRIVATE_KEY_BASE64: privateKeyBase64,
        },
        {
          fetch: recordingFetch(
            [],
            () => new Response("denied", { status: 403, statusText: "Denied" }),
          ),
        },
      ),
    ).rejects.toThrow("GitHub App installation lookup failed with 403 Denied");
  });
});

function recordingFetch(
  requests: RecordedRequest[],
  respond: (request: RecordedRequest) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
