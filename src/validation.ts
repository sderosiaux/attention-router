import type { AgentAsk, OptionId, RejectedAsk } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  repair_instructions: string[];
}

const VAGUE_PATTERNS = [
  /^\s*what\s+should\s+i\s+do[\s?!.]*$/i,
  /^\s*any\s+ideas[\s?!.]*$/i,
  /^\s*thoughts[\s?!.]*$/i,
  /^\s*help[\s?!.]*$/i,
  /^\s*suggestions[\s?!.]*$/i,
  /^\s*\??\s*$/, // empty/whitespace/just "?"
  /^\s*(hmm+|idk|not\s+sure)[\s?!.]*$/i,
];

const REPAIR_BASE = [
  "generate exactly 3 options labelled A, B, C",
  "add ≥1 evidence string per option",
  "pick a default_option_id (A | B | C)",
  "estimate confidence (0..1)",
  "estimate cost_if_wrong per option",
  "explain predicted_next_step per option",
  "include expected_loss_if_wrong (≥ 0)",
];

const REQUIRED_IDS: OptionId[] = ["A", "B", "C"];

export function validateAsk(ask: Partial<AgentAsk>): ValidationResult {
  const fail = (reason: string, extra: string[] = []): ValidationResult => ({
    valid: false,
    reason,
    repair_instructions: dedupe([...REPAIR_BASE, ...extra]),
  });

  if (!ask.options || !Array.isArray(ask.options) || ask.options.length === 0) {
    return fail("no options provided");
  }
  if (ask.options.length < 3) {
    return fail("fewer than 3 options (A, B, C required)");
  }
  const ids = ask.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) {
    return fail("duplicate option ids");
  }
  for (const need of REQUIRED_IDS) {
    if (!ids.includes(need)) return fail(`missing option ${need}`);
  }
  for (const id of ids) {
    if (!REQUIRED_IDS.includes(id)) return fail(`unknown option id: ${id}`);
  }
  if (!ask.default_option_id) return fail("no default option specified");
  if (!ids.includes(ask.default_option_id)) {
    return fail("default_option_id does not match any option");
  }
  if (typeof ask.confidence !== "number" || !Number.isFinite(ask.confidence)) {
    return fail("confidence missing");
  }
  if (ask.confidence < 0 || ask.confidence > 1) {
    return fail("confidence must be in [0, 1]");
  }
  if (
    typeof ask.expected_loss_if_wrong !== "number" ||
    !Number.isFinite(ask.expected_loss_if_wrong)
  ) {
    return fail("expected_loss_if_wrong missing");
  }
  if (ask.expected_loss_if_wrong < 0) {
    return fail("expected_loss_if_wrong must be >= 0");
  }
  if (ask.title && isVague(ask.title)) {
    return fail("title is vague/open-ended", ["reframe title with concrete decision"]);
  }
  if (ask.context !== undefined && isVague(ask.context)) {
    return fail("context is vague/empty", ["add concrete context: artifact, file, or observation"]);
  }
  if (ask.context !== undefined && ask.context.trim().length < 20) {
    return fail("context too short", ["expand context to at least one concrete sentence"]);
  }

  for (const opt of ask.options) {
    if (!opt.evidence || opt.evidence.length === 0) {
      return fail(`option ${opt.id} lacks evidence`);
    }
    if (!opt.predicted_next_step || opt.predicted_next_step.trim() === "") {
      return fail(`option ${opt.id} lacks predicted_next_step`);
    }
    if (!opt.cost_if_wrong || opt.cost_if_wrong.trim() === "") {
      return fail(`option ${opt.id} lacks cost_if_wrong`);
    }
  }

  return { valid: true, repair_instructions: [] };
}

export function toRejection(
  ask: Partial<AgentAsk>,
  result: ValidationResult,
): RejectedAsk {
  return {
    id: ask.id ?? "unknown",
    project_id: ask.project_id ?? "unknown",
    reason: result.reason ?? "invalid",
    repair_instructions: result.repair_instructions,
  };
}

function isVague(s: string): boolean {
  return VAGUE_PATTERNS.some((re) => re.test(s.trim()));
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
