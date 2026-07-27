import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_BODY_LIMIT = 1 << 20;

export interface GitHubWebhookRelayOptions {
  allowedRepository: string;
  daemonToken: string;
  daemonWebhookBaseUrl: string;
  fetch?: typeof fetch;
  secret: string;
}

export function validGitHubSignature(
  secret: string,
  body: Uint8Array,
  presented: string | null,
): boolean {
  if (!secret || !presented?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actualHex = presented.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(actualHex)) return false;
  const actual = Buffer.from(actualHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function topicForGitHubEvent(event: string): string | undefined {
  return {
    issues: "webhook.github.issues",
    issue_comment: "webhook.github.issue_comment",
    pull_request_review: "webhook.github.pull_request_review",
    pull_request_review_comment: "webhook.github.pull_request_review_comment",
    check_suite: "webhook.github.check_suite",
  }[event];
}

export async function handleGitHubWebhook(
  request: Request,
  options: GitHubWebhookRelayOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/github")
    return jsonResponse(404, { error: "not found" });
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > DEFAULT_BODY_LIMIT) {
    return jsonResponse(413, { error: "request body is too large" });
  }
  if (
    !validGitHubSignature(
      options.secret,
      rawBody,
      request.headers.get("x-hub-signature-256"),
    )
  ) {
    return jsonResponse(401, { error: "invalid GitHub signature" });
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return jsonResponse(400, { error: "body must be valid JSON" });
  }
  if (!isRecord(body)) {
    return jsonResponse(400, { error: "body must be a JSON object" });
  }

  const repository = body.repository;
  const fullName = isRecord(repository) ? repository.full_name : undefined;
  if (fullName !== options.allowedRepository) {
    return jsonResponse(403, { error: "repository is not allowed" });
  }

  const event = request.headers.get("x-github-event")?.trim() ?? "";
  if (event === "ping") return jsonResponse(200, { ok: true });
  const topic = topicForGitHubEvent(event);
  if (!topic)
    return jsonResponse(202, { ignored: true, reason: "unsupported event" });

  const delivery = request.headers.get("x-github-delivery")?.trim() ?? "";
  const headers = new Headers({
    Authorization: `Bearer ${options.daemonToken}`,
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
  });
  if (delivery) {
    headers.set("Idempotency-Key", delivery);
    headers.set("X-Correlation-ID", `github:${event}:${delivery}`);
    headers.set("X-GitHub-Delivery", delivery);
  }

  try {
    const downstream = await (options.fetch ?? fetch)(
      `${options.daemonWebhookBaseUrl.replace(/\/+$/, "")}/${topic}`,
      { method: "POST", headers, body: rawBody },
    );
    return new Response(await downstream.arrayBuffer(), {
      status: downstream.status,
      headers: {
        "Content-Type":
          downstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return jsonResponse(502, { error: "webhook daemon is unavailable" });
  }
}

export function createGitHubWebhookRelay(options: GitHubWebhookRelayOptions) {
  return createServer(async (request, response) => {
    try {
      const body = await readBody(request, DEFAULT_BODY_LIMIT);
      if (!body) {
        await writeResponse(
          response,
          jsonResponse(413, { error: "request body is too large" }),
        );
        return;
      }
      const result = await handleGitHubWebhook(
        new Request(`http://127.0.0.1${request.url ?? "/"}`, {
          method: request.method ?? "GET",
          headers: request.headers as HeadersInit,
          ...(request.method === "POST" ? { body: body.toString("utf8") } : {}),
        }),
        options,
      );
      await writeResponse(response, result);
    } catch {
      await writeResponse(
        response,
        jsonResponse(500, { error: "webhook relay failed" }),
      );
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(
  response: ServerResponse,
  result: Response,
): Promise<void> {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(Buffer.from(await result.arrayBuffer()));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function startFromEnvironment(): void {
  const host = process.env.GITHUB_WEBHOOK_LISTEN_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.GITHUB_WEBHOOK_LISTEN_PORT?.trim() || "7411");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("GITHUB_WEBHOOK_LISTEN_PORT is invalid");
  }
  const server = createGitHubWebhookRelay({
    allowedRepository: requiredEnvironment("GITHUB_ALLOWED_REPOSITORY"),
    daemonToken: requiredEnvironment("AGENT_COMPOSE_WEBHOOK_TOKEN"),
    daemonWebhookBaseUrl:
      process.env.AGENT_COMPOSE_WEBHOOK_BASE_URL?.trim() ||
      "http://172.18.0.1:7410/api/webhooks",
    secret: requiredEnvironment("GITHUB_WEBHOOK_SECRET"),
  });
  server.listen(port, host, () => {
    console.log(
      `GitHub webhook relay listening on http://${host}:${port}/github`,
    );
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startFromEnvironment();
}
