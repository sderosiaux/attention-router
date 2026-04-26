import process from "node:process";
import type {
  AgentAsk,
  AskRecord,
  AttentionBid,
  CouncilResult,
  Reversibility,
} from "./types.ts";

export const IRREVERSIBILITY_WEIGHT: Record<Reversibility, number> = {
  trivial: 0.5,
  git_revert: 0.8,
  costly: 1.5,
  irreversible: 2.5,
};

export interface ScoreInput {
  ask: AgentAsk;
  council?: CouncilResult;
  starvation_seconds?: number;
  interruption_penalty?: number;
  show_threshold?: number;
}

export const DEFAULT_INTERRUPTION_PENALTY = envNum("AR_INTERRUPTION_PENALTY", 5);
export const DEFAULT_SHOW_THRESHOLD = envNum("AR_SHOW_THRESHOLD", 20);
export const STARVATION_HALF_LIFE_SEC = 60 * 60;

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function computeBid(input: ScoreInput): AttentionBid {
  const {
    ask,
    council,
    starvation_seconds = 0,
    interruption_penalty = DEFAULT_INTERRUPTION_PENALTY,
    show_threshold = DEFAULT_SHOW_THRESHOLD,
  } = input;

  const uncertainty = 1 + (1 - clamp01(ask.confidence));
  const irreversibility = IRREVERSIBILITY_WEIGHT[ask.reversibility];
  const disagreement =
    council && council.predicted_human_choice !== ask.default_option_id ? 1.5 : 1.0;
  const starvation = 1 + Math.min(0.5, starvation_seconds / (STARVATION_HALF_LIFE_SEC * 2));

  const positive =
    ask.expected_loss_if_wrong * uncertainty * irreversibility * disagreement * starvation;
  const score = positive - ask.requested_human_seconds - interruption_penalty;

  const reasonParts: string[] = [];
  if (council && council.predicted_human_choice !== ask.default_option_id) {
    reasonParts.push(`council picks ${council.predicted_human_choice} vs default ${ask.default_option_id}`);
  }
  if (ask.expected_loss_if_wrong >= 100) reasonParts.push("expected loss is high");
  if (ask.confidence <= 0.5) reasonParts.push("confidence is low");
  if (ask.reversibility === "costly" || ask.reversibility === "irreversible") {
    reasonParts.push(`reversibility=${ask.reversibility}`);
  }
  if (council && council.entropy >= 1.0) reasonParts.push("council split");
  if (starvation_seconds > STARVATION_HALF_LIFE_SEC) reasonParts.push("project starved of attention");

  return {
    ask_id: ask.id,
    score: round2(score),
    reason: reasonParts.length ? reasonParts.join("; ") : "low-impact ask",
    show_now: score >= show_threshold,
  };
}

export function rankBids(bids: AttentionBid[]): AttentionBid[] {
  return [...bids].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.ask_id.localeCompare(b.ask_id);
  });
}

/**
 * Within an urgency bucket, rank by SCORE first then expiry, not the reverse.
 * Rationale (from dogfood audit_ranking_priority): the urgency bucket already encodes
 * time pressure (now/soon/today). Inside a bucket the human wants to see the
 * highest-stakes ask first; expiry is a tie-break that still drains the queue
 * in time order when scores are equal.
 *
 * Order: escalation > score desc > earliest expiry > older created_at > ask id.
 */
export function rankRecords(recs: AskRecord[], now: Date = new Date()): AskRecord[] {
  return [...recs].sort((a, b) => {
    const ae = a.council?.escalate ? 1 : 0;
    const be = b.council?.escalate ? 1 : 0;
    if (ae !== be) return be - ae;

    const sa = a.bid?.score ?? 0;
    const sb = b.bid?.score ?? 0;
    if (sa !== sb) return sb - sa;

    const aRem = remaining(a, now);
    const bRem = remaining(b, now);
    if (aRem !== bRem) return aRem - bRem;

    const at = new Date(a.ask.created_at).getTime();
    const bt = new Date(b.ask.created_at).getTime();
    if (at !== bt) return at - bt;

    return a.ask.id.localeCompare(b.ask.id);
  });
}

function remaining(r: AskRecord, now: Date): number {
  const created = new Date(r.ask.created_at).getTime();
  return created + r.ask.expires_in_seconds * 1000 - now.getTime();
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
