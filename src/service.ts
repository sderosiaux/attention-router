import type {
  AgentAsk,
  AskRecord,
  AttentionBid,
  CouncilResult,
  HumanDecision,
  JudgmentRule,
  RejectedAsk,
} from "./types.ts";
import { Store } from "./storage.ts";
import { toRejection, validateAsk } from "./validation.ts";
import { runCouncil } from "./council.ts";
import { defaultProvider, type LlmProvider } from "./llm.ts";
import { parseAgentAsk } from "./parsers.ts";

function parseDraftedAsk(raw: string): {
  title: string;
  options: AgentAsk["options"];
  default_option_id: AgentAsk["default_option_id"];
  confidence: number;
  reversibility: AgentAsk["reversibility"];
  expected_loss_if_wrong: number;
} {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("LLM returned no JSON for structured ask");
    obj = JSON.parse(m[0]);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("LLM structured ask is not an object");
  }
  // Cast through unknown — parseAgentAsk will validate every field strictly.
  return obj as ReturnType<typeof parseDraftedAsk>;
}
import { computeBid, DEFAULT_INTERRUPTION_PENALTY, DEFAULT_SHOW_THRESHOLD } from "./router.ts";
import { buildBatch, clampMax, expireStale } from "./batching.ts";
import { draftRule, extractTopic, ruleMatchesAsk } from "./rules.ts";
import process from "node:process";

