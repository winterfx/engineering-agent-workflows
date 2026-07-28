import { describe, expect, it } from "vitest";
import type { IssueCandidate } from "../src/issues/types.js";
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
  classificationConfidenceThreshold: 0.75,
  priorityConfidenceThreshold: 0.8,
  maxCandidates: 20,
  maxRelatedIssues: 5,
  skipLabels: ["skip-triage"],
  managedLabelPrefixes: ["priority:", "triage:"],
  classificationLabels: {
    bug: "bug",
    enhancement: "enhancement",
    documentation: "documentation",
    question: "question",
  },
  labelColors: {},
  labelDescriptions: {},
};

function analysis(overrides: Partial<TriageAnalysis> = {}): TriageAnalysis {
  return {
    issueType: "enhancement",
    classificationConfidence: 0.95,
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
      url: "https://github.test/example/repo/issues/123",
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

  it("classifies the Issue type using the existing type label taxonomy", () => {
    const decision = makeDecision(analysis(), candidates, policy);

    expect(decision.labels).toContain("enhancement");
    expect(decision.classification).toEqual({
      label: "enhancement",
      source: "analysis",
    });
  });

  it("supports documentation and never creates an unknown type label", () => {
    const documentation = makeDecision(
      analysis({ issueType: "documentation" }),
      candidates,
      policy,
    );
    const unknown = makeDecision(
      analysis({ issueType: "unknown" }),
      candidates,
      policy,
    );

    expect(documentation.labels).toContain("documentation");
    expect(unknown.labels).not.toContain("unknown");
    expect(unknown.classification).toEqual({
      label: null,
      source: "unknown",
    });
  });

  it("preserves one existing type instead of adding a conflicting analysis", () => {
    const decision = makeDecision(analysis(), candidates, policy, ["BUG"]);

    expect(decision.classification).toEqual({
      label: "bug",
      source: "existing",
    });
    expect(decision.labels).not.toContain("enhancement");
  });

  it("leaves conflicting existing type labels unresolved", () => {
    const decision = makeDecision(analysis(), candidates, policy, [
      "bug",
      "enhancement",
    ]);

    expect(decision.classification).toEqual({
      label: null,
      source: "conflict",
    });
    expect(decision.labels).not.toContain("bug");
    expect(decision.labels).not.toContain("enhancement");
  });
});

describe("mergeManagedLabels", () => {
  it("replaces managed namespaces while leaving area labels unmanaged", () => {
    expect(
      mergeManagedLabels(
        ["enhancement", "priority:P3", "area:legacy", "customer-important"],
        ["priority:P2", "triage:done"],
        policy.managedLabelPrefixes,
      ),
    ).toEqual([
      "enhancement",
      "area:legacy",
      "customer-important",
      "priority:P2",
      "triage:done",
    ]);
  });
});
