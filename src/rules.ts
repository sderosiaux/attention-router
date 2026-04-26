import type {
  AgentAsk,
  AskOption,
  HumanDecision,
  JudgmentRule,
  OptionId,
} from "./types.ts";
import { randomUUID } from "node:crypto";

export interface DraftRuleInput {
  ask: AgentAsk;
  decision: HumanDecision;
  scope?: "project" | "all";
}

export function draftRule(input: DraftRuleInput): JudgmentRule {
  const { ask, decision } = input;
  const scope = input.scope ?? "project";

  const chosen = pickChosenOption(ask, decision);
  const rejected = ask.options.filter((o) => o !== chosen);

  const prefer = chosen
    ? topKeyword(chosen.label + " " + chosen.evidence.join(" "), chosen.label)
    : (decision.override_text ?? "human override");
  const avoid = rejected.length
    ? topKeyword(
        rejected.map((o) => o.label + " " + o.evidence.join(" ")).join(" "),
        rejected[0]!.label,
      )
    : "";

  return {
    id: `rule_${randomUUID().slice(0, 8)}`,
    scope,
    project_id: scope === "project" ? ask.project_id : undefined,
    when: `verification_surface=${ask.verification_surface}; reversibility=${ask.reversibility}`,
    prefer,
    avoid,
    examples: chosen ? [`${ask.title} → ${chosen.label}`] : [`${ask.title} → ${decision.override_text ?? "override"}`],
    counterexamples: rejected.map((o) => `${ask.title} ↛ ${o.label}`),
    priority: 1,
    source_ask_id: ask.id,
    created_at: new Date().toISOString(),
    status: "draft",
    topic: extractTopic(ask),
  };
}

/**
 * Cheap heuristic topic extraction from the ask's title + context.
 * Used by Service.submitAsk to filter accepted rules before injecting them into
 * the council prompt — prevents cross-domain rule bleed (audit_rule_self_loop A).
 *
 * Note: for higher precision, swap with an LLM call (claude-haiku-4-5 with the same
 * SHARED_SYSTEM_PREFIX). For now keep it deterministic and cheap.
 */
export function extractTopic(ask: { title: string; context: string }): string[] {
  const text = `${ask.title} ${ask.context}`.toLowerCase();
  const words = text
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

/** Returns true if rule.topic shares ≥1 word with the new ask's topic. */
export function ruleMatchesAsk(rule: { topic?: string[] }, askTopic: string[]): boolean {
  if (!rule.topic || rule.topic.length === 0) return true; // legacy rules: always match
  if (askTopic.length === 0) return true;
  const set = new Set(askTopic);
  return rule.topic.some((t) => set.has(t));
}

function pickChosenOption(ask: AgentAsk, decision: HumanDecision): AskOption | undefined {
  if (decision.choice === "override") return undefined;
  return ask.options.find((o) => o.id === (decision.choice as OptionId));
}

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with", "by",
  "is", "it", "this", "that", "use", "using", "via", "as", "at", "be", "are",
  "was", "were", "from", "into", "out", "up", "down", "all", "any", "each",
  "more", "less", "than", "if", "but", "not", "no", "so", "do", "does", "did",
  "have", "has", "had", "can", "could", "should", "would", "will", "may",
  "might", "must", "ship", "add", "make", "set", "get", "etc",
  // generic option-flow words that shouldn't dominate prefer/avoid
  "default", "always", "option", "choice", "label", "rules", "rule",
  "evidence", "next", "step", "cost", "wrong", "confidence",
  "long", "short", "small", "big", "high", "low", "ago", "now", "later",
]);

const CONTEXT_WEIGHT_BOOST = new Set([
  // domain-specific words we know carry decision intent
  "redis", "postgres", "sqlite", "lru", "cache", "queue", "webhook",
  "callback", "bearer", "token", "auth", "session", "cooldown", "interface",
  "pluggable", "heuristic", "llm", "decay", "manual", "stale",
]);

/**
 * Pick the most decision-carrying word.
 * Strategy:
 *   1. tokenize, drop stopwords / pure numbers / short words
 *   2. boost domain-specific terms
 *   3. score by frequency × idf-ish length bonus, ties → first occurrence
 */
function topKeyword(text: string, fallback?: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  if (words.length === 0) {
    return (fallback ?? text).slice(0, 60);
  }

  const score = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  words.forEach((w, i) => {
    const boost = CONTEXT_WEIGHT_BOOST.has(w) ? 5 : 1;
    const lengthBonus = Math.min(2, w.length / 8);
    const cur = score.get(w) ?? 0;
    score.set(w, cur + boost + lengthBonus);
    if (!firstSeen.has(w)) firstSeen.set(w, i);
  });

  let best = words[0]!;
  let bestScore = -Infinity;
  for (const [w, s] of score) {
    if (s > bestScore || (s === bestScore && firstSeen.get(w)! < firstSeen.get(best)!)) {
      best = w;
      bestScore = s;
    }
  }
  return best;
}
