import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAsk } from "../src/validation.ts";
import type { AgentAsk } from "../src/types.ts";

const baseValid: AgentAsk = {
  id: "ask_1",
  project_id: "p1",
  project_name: "demo",
  project_type: "software",
  verification_surface: "business_rule",
  title: "Pick caching strategy for user profile",
  context: "Profile reads dominate traffic. Stale OK for 60s. Affects /v2/profile endpoint.",
  options: [
    {
      id: "A",
      label: "In-memory LRU",
      evidence: ["matches access pattern", "low ops cost"],
      predicted_next_step: "wire LRU around getProfile",
      cost_if_wrong: "small mem leak risk",
      confidence: 0.7,
    },
    {
      id: "B",
      label: "Redis",
      evidence: ["already in stack"],
      predicted_next_step: "add redis client + key TTL",
      cost_if_wrong: "extra net hop, infra cost",
      confidence: 0.6,
    },
    {
      id: "C",
      label: "Do nothing",
      evidence: ["maybe not the bottleneck"],
      predicted_next_step: "profile first",
      cost_if_wrong: "lost time",
      confidence: 0.5,
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

describe("validateAsk", () => {
  it("accepts a fully formed ask", () => {
    const r = validateAsk(baseValid);
    assert.equal(r.valid, true);
  });

  it("rejects missing options", () => {
    const r = validateAsk({ ...baseValid, options: [] });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /no options/);
  });

  it("rejects fewer than 3 options", () => {
    const r = validateAsk({ ...baseValid, options: baseValid.options.slice(0, 2) });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /fewer than 3/);
  });

  it("rejects duplicate option ids", () => {
    const r = validateAsk({
      ...baseValid,
      options: [baseValid.options[0]!, baseValid.options[0]!, baseValid.options[2]!],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /duplicate/);
  });

  it("rejects missing default", () => {
    const { default_option_id, ...rest } = baseValid;
    const r = validateAsk(rest as Partial<AgentAsk>);
    assert.equal(r.valid, false);
    assert.match(r.reason!, /no default/);
  });

  it("rejects missing confidence", () => {
    const { confidence, ...rest } = baseValid;
    const r = validateAsk(rest as Partial<AgentAsk>);
    assert.equal(r.valid, false);
    assert.match(r.reason!, /confidence/);
  });

  it("rejects out-of-range confidence", () => {
    const r = validateAsk({ ...baseValid, confidence: 1.5 });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /\[0, 1\]/);
  });

  it("rejects missing expected_loss_if_wrong", () => {
    const { expected_loss_if_wrong, ...rest } = baseValid;
    const r = validateAsk(rest as Partial<AgentAsk>);
    assert.equal(r.valid, false);
    assert.match(r.reason!, /expected_loss_if_wrong/);
  });

  it("rejects negative expected_loss_if_wrong", () => {
    const r = validateAsk({ ...baseValid, expected_loss_if_wrong: -1 });
    assert.equal(r.valid, false);
    assert.match(r.reason!, />= 0/);
  });

  it("rejects vague titles", () => {
    const r = validateAsk({ ...baseValid, title: "what should I do?" });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /vague/);
  });

  it("rejects vague context", () => {
    const r = validateAsk({ ...baseValid, context: "thoughts?" });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /context/);
  });

  it("rejects too-short context", () => {
    const r = validateAsk({ ...baseValid, context: "short" });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /context/);
  });

  it("rejects option missing evidence", () => {
    const r = validateAsk({
      ...baseValid,
      options: [
        { ...baseValid.options[0]!, evidence: [] },
        baseValid.options[1]!,
        baseValid.options[2]!,
      ],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /evidence/);
  });

  it("rejects option missing predicted_next_step", () => {
    const r = validateAsk({
      ...baseValid,
      options: [
        { ...baseValid.options[0]!, predicted_next_step: "" },
        baseValid.options[1]!,
        baseValid.options[2]!,
      ],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /predicted_next_step/);
  });

  it("rejects option missing cost_if_wrong", () => {
    const r = validateAsk({
      ...baseValid,
      options: [
        { ...baseValid.options[0]!, cost_if_wrong: "" },
        baseValid.options[1]!,
        baseValid.options[2]!,
      ],
    });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /cost_if_wrong/);
  });

  it("provides repair instructions on rejection", () => {
    const r = validateAsk({ ...baseValid, options: [] });
    assert.ok(r.repair_instructions.length >= 5);
    assert.ok(r.repair_instructions.some((s) => /3 options/.test(s)));
  });
});
