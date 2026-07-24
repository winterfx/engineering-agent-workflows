import { describe, expect, it } from "vitest";
import type { IssueCandidate } from "../src/github/types.js";
import {
  calculatePriority,
  makeDecision,
  mergeManagedLabels,
  type TriagePolicy,
} from "../src/issue-triage/policy.js";
import type { TriageAnalysis } from "../src/issue-triage/schema.js";

const policy: TriagePolicy = {
  version: 1,
  duplicateConfidenceThreshold: 0.92,
  titleConfidenceThreshold: 0.85,
  classificationConfidenceThreshold: 0.75,
  priorityConfidenceThreshold: 0.8,
  maxCandidates: 20,
  maxRelatedIssues: 5,
  managedLabelPrefixes: ["priority:", "triage:", "area:"],
  labelColors: {},
};

function analysis(overrides: Partial<TriageAnalysis> = {}): TriageAnalysis {
  return {
    normalizedTitle: "[API] Define structured payload types",
    summary: "Structured fields currently use unconstrained strings.",
    issueType: "enhancement",
    area: "api",
    classificationConfidence: 0.95,
    titleConfidence: 0.95,
    priorityConfidence: 0.9,
    facts: {
      environment: "unknown",
      productionImpact: "unknown",
      securityImpact: "none",
      dataLoss: null,
      coreFlowBlocked: null,
      workaround: "unknown",
      affectedScope: "unknown",
      slaRisk: null,
      releaseBlocker: null,
    },
    duplicate: { issueNumber: null, confidence: 0, reason: "" },
    relatedIssues: [],
    acceptanceCriteria: ["Define explicit payload types"],
    missingInformation: ["Does this block an API release?"],
    priorityReason: "No scheduling impact was supplied.",
    ...overrides,
  };
}

describe("calculatePriority", () => {
  it("assigns P0 only from explicit critical evidence", () => {
    const input = analysis();
    input.facts.securityImpact = "critical";

    expect(calculatePriority(input, policy)).toBe("P0");
  });

  it("leaves an enhancement pending when impact evidence is missing", () => {
    expect(calculatePriority(analysis(), policy)).toBe("pending");
  });

  it("assigns P1 to a production core-flow blocker without a workaround", () => {
    const input = analysis();
    input.facts.environment = "production";
    input.facts.productionImpact = "degraded";
    input.facts.coreFlowBlocked = true;
    input.facts.workaround = "none";

    expect(calculatePriority(input, policy)).toBe("P1");
  });
});

describe("makeDecision", () => {
  const candidates: IssueCandidate[] = [
    {
      number: 123,
      title: "Existing issue",
      body: "same problem",
      state: "open",
      labels: [],
      url: "https://github.test/issues/123",
    },
  ];

  it("rejects duplicate and related issue numbers not supplied as candidates", () => {
    const input = analysis({
      duplicate: {
        issueNumber: 999,
        confidence: 0.99,
        reason: "claimed duplicate",
      },
      relatedIssues: [
        { issueNumber: 999, reason: "not supplied" },
        { issueNumber: 123, reason: "valid candidate" },
      ],
    });

    const decision = makeDecision(input, candidates, policy);

    expect(decision.duplicateIssueNumber).toBeNull();
    expect(decision.relatedIssues).toEqual([
      { issueNumber: 123, reason: "valid candidate" },
    ]);
  });
});

describe("mergeManagedLabels", () => {
  it("replaces managed namespaces and preserves human labels", () => {
    expect(
      mergeManagedLabels(
        ["enhancement", "priority:P3", "area:legacy", "customer-important"],
        ["priority:P2", "area:api", "triage:done"],
        policy.managedLabelPrefixes,
      ),
    ).toEqual([
      "enhancement",
      "customer-important",
      "priority:P2",
      "area:api",
      "triage:done",
    ]);
  });
});
