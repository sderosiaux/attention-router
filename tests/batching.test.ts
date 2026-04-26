import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBatch, clampMax, expireStale, isExpired, isLowRisk } from "../src/batching.ts";
import type { AgentAsk, AskRecord, CouncilResult, Reversibility } from "../src/types.ts";

interface RecOpts {
  age_seconds?: number;
  ttl?: number;
  status?: AskRecord["status"];
  show_now?: boolean;
  escalate?: boolean;
  reversibility?: Reversibility;
  expected_loss_if_wrong?: number;
}

function rec(id: string, score: number, opts: RecOpts = {}): AskRecord {
  const ageSec = opts.age_seconds ?? 0;
  const ttl = opts.ttl ?? 600;
  const created = new Date(Date.now() - ageSec * 1000).toISOString();
  const ask: AgentAsk = {
    id,
    project_id: "p",
    project_name: "p",
    project_type: "software",
    verification_surface: "text",
    title: id,
    context: "ctx ctx ctx ctx",
    options: [
      { id: "A", label: "a", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.7 },
      { id: "B", label: "b", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.7 },
      { id: "C", label: "c", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.7 },
    ],
    default_option_id: "A",
    confidence: 0.7,
    reversibility: opts.reversibility ?? "git_revert",
    expected_loss_if_wrong: opts.expected_loss_if_wrong ?? 10,
    requested_human_seconds: 10,
    expires_in_seconds: ttl,
    created_at: created,
  };
  const council: CouncilResult | undefined = opts.escalate
    ? {
        ask_id: id,
        votes: [],
        entropy: 0,
        predicted_human_choice: "A",
        escalate: true,
        disagreement_axis: "test",
      }
    : undefined;
  return {
    ask,
    council,
    bid: { ask_id: id, score, reason: "", show_now: opts.show_now ?? true },
    status: opts.status ?? "pending",
  };
}

describe("buildBatch", () => {
  it("clamps max to [1, 3]", () => {
    assert.equal(clampMax(0), 1);
    assert.equal(clampMax(99), 3);
    assert.equal(clampMax(2), 2);
  });

  it("returns at most 3 even when max>3 and many records", () => {
    const rs = [rec("a", 5), rec("b", 50), rec("c", 20), rec("d", 100), rec("e", 200)];
    const batch = buildBatch(rs, { max: 99 });
    assert.equal(batch.length, 3);
    // every chosen record must be one of the inputs
    for (const r of batch) assert.ok(["a", "b", "c", "d", "e"].includes(r.ask.id));
  });

  it("higher score wins when escalation/expiry/created_at all equal", () => {
    const t = new Date("2026-01-01T00:00:00Z").toISOString();
    const r = (id: string, score: number): AskRecord => ({
      ...rec(id, score),
      ask: { ...rec(id, score).ask, created_at: t },
    });
    const batch = buildBatch([r("lo", 5), r("hi", 500)], { max: 1, now: new Date("2026-01-01T00:01:00Z") });
    assert.equal(batch[0]!.ask.id, "hi");
  });

  it("filters out non-pending", () => {
    const rs = [rec("a", 100, { status: "decided" }), rec("b", 50)];
    const batch = buildBatch(rs);
    assert.deepEqual(batch.map((r) => r.ask.id), ["b"]);
  });

  it("filters out !show_now when not escalated", () => {
    const rs = [rec("a", 100, { show_now: false }), rec("b", 50)];
    const batch = buildBatch(rs);
    assert.deepEqual(batch.map((r) => r.ask.id), ["b"]);
  });

  it("includes escalated even when !show_now", () => {
    const rs = [rec("a", 1, { show_now: false, escalate: true }), rec("b", 50)];
    const batch = buildBatch(rs);
    const ids = batch.map((r) => r.ask.id);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
  });

  it("orders escalated (urgency=now) before plain (today)", () => {
    const rs = [rec("plain", 100), rec("esc", 1, { escalate: true })];
    const batch = buildBatch(rs);
    assert.equal(batch[0]!.ask.id, "esc");
  });

  it("hard-expired records drop out", () => {
    const rs = [rec("a", 100, { age_seconds: 700, ttl: 600 }), rec("b", 50)];
    expireStale(rs); // marks low-risk past-TTL as expired
    const batch = buildBatch(rs);
    assert.deepEqual(batch.map((r) => r.ask.id), ["b"]);
  });

  it("stale (high-risk past TTL) records remain visible", () => {
    const rs = [
      rec("hi", 1, {
        age_seconds: 700,
        ttl: 600,
        reversibility: "irreversible",
        expected_loss_if_wrong: 500,
        escalate: true,
      }),
    ];
    expireStale(rs);
    assert.equal(rs[0]!.status, "stale");
    const batch = buildBatch(rs);
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.urgency, "now");
  });

  it("urgency=now for <5m to expiry", () => {
    const rs = [rec("a", 1, { age_seconds: 590, ttl: 600 })]; // 10s remaining
    const batch = buildBatch(rs);
    assert.equal(batch[0]!.urgency, "now");
  });

  it("urgency=soon for 5-30m remaining", () => {
    const rs = [rec("a", 1, { age_seconds: 0, ttl: 60 * 15 })]; // 15m
    const batch = buildBatch(rs);
    assert.equal(batch[0]!.urgency, "soon");
  });
});

describe("expireStale", () => {
  it("expires low-risk past TTL", () => {
    const rs = [rec("low", 1, { age_seconds: 700, ttl: 600 })];
    expireStale(rs);
    assert.equal(rs[0]!.status, "expired");
  });

  it("marks high-risk past TTL as stale (not expired)", () => {
    const rs = [
      rec("hi", 1, {
        age_seconds: 700,
        ttl: 600,
        reversibility: "irreversible",
      }),
    ];
    expireStale(rs);
    assert.equal(rs[0]!.status, "stale");
  });

  it("escalated past TTL is stale", () => {
    const rs = [rec("e", 1, { age_seconds: 700, ttl: 600, escalate: true })];
    expireStale(rs);
    assert.equal(rs[0]!.status, "stale");
  });
});

describe("isExpired", () => {
  it("expires at TTL boundary (>=)", () => {
    const r = rec("a", 1, { age_seconds: 100, ttl: 100 });
    assert.equal(isExpired(r), true);
  });
  it("not expired before TTL", () => {
    assert.equal(isExpired(rec("b", 1, { age_seconds: 50, ttl: 100 })), false);
  });
});

describe("isLowRisk", () => {
  it("escalated is high-risk", () => {
    assert.equal(isLowRisk(rec("a", 1, { escalate: true })), false);
  });
  it("irreversible is high-risk", () => {
    assert.equal(isLowRisk(rec("a", 1, { reversibility: "irreversible" })), false);
  });
  it("loss>=100 is high-risk", () => {
    assert.equal(isLowRisk(rec("a", 1, { expected_loss_if_wrong: 100 })), false);
  });
  it("default (low-loss, git_revert, no escalate) is low-risk", () => {
    assert.equal(isLowRisk(rec("a", 1)), true);
  });
});
