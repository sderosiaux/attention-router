import process from "node:process";
import type {
  AgentAsk,
  CouncilResult,
  CouncilVote,
  JudgmentRule,
  OptionId,
} from "./types.ts";
import { defaultProvider, type LlmProvider } from "./llm.ts";

export interface PersonaSpec {
  name: string;
  /** Short instruction added to the shared system prompt to define this persona's lens. */
  lens: string;
}

export const DEFAULT_PERSONAS: PersonaSpec[] = [
  {
    name: "strict product thinker",
    lens:
      "You weigh user value, clarity, and product coherence. You ask: which option best serves the customer and protects the product's promise?",
  },
  {
    name: "skeptical engineer",
    lens:
      "You weigh implementation risk, reversibility, and cost. You distrust large refactors and prefer the smallest change that solves the problem. Confidence matters; bias toward proven approaches.",
  },
  {
    name: "impatient user",
    lens:
      "You want shipping speed and tangible outcomes now. You penalize options whose predicted_next_step is long, vague, or requires deep work. You favor the fastest credible path to value.",
  },
  {
    name: "business-rule guardian",
    lens:
      "You weigh invariants, safety, compliance, and consistency. You penalize options that bypass guards or skip checks, and you favor options that preserve correctness even at a small cost in speed.",
  },
  {
    name: "learned-human-preference proxy",
    lens:
      "You approximate the human operator's accumulated taste based on past decisions. Weigh accepted JudgmentRules heavily; if a rule prefers/avoids a keyword that matches an option, factor that in.",
  },
];

const SHARED_SYSTEM_PREFIX = `You are one of five "Doppelgänger Council" reviewers helping a human triage decisions raised by autonomous coding agents.

Your job: read an AgentAsk (title, context, options A/B/C with evidence and predicted next steps), apply your persona's lens, and vote.

Output format — STRICT JSON, nothing else, no prose, no markdown fences:
{"vote": "A" | "B" | "C", "confidence": <number 0..1>, "reason": "<one sentence, max 25 words>"}

Rules:
- vote must be exactly one of A, B, C
- confidence reflects your certainty in this vote (0=coin flip, 1=overwhelming)
- reason must justify the vote in YOUR persona's terms — quote a specific evidence/option detail
- Do not invent options; only A, B, C exist
- If two options are close, pick the one your persona favors and reflect lower confidence`;

export interface CouncilInput {
  ask: AgentAsk;
  rules?: JudgmentRule[];
  personas?: PersonaSpec[];
  provider?: LlmProvider;
  /** Optional override for council-side timeout/retry. */
  timeoutMs?: number;
}

export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
  const { ask } = input;
  const personas = input.personas ?? DEFAULT_PERSONAS;
  const provider = input.provider ?? defaultProvider();
  const rules = (input.rules ?? []).filter((r) => r.status === "accepted");

  const askPayload = renderAskPayload(ask, rules);

  // Each persona is its own request; the SHARED_SYSTEM_PREFIX is cacheable so the
  // common framework + ask payload only pay full price once across the 5 calls.
  const votes = await Promise.all(
    personas.map((p) => votePersona(provider, p, askPayload, ask)),
  );

  const ent = entropy(votes.map((v) => v.vote));
  const tally = tallyByConfidence(votes);
  const predicted = pickWinner(tally);
  const disagreementAxis = describeDisagreement(votes, ask);

  return {
    ask_id: ask.id,
    votes,
    entropy: round3(ent),
    predicted_human_choice: predicted,
    escalate: shouldEscalate({ ask, entropy: ent, predicted }),
    disagreement_axis: disagreementAxis,
  };
}

async function votePersona(
  provider: LlmProvider,
  persona: PersonaSpec,
  askPayload: string,
  ask: AgentAsk,
): Promise<CouncilVote> {
  const userPrompt = `Persona: ${persona.name}
Lens: ${persona.lens}

${askPayload}

Vote now. Reply with the JSON object only.`;

  try {
    const r = await provider.call({
      system: SHARED_SYSTEM_PREFIX,
      systemCacheable: true,
      user: userPrompt,
      maxTokens: 256,
    });
    const parsed = parseVote(r.text);
    return {
      persona: persona.name,
      vote: parsed.vote,
      confidence: round2(clamp01(parsed.confidence)),
      reason: parsed.reason.slice(0, 200),
    };
  } catch (e) {
    // Fallback: agent default with low confidence and the failure reason.
    return {
      persona: persona.name,
      vote: ask.default_option_id,
      confidence: 0.3,
      reason: `council error: ${(e as Error).message.slice(0, 80)}`,
    };
  }
}

