import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage.ts";
import { Service, DecisionError } from "../src/service.ts";
import { MockProvider, type LlmProvider } from "../src/llm.ts";
import type { AgentAsk, HumanDecision, OptionId } from "../src/types.ts";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-svc-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function svc(provider?: LlmProvider): Promise<Service> {
  const s = new Store(dir);
  await s.load();
  return new Service(s, { llm_provider: provider });
}

function fixed(vote: OptionId): MockProvider {
  return new MockProvider({ vote, confidence: 0.9, reason: "test" });
}

const baseAsk: AgentAsk = {
  id: "ask_svc_1",
  project_id: "p1",
  project_name: "P",
  project_type: "software",
  verification_surface: "business_rule",
  title: "Pick a thing",
  context: "context with enough detail to pass validation",
  options: [
    { id: "A", label: "A label", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.6 },
    { id: "B", label: "B label", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.6 },
    { id: "C", label: "C label", evidence: ["e"], predicted_next_step: "n", cost_if_wrong: "c", confidence: 0.6 },
  ],
  default_option_id: "A",
  confidence: 0.65,
  reversibility: "git_revert",
  expected_loss_if_wrong: 250,
  requested_human_seconds: 30,
  expires_in_seconds: 600,
  created_at: new Date().toISOString(),
};

describe("Service.submitAsk", () => {
  it("rejects naked asks with persisted reason+repairs", async () => {
    const s = await svc();
    const out = await s.submitAsk({ ...baseAsk, options: [] });
    assert.equal(out.status, "rejected");
    const all = s.listPending();
    assert.equal(all.length, 0); // rejected != pending
    const stored = s.status();
    assert.equal(stored.rejected, 1);
  });

  it("queues escalated asks (high loss → council escalates)", async () => {
    const s = await svc(fixed("A"));
    const out = await s.submitAsk(baseAsk);
    assert.equal(out.status, "queued");
    assert.ok(out.bid?.show_now); // service forces show_now when escalated
  });

  it("auto_resolves a safe ask (council unanimous on default)", async () => {
    const s = await svc(fixed("A")); // force unanimity on A → entropy=0, predicted=default
    const safe: AgentAsk = {
      ...baseAsk,
      id: "ask_safe",
      reversibility: "trivial",
      expected_loss_if_wrong: 1,
      confidence: 0.95,
    };
    const out = await s.submitAsk(safe);
    assert.equal(out.status, "auto_resolved");
    assert.equal(out.safe_default_option_id, "A");
  });
});

describe("Service.decide", () => {
  it("404s on unknown ask", async () => {
    const s = await svc();
    await assert.rejects(
      () => s.decide({ ask_id: "missing", choice: "A", create_rule: false, created_at: new Date().toISOString() }),
      (e: unknown) => e instanceof DecisionError && (e as DecisionError).code === "not_found",
    );
  });

  it("409s if ask not pending", async () => {
    const s = await svc();
    await s.submitAsk(baseAsk);
    const dec: HumanDecision = { ask_id: baseAsk.id, choice: "A", create_rule: false, created_at: new Date().toISOString() };
    await s.decide(dec);
    await assert.rejects(
      () => s.decide(dec),
      (e: unknown) => e instanceof DecisionError && (e as DecisionError).code === "not_pending",
    );
  });

  it("rejects choice not in options", async () => {
    const s = await svc();
    await s.submitAsk(baseAsk);
    const ask2: AgentAsk = { ...baseAsk, id: "ask_x" };
    await s.submitAsk(ask2);
    await assert.rejects(
      () =>
        s.decide({
          ask_id: ask2.id,
          // invalid: cast to any to bypass TS
          choice: "Z" as never,
          create_rule: false,
          created_at: new Date().toISOString(),
        }),
      DecisionError,
    );
  });

  it("creates a draft rule when create_rule=true", async () => {
    const s = await svc();
    await s.submitAsk(baseAsk);
    const out = await s.decide({
      ask_id: baseAsk.id,
      choice: "A",
      create_rule: true,
      created_at: new Date().toISOString(),
    });
    assert.ok(out.rule_draft);
    assert.equal(out.rule_draft!.status, "draft");
    assert.equal(out.rule_draft!.project_id, "p1");
  });
});

describe("Service.nextBatch", () => {
  it("includes escalated asks even with low score", async () => {
    const s = await svc();
    await s.submitAsk(baseAsk); // escalated due to high loss
    const batch = await s.nextBatch(3);
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.urgency, "now");
  });

  it("clamps max to 3", async () => {
    const s = await svc();
    for (let i = 0; i < 5; i++) {
      await s.submitAsk({ ...baseAsk, id: `ask_${i}` });
    }
    const batch = await s.nextBatch(99);
    assert.ok(batch.length <= 3);
  });
});
