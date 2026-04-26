import process from "node:process";
import type { AskRecord, Urgency } from "./types.ts";
import { rankRecords } from "./router.ts";

export interface BatchOptions {
  max?: number;
  now?: Date;
  skip_cooldown_seconds?: number;
}

const URGENCY_RANK: Record<Urgency, number> = { now: 0, soon: 1, today: 2 };

export function defaultSkipCooldown(): number {
  const v = Number(process.env.AR_SKIP_COOLDOWN_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 1800;
}

export function buildBatch(records: AskRecord[], opts: BatchOptions = {}): AskRecord[] {
  const max = clampMax(opts.max ?? 3);
  const now = opts.now ?? new Date();
  const skipCooldown = opts.skip_cooldown_seconds ?? defaultSkipCooldown();

  const live = records.filter((r) => {
    if (!r.bid) return false;
    if (isHardExpired(r, now)) return false;
    if (r.status === "pending" || r.status === "stale") {
      return r.bid.show_now || r.council?.escalate || r.status === "stale";
    }
    if (r.status === "skipped" && r.skipped_at) {
      const elapsed = (now.getTime() - new Date(r.skipped_at).getTime()) / 1000;
      return elapsed >= skipCooldown && (r.bid.show_now || r.council?.escalate);
    }
    return false;
  });

  for (const r of live) r.urgency = bucketize(r, now);

  const ranked = rankRecords(live, now);
  ranked.sort((a, b) => URGENCY_RANK[a.urgency!] - URGENCY_RANK[b.urgency!]);
  return ranked.slice(0, max);
}

export function clampMax(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(3, Math.floor(n)));
}

/**
 * Spec: auto-expire only low-risk asks. High-risk past TTL are marked `stale`
 * and remain visible.
 */
export function expireStale(records: AskRecord[], now: Date = new Date()): AskRecord[] {
  const changed: AskRecord[] = [];
  for (const r of records) {
    if (r.status !== "pending") continue;
    if (!isExpired(r, now)) continue;
    if (isLowRisk(r)) {
      r.status = "expired";
    } else {
      r.status = "stale";
    }
    changed.push(r);
  }
  return changed;
}

export function isLowRisk(r: AskRecord): boolean {
  if (r.council?.escalate) return false;
  if (r.ask.reversibility === "costly" || r.ask.reversibility === "irreversible") return false;
  if (r.ask.expected_loss_if_wrong >= 100) return false;
  return true;
}

/** Spec: expired when now - created_at >= TTL (closed at boundary). */
export function isExpired(r: AskRecord, now: Date = new Date()): boolean {
  const created = new Date(r.ask.created_at).getTime();
  return now.getTime() - created >= r.ask.expires_in_seconds * 1000;
}

/** Stale records are kept in the batch even past TTL; only "hard expired" (status=expired) drop. */
function isHardExpired(r: AskRecord, _now: Date): boolean {
  return r.status === "expired";
}

function bucketize(r: AskRecord, now: Date): Urgency {
  if (r.council?.escalate) return "now";
  if (r.ask.reversibility === "costly" || r.ask.reversibility === "irreversible") return "now";
  const remMs = new Date(r.ask.created_at).getTime() + r.ask.expires_in_seconds * 1000 - now.getTime();
  if (remMs <= 5 * 60_000) return "now";
  if (remMs <= 30 * 60_000) return "soon";
  return "today";
}
