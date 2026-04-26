import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentAsk, parseHumanDecision, SchemaError } from "../src/parsers.ts";

const minOpts = [
  { id: "A", label: "a", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.5 },
  { id: "B", label: "b", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.5 },
  { id: "C", label: "c", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.5 },
];

const validBody = {
  id: "ask_x",
  project_id: "p",
  project_name: "P",
  project_type: "software",
  verification_surface: "text",
  title: "Title",
  context: "context with enough detail to pass",
  options: minOpts,
  default_option_id: "A",
  confidence: 0.6,
  reversibility: "git_revert",
  expected_loss_if_wrong: 10,
  requested_human_seconds: 10,
  expires_in_seconds: 600,
  created_at: "2026-04-26T10:00:00.000Z",
};

describe("parseAgentAsk", () => {
  it("accepts a valid body", () => {
    const a = parseAgentAsk(validBody);
    assert.equal(a.id, "ask_x");
  });

  it("rejects missing id when fill_defaults=false", () => {
    const { id, ...rest } = validBody;
    assert.throws(() => parseAgentAsk(rest), SchemaError);
  });

  it("fills missing id when fill_defaults=true", () => {
    const { id, created_at, ...rest } = validBody;
    const a = parseAgentAsk(rest, { fill_defaults: true });
    assert.ok(a.id.length > 0);
    assert.ok(a.created_at);
  });

  it("rejects bad enums", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, project_type: "bogus" }), SchemaError);
    assert.throws(() => parseAgentAsk({ ...validBody, reversibility: "perm" }), SchemaError);
    assert.throws(() => parseAgentAsk({ ...validBody, default_option_id: "Z" }), SchemaError);
  });

  it("rejects confidence out of [0,1]", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, confidence: 1.5 }), SchemaError);
    assert.throws(() => parseAgentAsk({ ...validBody, confidence: -0.1 }), SchemaError);
  });

  it("rejects negative expected_loss_if_wrong", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, expected_loss_if_wrong: -1 }), SchemaError);
  });

  it("rejects duplicate option ids", () => {
    const opts = [minOpts[0]!, minOpts[0]!, minOpts[2]!];
    assert.throws(() => parseAgentAsk({ ...validBody, options: opts }), SchemaError);
  });

  it("rejects default not in options", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, default_option_id: "C", options: minOpts.slice(0, 2) }), SchemaError);
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, confidence: NaN }), SchemaError);
  });

  it("rejects bad id pattern", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, id: "../etc/passwd" }), SchemaError);
  });

  it("rejects bad created_at", () => {
    assert.throws(() => parseAgentAsk({ ...validBody, created_at: "not-a-date" }), SchemaError);
  });

  it("rejects body that isn't an object", () => {
    assert.throws(() => parseAgentAsk(["array"]), SchemaError);
    assert.throws(() => parseAgentAsk(null), SchemaError);
    assert.throws(() => parseAgentAsk("string"), SchemaError);
  });
});

describe("parseHumanDecision", () => {
  it("accepts A|B|C", () => {
    const d = parseHumanDecision({ ask_id: "x", choice: "A" });
    assert.equal(d.choice, "A");
  });

  it("requires override_text when choice=override", () => {
    assert.throws(
      () => parseHumanDecision({ ask_id: "x", choice: "override" }),
      SchemaError,
    );
  });

  it("rejects unknown choice", () => {
    assert.throws(() => parseHumanDecision({ ask_id: "x", choice: "Z" }), SchemaError);
  });

  it("defaults create_rule=false and timestamps", () => {
    const d = parseHumanDecision({ ask_id: "x", choice: "A" });
    assert.equal(d.create_rule, false);
    assert.ok(d.created_at);
  });
});
