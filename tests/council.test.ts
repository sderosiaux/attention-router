import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  entropy,
  runCouncil,
  shouldEscalate,
  DEFAULT_PERSONAS,
} from "../src/council.ts";
import { MockProvider, type LlmProvider, type LlmCallOptions, type LlmCallResult } from "../src/llm.ts";
import type { AgentAsk, OptionId } from "../src/types.ts";

const ask: AgentAsk = {
  id: "ask_council_1",
  project_id: "p1",
  project_name: "demo",
  project_type: "software",
  verification_surface: "business_rule",
  title: "Pick session storage",
  context: "Session reads/writes scale with active users",
  options: [
    {
      id: "A",
      label: "In-memory map",
      evidence: ["fast", "simple", "minimal infra"],
      predicted_next_step: "ship behind feature flag",
      cost_if_wrong: "lose sessions on restart",
      confidence: 0.7,
    },
    {
      id: "B",
      label: "Redis",
      evidence: ["consistent across pods", "guard for invariant"],
      predicted_next_step: "add redis client",
      cost_if_wrong: "extra infra",
      confidence: 0.6,
    },
    {
      id: "C",
      label: "Big rewrite to event-sourced",
      evidence: ["future proof"],
      predicted_next_step: "refactor session module entirely",
      cost_if_wrong: "weeks of churn",
      confidence: 0.3,
    },
  ],
  default_option_id: "A",
  confidence: 0.6,
  reversibility: "git_revert",
  expected_loss_if_wrong: 60,
  requested_human_seconds: 30,
  expires_in_seconds: 600,
  created_at: new Date().toISOString(),
};

class FixedVoteProvider implements LlmProvider {
  constructor(private votes: { vote: OptionId; confidence: number; reason: string }[]) {}
  private call_idx = 0;
  async call(_opts: LlmCallOptions): Promise<LlmCallResult> {
    const v = this.votes[this.call_idx % this.votes.length]!;
    this.call_idx++;
    return { text: JSON.stringify(v) };
  }
}

class FailingProvider implements LlmProvider {
  async call(_opts: LlmCallOptions): Promise<LlmCallResult> {
    throw new Error("simulated LLM outage");
  }
}

describe("entropy", () => {
  it("is 0 when unanimous", () => {
    assert.equal(entropy(["A", "A", "A"]), 0);
  });
  it("is log2(N) when uniform across N options", () => {
    const h = entropy(["A", "B", "C"]);
    assert.ok(Math.abs(h - Math.log2(3)) < 1e-9);
  });
  it("is between 0 and log2(N)", () => {
    const h = entropy(["A", "A", "B"]);
    assert.ok(h > 0 && h < Math.log2(3));
  });
});

describe("runCouncil (with LLM provider)", () => {
  it("produces one vote per persona", async () => {
    const r = await runCouncil({ ask, provider: new MockProvider() });
    assert.equal(r.votes.length, DEFAULT_PERSONAS.length);
  });

  it("only votes A|B|C", async () => {
    const r = await runCouncil({ ask, provider: new MockProvider() });
    for (const v of r.votes) assert.ok(["A", "B", "C"].includes(v.vote));
  });

  it("includes entropy and predicted_human_choice", async () => {
    const r = await runCouncil({ ask, provider: new MockProvider() });
    assert.equal(typeof r.entropy, "number");
    assert.ok(["A", "B", "C"].includes(r.predicted_human_choice));
  });

  it("converges on unanimous vote when provider returns same vote", async () => {
    const provider = new MockProvider({ vote: "B", confidence: 0.9, reason: "test" });
    const r = await runCouncil({ ask, provider });
    assert.equal(r.entropy, 0);
    assert.equal(r.predicted_human_choice, "B");
    for (const v of r.votes) assert.equal(v.vote, "B");
  });

  it("falls back to agent default when LLM fails (low confidence)", async () => {
    const r = await runCouncil({ ask, provider: new FailingProvider() });
    for (const v of r.votes) {
      assert.equal(v.vote, ask.default_option_id);
      assert.ok(v.confidence <= 0.5);
      assert.match(v.reason, /council error/);
    }
  });

  it("respects fixed vote pattern", async () => {
    const provider = new FixedVoteProvider([
      { vote: "A", confidence: 0.7, reason: "1" },
      { vote: "A", confidence: 0.7, reason: "2" },
      { vote: "B", confidence: 0.7, reason: "3" },
      { vote: "C", confidence: 0.7, reason: "4" },
      { vote: "C", confidence: 0.7, reason: "5" },
    ]);
    const r = await runCouncil({ ask, provider });
    assert.deepEqual(
      r.votes.map((v) => v.vote),
      ["A", "A", "B", "C", "C"],
    );
  });
});

describe("shouldEscalate", () => {
  it("escalates on high entropy", () => {
    assert.equal(shouldEscalate({ ask, entropy: 1.5, predicted: "A" }), true);
  });
  it("escalates on irreversible", () => {
    assert.equal(
      shouldEscalate({ ask: { ...ask, reversibility: "irreversible" }, entropy: 0, predicted: "A" }),
      true,
    );
  });
  it("escalates on high loss", () => {
    assert.equal(
      shouldEscalate({ ask: { ...ask, expected_loss_if_wrong: 500 }, entropy: 0, predicted: "A" }),
      true,
    );
  });
  it("escalates on low confidence", () => {
    assert.equal(
      shouldEscalate({ ask: { ...ask, confidence: 0.2 }, entropy: 0, predicted: "A" }),
      true,
    );
  });
  it("escalates when predicted disagrees with default", () => {
    assert.equal(shouldEscalate({ ask, entropy: 0, predicted: "B" }), true);
  });
  it("does not escalate when safe", () => {
    const safe: AgentAsk = {
      ...ask,
      reversibility: "trivial",
      expected_loss_if_wrong: 1,
      confidence: 0.9,
    };
    assert.equal(shouldEscalate({ ask: safe, entropy: 0, predicted: "A" }), false);
  });
});
