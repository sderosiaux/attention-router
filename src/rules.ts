import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  AgentAsk,
  AskOption,
  HumanDecision,
  JudgmentRule,
  OptionId,
} from "./types.ts";
import type { LlmProvider } from "./llm.ts";

const ExtractionSchema = z.object({
  prefer: z.string().min(1).max(80),
  avoid: z.string().min(0).max(60),
});
type Extraction = z.infer<typeof ExtractionSchema>;

export interface DraftRuleInput {
  ask: AgentAsk;
  decision: HumanDecision;
  scope?: "project" | "all";
  /** Optional LLM provider — if absent, uses cheap fallback (chosen.label as prefer). */
  provider?: LlmProvider;
}

/**
 * Draft a JudgmentRule from a HumanDecision.
 *
 * `prefer` and `avoid` are extracted by the LLM in one call (3-5 word phrases
 * grounded in the ask). This replaces the brittle frequency-weighted keyword
 * extraction the v0.1.1 used.
 *
 * If no provider is supplied (e.g. unit tests against pure logic), falls back
 * to using the chosen option's label verbatim — better than nothing, never wrong.
 */
export async function draftRule(input: DraftRuleInput): Promise<JudgmentRule> {
  const { ask, decision } = input;
  const scope = input.scope ?? "project";

  const chosen = pickChosenOption(ask, decision);
  const rejected = ask.options.filter((o) => o !== chosen);

  const { prefer, avoid } = await extractPreferAvoid({
    ask,
    chosen,
    rejected,
    decision,
    provider: input.provider,
  });

  return {
    id: `rule_${randomUUID().slice(0, 8)}`,
    scope,
    project_id: scope === "project" ? ask.project_id : undefined,
    when: `verification_surface=${ask.verification_surface}; reversibility=${ask.reversibility}`,
    prefer,
    avoid,
    examples: chosen
      ? [`${ask.title} → ${chosen.label}`]
      : [`${ask.title} → ${decision.override_text ?? "override"}`],
    counterexamples: rejected.map((o) => `${ask.title} ↛ ${o.label}`),
    priority: 1,
    source_ask_id: ask.id,
    created_at: new Date().toISOString(),
    status: "draft",
    topic: extractTopic(ask),
  };
}

interface ExtractInput {
  ask: AgentAsk;
  chosen: AskOption | undefined;
  rejected: AskOption[];
  decision: HumanDecision;
  provider?: LlmProvider;
}

async function extractPreferAvoid(
  input: ExtractInput,
): Promise<{ prefer: string; avoid: string }> {
  const { ask, chosen, rejected, decision, provider } = input;

  // Override path: the human's free-form text IS the prefer signal — no LLM call needed.
  if (decision.choice === "override") {
    return {
      prefer: (decision.override_text ?? "override").slice(0, 80),
      avoid: rejected[0]?.label.slice(0, 60) ?? "",
    };
  }

  // No provider → cheap fallback: chosen label verbatim. Used by unit tests of pure logic.
  if (!provider) {
    return {
      prefer: (chosen?.label ?? "").slice(0, 80),
      avoid: rejected[0]?.label.slice(0, 60) ?? "",
    };
  }

  const system = `You distill a developer's decision into two short keyword phrases for a JudgmentRule.

Output STRICT JSON only, no prose, no markdown:
{"prefer": "<3-5 words capturing why the chosen option won>", "avoid": "<3-5 words capturing what the rejected options had in common to avoid>"}

Rules:
- prefer/avoid each ≤ 60 chars
- Use noun phrases, not full sentences
- Ground in the actual labels/evidence — do NOT invent generic concepts
- "avoid" should describe a pattern the human walked away from, not just one option's label
- Never include the words "user", "value", "thing", "way", "case", "time" — they carry no decision signal`;

  const user = renderExtractionPrompt(ask, chosen!, rejected);

  try {
    const r = await provider.call<Extraction>({
      system,
      systemCacheable: true,
      user,
      maxTokens: 150,
      schema: ExtractionSchema,
    });
    const ex = r.parsed ?? parseExtractionText(r.text);
    return {
      prefer: clip(ex.prefer, chosen?.label ?? ""),
      avoid: clip(ex.avoid, rejected[0]?.label ?? ""),
    };
  } catch {
    // LLM error → fall back to cheap verbatim labels. Don't crash the whole decide flow.
    return {
      prefer: (chosen?.label ?? "").slice(0, 80),
      avoid: rejected[0]?.label.slice(0, 60) ?? "",
    };
  }
}

function renderExtractionPrompt(
  ask: AgentAsk,
  chosen: AskOption,
  rejected: AskOption[],
): string {
  const rejectedBlock = rejected
    .map(
      (o) =>
        `Option ${o.id}: ${o.label}\n  Evidence: ${o.evidence.join(" | ")}`,
    )
    .join("\n");

  return `Decision title: ${ask.title}

Chosen option ${chosen.id}: ${chosen.label}
  Evidence: ${chosen.evidence.join(" | ")}

Rejected:
${rejectedBlock}

Distill prefer/avoid now.`;
}

function pickChosenOption(ask: AgentAsk, decision: HumanDecision): AskOption | undefined {
  if (decision.choice === "override") return undefined;
  return ask.options.find((o) => o.id === (decision.choice as OptionId));
}

/** Last-resort plain-text JSON parse — only used when a provider returned text without parsed. */
function parseExtractionText(raw: string): Extraction {
  const trimmed = raw.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in extractor response");
    obj = JSON.parse(m[0]);
  }
  return ExtractionSchema.parse(obj);
}

function clip(s: string, fallback: string): string {
  const v = (s || fallback).trim();
  return v.slice(0, 80);
}

/**
 * Lightweight topic extraction — kept heuristic on purpose: this runs on every
 * ask and stays cheap. Returns up to 6 keywords for rule-relevance filtering.
 */
export function extractTopic(ask: { title: string; context: string }): string[] {
  const text = `${ask.title} ${ask.context}`.toLowerCase();
  const words = text
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !TOPIC_STOPWORDS.has(w) && !/^\d+$/.test(w));
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);
}

/** Returns true if rule.topic shares ≥1 word with the new ask's topic. */
export function ruleMatchesAsk(rule: { topic?: string[] }, askTopic: string[]): boolean {
  if (!rule.topic || rule.topic.length === 0) return true;
  if (askTopic.length === 0) return true;
  const set = new Set(askTopic);
  return rule.topic.some((t) => set.has(t));
}

// Topic extraction needs a smaller filter — it's just for relevance routing,
// not for naming a rule. Function words only.
const TOPIC_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "have", "from", "they", "your",
  "what", "when", "where", "should", "could", "would", "must", "will", "into",
  "than", "more", "than", "some", "such", "very", "just", "then", "also",
  "been", "were", "their", "them", "those", "these",
]);
