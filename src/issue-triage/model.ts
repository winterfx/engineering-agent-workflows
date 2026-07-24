import runtime from "@chaitin-ai/agent-compose-runtime-sdk";
import type { GitHubIssue, IssueCandidate } from "../github/types.js";
import { buildTriagePrompt, type AgentText } from "./prompt.js";
import type { TriagePolicy } from "./policy.js";
import { triageAnalysisSchema, type TriageAnalysis } from "./schema.js";

export interface TriageModelInput {
  issue: GitHubIssue;
  repository: string;
  candidates: IssueCandidate[];
  policy: TriagePolicy;
  agentText: AgentText;
}

export interface TriageModel {
  analyze(input: TriageModelInput): Promise<TriageAnalysis>;
}

export class RuntimeTriageModel implements TriageModel {
  readonly #model: string | undefined;
  readonly #timeoutMs: number;

  constructor(model?: string, timeoutMs = 5 * 60 * 1000) {
    this.#model = model?.trim() || undefined;
    this.#timeoutMs = timeoutMs;
  }

  async analyze(input: TriageModelInput): Promise<TriageAnalysis> {
    const result = await runtime.llm(
      buildTriagePrompt(
        input.issue,
        input.repository,
        input.candidates,
        input.policy,
        input.agentText,
      ),
      {
        ...(this.#model ? { model: this.#model } : {}),
        timeoutMs: this.#timeoutMs,
        outputSchema: triageAnalysisSchema,
      },
    );
    if (!result.json) {
      throw new Error("issue triage model returned no structured result");
    }
    return result.json;
  }
}
