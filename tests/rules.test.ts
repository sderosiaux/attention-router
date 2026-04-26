import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { draftRule, extractTopic, ruleMatchesAsk } from "../src/rules.ts";
import type { LlmCallOptions, LlmCallResult, LlmProvider } from "../src/llm.ts";
import type { AgentAsk, HumanDecision } from "../src/types.ts";

const ask: AgentAsk = {
  id: "ask_rule_1",
  project_id: "p1",
  project_name: "demo",
  project_type: "software",
  verification_surface: "business_rule",
  title: "Pick caching layer",
  context: "redis lookup latency vs in-memory map for hot session reads",
  options: [
    {
      id: "A",
      label: "Redis cache for profile",
      evidence: ["redis already in stack", "redis low latency"],
      predicted_next_step: "wire redis",
      cost_if_wrong: "infra cost",
      confidence: 0.7,
    },
    {
      id: "B",
      label: "In-memory LRU",
      evidence: ["simple"],
      predicted_next_step: "lru",
      cost_if_wrong: "lost cache on restart",
      confidence: 0.6,
    },
    {
      id: "C",
      label: "Skip caching",
      evidence: ["maybe overkill"],
      predicted_next_step: "no-op",
      cost_if_wrong: "slow profile reads",
      confidence: 0.4,
    },
  ],
  default_option_id: "A",
  confidence: 0.65,
  reversibility: "git_revert",
  expected_loss_if_wrong: 50,
  requested_human_seconds: 30,
  expires_in_seconds: 600,
  created_at: new Date().toISOString(),
};

class FixedExtractorProvider implements LlmProvider {
  constructor(private prefer: string, private avoid: string) {}
  async call<T>(opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
    const value = { prefer: this.prefer, avoid: this.avoid } as unknown as T;
    return { text: JSON.stringify(value), parsed: opts.schema ? value : undefined };
  }
}

class FailingProvider implements LlmProvider {
  async call<T>(_opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
    throw new Error("simulated extractor outage");
  }
}

describe("draftRule", () => {
  it("uses LLM to extract prefer/avoid", async () => {
    const provider = new FixedExtractorProvider("redis cache", "in-memory storage");
    const decision: HumanDecision = {
      ask_id: ask.id, choice: "A", create_rule: true, created_at: new Date().toISOString(),
    };
    const r = await draftRule({ ask, decision, provider });
    assert.equal(r.status, "draft");
    assert.equal(r.scope, "project");
    assert.equal(r.project_id, "p1");
    assert.equal(r.source_ask_id, ask.id);
    assert.equal(r.prefer, "redis cache");
    assert.equal(r.avoid, "in-memory storage");
    assert.ok(r.examples.length >= 1);
    assert.ok(r.counterexamples.length >= 1);
    assert.ok(r.topic && r.topic.length > 0, "topic should be extracted");
  });

  it("override path bypasses the LLM and uses the human's text", async () => {
    let called = false;
    const provider: LlmProvider = {
      async call<T>(_opts: LlmCallOptions<T>): Promise<LlmCallResult<T>> {
        called = true;
        return { text: "{}" };
      },
    };
    const decision: HumanDecision = {
      ask_id: ask.id,
      choice: "override",
      override_text: "use cloudflare workers cache",
      create_rule: true,
      created_at: new Date().toISOString(),
    };
    const r = await draftRule({ ask, decision, provider });
    assert.equal(called, false, "LLM should not be called on override");
    assert.equal(r.prefer, "use cloudflare workers cache");
  });

  it("falls back to chosen.label when LLM throws", async () => {
    const decision: HumanDecision = {
      ask_id: ask.id, choice: "A", create_rule: true, created_at: new Date().toISOString(),
    };
    const r = await draftRule({ ask, decision, provider: new FailingProvider() });
    assert.equal(r.prefer, "Redis cache for profile"); // chosen label verbatim
  });

  it("no provider → cheap label fallback (used by unit tests of pure logic)", async () => {
    const decision: HumanDecision = {
      ask_id: ask.id, choice: "B", create_rule: true, created_at: new Date().toISOString(),
    };
    const r = await draftRule({ ask, decision }); // no provider
    assert.equal(r.prefer, "In-memory LRU");
  });

  it("scope=all sets project_id undefined", async () => {
    const decision: HumanDecision = {
      ask_id: ask.id, choice: "B", create_rule: true, created_at: new Date().toISOString(),
    };
    const r = await draftRule({ ask, decision, scope: "all" });
    assert.equal(r.scope, "all");
    assert.equal(r.project_id, undefined);
  });
});

describe("extractTopic / ruleMatchesAsk", () => {
  it("extracts up to 6 topic keywords from title+context", () => {
    const t = extractTopic({
      title: "Pick caching layer for hot session reads",
      context: "redis lookup latency vs memory map; users read profiles often",
    });
    assert.ok(t.length > 0 && t.length <= 6);
    assert.ok(t.includes("redis") || t.includes("caching"));
  });

  it("matches when rule.topic intersects ask topic", () => {
    const askTopic = ["redis", "caching", "session"];
    assert.equal(ruleMatchesAsk({ topic: ["redis", "store"] }, askTopic), true);
    assert.equal(ruleMatchesAsk({ topic: ["bearer", "auth"] }, askTopic), false);
  });

  it("legacy rules (no topic) always match (backward compat)", () => {
    assert.equal(ruleMatchesAsk({}, ["anything"]), true);
  });
});
