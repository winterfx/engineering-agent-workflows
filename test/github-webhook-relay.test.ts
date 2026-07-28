import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleGitHubWebhook,
  topicForGitHubEvent,
  validGitHubSignature,
} from "../src/github/webhook-relay.js";

const secret = "webhook-secret";
const payload = JSON.stringify({
  action: "opened",
  repository: { full_name: "winterfx/batonboard" },
  issue: { number: 7 },
});

describe("GitHub webhook relay", () => {
  it("validates GitHub SHA-256 signatures in constant-length form", () => {
    const body = new TextEncoder().encode(payload);
    expect(validGitHubSignature(secret, body, signature(payload))).toBe(true);
    expect(validGitHubSignature(secret, body, "sha256=bad")).toBe(false);
    expect(validGitHubSignature(secret, body, null)).toBe(false);
  });

  it("maps supported GitHub event names to scheduler topics", () => {
    expect(topicForGitHubEvent("issues")).toBe("webhook.github.issues");
    expect(topicForGitHubEvent("issue_comment")).toBe(
      "webhook.github.issue_comment",
    );
    expect(topicForGitHubEvent("push")).toBeUndefined();
  });

  it("forwards an authenticated delivery with daemon auth and idempotency", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ accepted: true }, { status: 202 }),
    );

    const response = await handleGitHubWebhook(
      webhookRequest("issues"),
      relayOptions(fetch),
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://daemon.test/api/webhooks/webhook.github.issues");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer daemon-token");
    expect(headers.get("Idempotency-Key")).toBe("delivery-7");
    expect(headers.get("X-GitHub-Delivery")).toBe("delivery-7");
    expect(init?.body).toEqual(new TextEncoder().encode(payload));
  });

  it("rejects invalid signatures and repositories before forwarding", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const badSignature = webhookRequest("issues", "sha256=" + "0".repeat(64));
    expect(
      (await handleGitHubWebhook(badSignature, relayOptions(fetch))).status,
    ).toBe(401);

    const foreignPayload = JSON.stringify({
      repository: { full_name: "other/repository" },
    });
    const foreign = webhookRequest(
      "issues",
      signature(foreignPayload),
      foreignPayload,
    );
    expect(
      (await handleGitHubWebhook(foreign, relayOptions(fetch))).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function webhookRequest(
  event: string,
  presentedSignature = signature(payload),
  body = payload,
): Request {
  return new Request("https://relay.test/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Delivery": "delivery-7",
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": presentedSignature,
    },
    body,
  });
}

function relayOptions(fetch: typeof globalThis.fetch) {
  return {
    allowedRepository: "winterfx/batonboard",
    daemonToken: "daemon-token",
    daemonWebhookBaseUrl: "http://daemon.test/api/webhooks",
    fetch,
    secret,
  };
}
