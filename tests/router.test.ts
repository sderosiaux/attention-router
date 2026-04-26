import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBid, rankBids } from "../src/router.ts";
import type { AgentAsk, CouncilResult } from "../src/types.ts";

function makeAsk(overrides: Partial<AgentAsk> = {}): AgentAsk {
  return {
    id: "ask_r",
    project_id: "p1",
    project_name: "demo",
    project_type: "software",
    verification_surface: "business_rule",
    title: "t",
    context: "c",
    options: [
      {
        id: "A",
        label: "a",
        evidence: ["e"],
        predicted_next_step: "n",
        cost_if_wrong: "c",
        confidence: 0.8,
      },
      {
        id: "B",
        label: "b",
        evidence: ["e"],
        predicted_next_step: "n",
        cost_if_wrong: "c",
        confidence: 0.6,
      },
    ],
    default_option_id: "A",
    confidence: 0.7,
    reversibility: "git_revert",
    expected_loss_if_wrong: 50,
    requested_human_seconds: 30,
    expires_in_seconds: 600,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeBid", () => {
  it("scales with expected_loss_if_wrong", () => {
    const lo = computeBid({ ask: makeAsk({ expected_loss_if_wrong: 10 }) }).score;
    const hi = computeBid({ ask: makeAsk({ expected_loss_if_wrong: 200 }) }).score;
    assert.ok(hi > lo);
  });

  it("scales with irreversibility", () => {
    const triv = computeBid({ ask: makeAsk({ reversibility: "trivial" }) }).score;
    const irr = computeBid({ ask: makeAsk({ reversibility: "irreversible" }) }).score;
    assert.ok(irr > triv);
  });

  it("boosts when council disagrees with default", () => {
    const ask = makeAsk();
    const c1: CouncilResult = {
      ask_id: ask.id,
      votes: [],
      entropy: 0,
      predicted_human_choice: "A",
      escalate: false,
      disagreement_axis: "",
    };
    const c2: CouncilResult = { ...c1, predicted_human_choice: "B" };
    assert.ok(computeBid({ ask, council: c2 }).score > computeBid({ ask, council: c1 }).score);
  });

  it("subtracts requested_human_seconds and interruption penalty", () => {
    const lo = computeBid({ ask: makeAsk({ requested_human_seconds: 5 }) }).score;
    const hi = computeBid({ ask: makeAsk({ requested_human_seconds: 120 }) }).score;
    assert.ok(lo > hi);
  });

  it("uncertainty rises as confidence drops", () => {
    const high = computeBid({ ask: makeAsk({ confidence: 0.9 }) }).score;
    const low = computeBid({ ask: makeAsk({ confidence: 0.1 }) }).score;
    assert.ok(low > high);
  });

  it("show_now fires when above threshold", () => {
    const big = computeBid({
      ask: makeAsk({ expected_loss_if_wrong: 500, reversibility: "irreversible" }),
    });
    assert.equal(big.show_now, true);
  });

  it("show_now false on tiny low-impact ask", () => {
    const tiny = computeBid({
      ask: makeAsk({
        expected_loss_if_wrong: 1,
        reversibility: "trivial",
        confidence: 0.95,
        requested_human_seconds: 60,
      }),
    });
    assert.equal(tiny.show_now, false);
  });
});

describe("rankBids", () => {
  it("orders by score desc", () => {
    const bids = [
      { ask_id: "x", score: 5, reason: "", show_now: false },
      { ask_id: "y", score: 50, reason: "", show_now: true },
      { ask_id: "z", score: 20, reason: "", show_now: true },
    ];
    const r = rankBids(bids);
    assert.deepEqual(r.map((b) => b.ask_id), ["y", "z", "x"]);
  });
});
