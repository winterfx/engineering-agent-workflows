import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentText } from "./prompt.js";
import type { TriagePolicy } from "./policy.js";

const policySchema = z.object({
  version: z.number().int().positive(),
  duplicateConfidenceThreshold: z.number().min(0).max(1),
  titleConfidenceThreshold: z.number().min(0).max(1),
  classificationConfidenceThreshold: z.number().min(0).max(1),
  priorityConfidenceThreshold: z.number().min(0).max(1),
  maxCandidates: z.number().int().min(0).max(100),
  maxRelatedIssues: z.number().int().min(0).max(20),
  managedLabelPrefixes: z.array(z.string().min(1)),
  labelColors: z.record(z.string(), z.string().regex(/^[0-9a-fA-F]{6}$/)),
});

export interface IssueTriageDefinition {
  policy: TriagePolicy;
  agentText: AgentText;
}

export async function loadIssueTriageDefinition(
  repositoryRoot = process.cwd(),
): Promise<IssueTriageDefinition> {
  const root = path.join(repositoryRoot, "agents", "issue-triage");
  const [instructions, prompt, policyText] = await Promise.all([
    readFile(path.join(root, "AGENTS.md"), "utf8"),
    readFile(path.join(root, "prompt.md"), "utf8"),
    readFile(path.join(root, "policy.json"), "utf8"),
  ]);
  return {
    policy: policySchema.parse(JSON.parse(policyText)),
    agentText: { instructions, prompt },
  };
}