function renderAskPayload(ask: AgentAsk, rules: JudgmentRule[]): string {
  const opts = ask.options
    .map((o) =>
      [
        `Option ${o.id}: ${o.label}`,
        `  Evidence: ${o.evidence.join(" | ")}`,
        `  Predicted next step: ${o.predicted_next_step}`,
        `  Cost if wrong: ${o.cost_if_wrong}`,
        `  Agent confidence in this option: ${o.confidence}`,
      ].join("\n"),
    )
    .join("\n\n");

  const ruleLines = rules.length
    ? rules
        .map((r) => `- prefer "${r.prefer}", avoid "${r.avoid}" (when ${r.when}; priority ${r.priority})`)
        .join("\n")
    : "(no accepted rules for this project)";

  return `--- Ask ---
Title: ${ask.title}
Project: ${ask.project_name} (type=${ask.project_type}, surface=${ask.verification_surface})
Reversibility: ${ask.reversibility}
Expected loss if wrong: ${ask.expected_loss_if_wrong}
Agent overall confidence: ${ask.confidence}
Agent default option: ${ask.default_option_id}

Context:
${ask.context}

Options:
${opts}

Accepted JudgmentRules to weigh:
${ruleLines}
--- end ---`;
}

function parseVote(raw: string): { vote: OptionId; confidence: number; reason: string } {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  // Try direct parse first; fall back to extracting first {...} block.
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in council response");
    obj = JSON.parse(m[0]);
  }
  if (!isObj(obj)) throw new Error("council response is not an object");
  const vote = obj.vote;
  if (vote !== "A" && vote !== "B" && vote !== "C") {
    throw new Error(`bad vote value: ${String(vote)}`);
  }
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? obj.confidence
      : 0.5;
  const reason = typeof obj.reason === "string" ? obj.reason : "(no reason)";
  return { vote, confidence, reason };
}

export function entropy(votes: OptionId[]): number {
  if (votes.length === 0) return 0;
  const counts = new Map<OptionId, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  const total = votes.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface EscalateInput {
  ask: AgentAsk;
  entropy: number;
  predicted: OptionId;
  thresholds?: Partial<EscalateThresholds>;
}

export interface EscalateThresholds {
  highEntropy: number;
  highLoss: number;
  lowConfidence: number;
}

export const DEFAULT_THRESHOLDS: EscalateThresholds = {
  highEntropy: envNum("AR_ESCALATE_HIGH_ENTROPY", 1.0),
  highLoss: envNum("AR_ESCALATE_HIGH_LOSS", 100),
  lowConfidence: envNum("AR_ESCALATE_LOW_CONFIDENCE", 0.5),
};

export function shouldEscalate(input: EscalateInput): boolean {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const { ask, entropy: ent, predicted } = input;
  if (ent >= t.highEntropy) return true;
  if (ask.expected_loss_if_wrong >= t.highLoss) return true;
  if (ask.reversibility === "costly" || ask.reversibility === "irreversible") return true;
  if (ask.confidence <= t.lowConfidence) return true;
  if (predicted !== ask.default_option_id) return true;
  return false;
}

function tallyByConfidence(votes: CouncilVote[]): Map<OptionId, number> {
  const t = new Map<OptionId, number>();
  for (const v of votes) t.set(v.vote, (t.get(v.vote) ?? 0) + v.confidence);
  return t;
}

function pickWinner(t: Map<OptionId, number>): OptionId {
  let best: OptionId = "A";
  let bestScore = -Infinity;
  for (const [k, v] of t) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }
  return best;
}

function describeDisagreement(votes: CouncilVote[], ask: AgentAsk): string {
  const set = new Set(votes.map((v) => v.vote));
  if (set.size <= 1) return "unanimous";
  const sample = votes.slice(0, 3).map((v) => `${v.persona}→${v.vote}`).join(", ");
  return `surface=${ask.verification_surface}; split: ${sample}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
