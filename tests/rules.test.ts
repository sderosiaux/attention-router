import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { draftRule } from "../src/rules.ts";
import type { AgentAsk, HumanDecision } from "../src/types.ts";

const ask: AgentAsk = {
  id: "ask_rule_1",
  project_id: "p1",
  project_name: "demo",
  project_type: "software",
  verification_surface: "business_rule",
  title: "Pick caching layer",
  context: "",
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
  ],
  default_option_id: "A",
  confidence: 0.65,
  reversibility: "git_revert",
  expected_loss_if_wrong: 50,
  requested_human_seconds: 30,
  expires_in_seconds: 600,
  created_at: new Date().toISOString(),
};

describe("draftRule", () => {
  it("creates a draft rule with prefer/avoid keywords", () => {
    const decision: HumanDecision = {
      ask_id: ask.id,
      choice: "A",
      create_rule: true,
      created_at: new Date().toISOString(),
    };
    const r = draftRule({ ask, decision });
    assert.equal(r.status, "draft");
    assert.equal(r.scope, "project");
    assert.equal(r.project_id, "p1");
    assert.equal(r.source_ask_id, ask.id);
    assert.match(r.prefer, /redis/);
    assert.ok(r.examples.length >= 1);
    assert.ok(r.counterexamples.length >= 1);
  });

  it("supports override choice", () => {
    const decision: HumanDecision = {
      ask_id: ask.id,
      choice: "override",
      override_text: "use cloudflare workers cache",
      create_rule: true,
      created_at: new Date().toISOString(),
    };
    const r = draftRule({ ask, decision });
    assert.equal(r.prefer, "use cloudflare workers cache");
  });

  it("scope=all sets project_id undefined", () => {
    const decision: HumanDecision = {
      ask_id: ask.id,
      choice: "B",
      create_rule: true,
      created_at: new Date().toISOString(),
    };
    const r = draftRule({ ask, decision, scope: "all" });
    assert.equal(r.scope, "all");
    assert.equal(r.project_id, undefined);
  });
});
