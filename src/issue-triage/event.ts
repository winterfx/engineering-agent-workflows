import { z } from "zod";
import type {
  GitHubIssuesWebhook,
  LoaderEventEnvelope,
} from "../github/types.js";

const webhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    html_url: z.string(),
    updated_at: z.string(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
    user: z
      .object({ login: z.string(), type: z.string().optional() })
      .optional(),
    pull_request: z.unknown().optional(),
  }),
  repository: z.object({
    full_name: z.string().regex(/^[^/]+\/[^/]+$/),
    default_branch: z.string().optional(),
  }),
  sender: z
    .object({ login: z.string(), type: z.string().optional() })
    .optional(),
});

const supportedActions = new Set(["opened", "edited", "reopened"]);

export function parseIssueWebhook(input: unknown): GitHubIssuesWebhook {
  const envelope = input as LoaderEventEnvelope;
  const body = envelope?.payload?.body ?? input;
  return webhookSchema.parse(body) as GitHubIssuesWebhook;
}

export function ignoreReason(
  event: GitHubIssuesWebhook,
  botLogin?: string,
): string | null {
  if (!supportedActions.has(event.action)) {
    return `unsupported action: ${event.action}`;
  }
  if (event.issue.pull_request) {
    return "pull request payload is not an issue";
  }
  if (
    botLogin &&
    event.sender?.login.toLowerCase() === botLogin.toLowerCase()
  ) {
    return "event was emitted by the triage bot";
  }
  return null;
}