function isCallbackHostAllowed(rawUrl: string): boolean {
  const allowed = (process.env.AR_CALLBACK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  try {
    const u = new URL(rawUrl);
    return allowed.includes(u.hostname);
  } catch {
    return false;
  }
}

export class DecisionError extends Error {
  constructor(message: string, readonly code: "not_found" | "not_pending" | "invalid_choice") {
    super(message);
    this.name = "DecisionError";
  }
}

export interface SubmitOutcome {
  status: "rejected" | "auto_resolved" | "queued";
  ask_id?: string;
  rejected?: RejectedAsk;
  council?: CouncilResult;
  bid?: AttentionBid;
  safe_default_option_id?: string;
}

export interface ServiceConfig {
  interruption_penalty?: number;
  show_threshold?: number;
  llm_provider?: LlmProvider;
}

export class Service {
  constructor(private store: Store, private cfg: ServiceConfig = {}) {}

  /**
   * "Smart ask": agent only knows it has a fork and some context. Use the LLM
   * to draft a fully-structured AgentAsk (3 options + evidence + default + cost),
   * then run the normal validation + council pipeline.
   *
   * The cost (one extra LLM call) is paid by the agent, not the human.
   */
  async structureAndSubmit(input: {
    project_id: string;
    project_name: string;
    project_type?: AgentAsk["project_type"];
    verification_surface?: AgentAsk["verification_surface"];
    dilemma: string;
    context: string;
    requested_human_seconds?: number;
    expires_in_seconds?: number;
    callback_url?: string;
  }): Promise<SubmitOutcome & { drafted_ask?: AgentAsk }> {
    const provider = this.cfg.llm_provider ?? defaultProvider();
    const system = `You convert a developer's dilemma into a structured decision card a human can answer in <30s.

Output STRICT JSON only, no prose, no markdown fences:
{
  "title": "<concrete decision, NOT a question — 'Pick X for Y' style, max 80 chars>",
  "options": [
    {"id":"A","label":"<short noun phrase>","evidence":["<fact>","<fact>"],"predicted_next_step":"<concrete action>","cost_if_wrong":"<what breaks>","confidence":<0..1>},
    {"id":"B", ...},
    {"id":"C", ...}
  ],
  "default_option_id":"A|B|C",
  "confidence":<0..1>,
  "reversibility":"trivial|git_revert|costly|irreversible",
  "expected_loss_if_wrong":<number, business impact in dollars/hours-of-work units; 0..10000>
}

Rules:
- Exactly 3 options labeled A, B, C — distinct, not minor variations
- Each option must have ≥1 evidence string grounded in the context (not generic platitudes)
- predicted_next_step must be a concrete next action, not a goal
- cost_if_wrong must describe the failure mode, not a vague "bad"
- default_option_id is YOUR best pick given the evidence
- Be opinionated. Lukewarm options waste human attention.`;

    const user = `Project: ${input.project_name} (${input.project_type ?? "software"})
Surface: ${input.verification_surface ?? "business_rule"}

Dilemma: ${input.dilemma}

Context:
${input.context}

Draft the JSON decision card now.`;

    const r = await provider.call({ system, systemCacheable: true, user, maxTokens: 1500 });
    const draftedFields = parseDraftedAsk(r.text);

    const fullAskInput = {
      project_id: input.project_id,
      project_name: input.project_name,
      project_type: input.project_type ?? ("software" as const),
      verification_surface: input.verification_surface ?? ("business_rule" as const),
      requested_human_seconds: input.requested_human_seconds ?? 30,
      expires_in_seconds: input.expires_in_seconds ?? 3600,
      callback_url: input.callback_url,
      context: input.context,
      ...draftedFields,
    };

    // Run through the same parser used by HTTP — guarantees the LLM didn't
    // produce something the validator would reject downstream.
    const ask = parseAgentAsk(fullAskInput, { fill_defaults: true });
    const outcome = await this.submitAsk(ask);
    return { ...outcome, drafted_ask: ask };
  }

  async submitAsk(ask: AgentAsk): Promise<SubmitOutcome> {
    const v = validateAsk(ask);
    if (!v.valid) {
      const rejected = toRejection(ask, v);
      await this.store.commit((s) => {
        s.asks[ask.id] = {
          ask,
          status: "rejected",
          rejection_reason: rejected.reason,
          repair_instructions: rejected.repair_instructions,
        };
      });
      return { status: "rejected", rejected };
    }

    // Topic-filter accepted rules (audit_rule_self_loop A): prevent cross-domain bleed.
    const askTopic = extractTopic(ask);
    const rules = this.store
      .rulesForProject(ask.project_id, "accepted")
      .filter((r) => ruleMatchesAsk(r, askTopic));
    const council = await runCouncil({ ask, rules, provider: this.cfg.llm_provider });
    const starvation = this.store.starvationSeconds(ask.project_id);
    const bid = computeBid({
      ask,
      council,
      starvation_seconds: starvation,
      interruption_penalty: this.cfg.interruption_penalty ?? DEFAULT_INTERRUPTION_PENALTY,
      show_threshold: this.cfg.show_threshold ?? DEFAULT_SHOW_THRESHOLD,
    });

    // Spec: escalated asks must reach the batch even if score is below threshold.
    if (council.escalate) bid.show_now = true;

    if (council.escalate || bid.show_now) {
      const rec: AskRecord = { ask, council, bid, status: "pending" };
      await this.store.commit((s) => {
        s.asks[ask.id] = rec;
      });
      return { status: "queued", ask_id: ask.id, council, bid };
    }

    const rec: AskRecord = {
      ask,
      council,
      bid,
      status: "auto_resolved",
      safe_default_option_id: ask.default_option_id,
    };
    await this.store.commit((s) => {
      s.asks[ask.id] = rec;
    });
    if (rec.ask.callback_url) void this.deliverCallback(rec);
    return {
      status: "auto_resolved",
      ask_id: ask.id,
      council,
      bid,
      safe_default_option_id: ask.default_option_id,
    };
  }

  async nextBatch(max = 3): Promise<AskRecord[]> {
    const clamped = clampMax(max);
    await this.store.commit((s) => {
      expireStale(Object.values(s.asks));
    });
    return buildBatch(this.store.allAsks(), { max: clamped });
  }

  async decide(input: HumanDecision): Promise<{ rule_draft?: JudgmentRule; record: AskRecord }> {
    let recOut: AskRecord | undefined;
    let ruleOut: JudgmentRule | undefined;
    await this.store.commit((s) => {
      const rec = s.asks[input.ask_id];
      if (!rec) throw new DecisionError(`ask not found: ${input.ask_id}`, "not_found");
      if (rec.status !== "pending" && rec.status !== "stale") {
        throw new DecisionError(`ask not pending (status=${rec.status})`, "not_pending");
      }
      if (input.choice !== "override" && !rec.ask.options.some((o) => o.id === input.choice)) {
        throw new DecisionError(`choice ${input.choice} not in options`, "invalid_choice");
      }
      rec.decision = input;
      rec.status = "decided";
      s.attention[rec.ask.project_id] = new Date().toISOString();

      if (input.create_rule) {
        ruleOut = draftRule({ ask: rec.ask, decision: input });
        s.rules[ruleOut.id] = ruleOut;
      }
      recOut = rec;
    });
    if (recOut?.ask.callback_url) {
      // Fire-and-forget delivery; do not block the decide() response.
      void this.deliverCallback(recOut, { rule_draft: ruleOut });
    }
    return { rule_draft: ruleOut, record: recOut! };
  }

  private async deliverCallback(
    rec: AskRecord,
    extra: { rule_draft?: JudgmentRule } = {},
  ): Promise<void> {
    const url = rec.ask.callback_url;
    if (!url) return;

    // SSRF guard (audit_callback_security decision A): empty allowlist = no callbacks.
    // Operators must explicitly whitelist hosts via AR_CALLBACK_ALLOWED_HOSTS.
    if (!isCallbackHostAllowed(url)) {
      await this.store.commit((s) => {
        const r = s.asks[rec.ask.id];
        if (!r) return;
        r.callback_status = "failed";
        r.callback_attempts = 0;
      });
      console.warn(
        `[callback] blocked: host not in AR_CALLBACK_ALLOWED_HOSTS (${url})`,
      );
      return;
    }

    const payload = {
      ask_id: rec.ask.id,
      status: rec.status,
      decision: rec.decision,
      safe_default_option_id: rec.safe_default_option_id,
      rule_draft: extra.rule_draft,
    };
    let attempts = 0;
    let ok = false;
    while (attempts < 3 && !ok) {
      attempts++;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
        ok = r.ok;
      } catch {
        ok = false;
      }
      if (!ok) await new Promise((res) => setTimeout(res, 250 * 2 ** (attempts - 1)));
    }
    await this.store.commit((s) => {
      const r = s.asks[rec.ask.id];
      if (!r) return;
      r.callback_status = ok ? "delivered" : "failed";
      r.callback_attempts = attempts;
    });
  }

  async skip(askId: string): Promise<AskRecord | undefined> {
    let out: AskRecord | undefined;
    await this.store.commit((s) => {
      const rec = s.asks[askId];
      if (!rec) return;
      rec.status = "skipped";
      rec.skipped_at = new Date().toISOString();
      out = rec;
    });
    return out;
  }

  /** Mark a rule as stale (no longer applied by future councils). */
  async markRuleStale(id: string): Promise<JudgmentRule | undefined> {
    let out: JudgmentRule | undefined;
    await this.store.commit((s) => {
      const r = s.rules[id];
      if (!r) return;
      r.status = "stale";
      out = r;
    });
    return out;
  }

  async setRuleStatus(id: string, status: "accepted" | "rejected"): Promise<JudgmentRule | undefined> {
    let out: JudgmentRule | undefined;
    await this.store.commit((s) => {
      const r = s.rules[id];
      if (!r) return;
      r.status = status;
      out = r;
    });
    return out;
  }

  async editRule(
    id: string,
    field: "prefer" | "avoid" | "priority" | "when",
    value: string | number,
  ): Promise<JudgmentRule | undefined> {
    let out: JudgmentRule | undefined;
    await this.store.commit((s) => {
      const r = s.rules[id];
      if (!r) return;
      if (field === "priority") {
        const n = Number(value);
        if (!Number.isFinite(n)) throw new DecisionError("priority must be a number", "invalid_choice");
        r.priority = n;
      } else {
        r[field] = String(value);
      }
      out = r;
    });
    return out;
  }

  listRules(): JudgmentRule[] {
    return this.store.allRules();
  }

  listProjects() {
    return this.store.projects();
  }

  listPending(): AskRecord[] {
    return this.store.allAsks().filter((r) => r.status === "pending" || r.status === "stale");
  }

  status() {
    const all = this.store.allAsks();
    const count = (s: AskRecord["status"]) => all.filter((r) => r.status === s).length;
    return {
      total: all.length,
      pending: count("pending"),
      stale: count("stale"),
      auto_resolved: count("auto_resolved"),
      decided: count("decided"),
      rejected: count("rejected"),
      expired: count("expired"),
      skipped: count("skipped"),
      rules: this.store.allRules().length,
    };
  }
}
