import type {
  AgentAsk,
  AskOption,
  HumanDecision,
  OptionId,
  ProjectType,
  Reversibility,
  VerificationSurface,
} from "./types.ts";

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

const PROJECT_TYPES: ProjectType[] = ["game", "software", "other"];
const SURFACES: VerificationSurface[] = ["visual", "business_rule", "mixed", "text"];
const REVERSIBILITY: Reversibility[] = ["trivial", "git_revert", "costly", "irreversible"];
const OPTION_IDS: OptionId[] = ["A", "B", "C"];
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ParseAskOptions {
  /** When true, server fills missing id/created_at instead of failing. */
  fill_defaults?: boolean;
}

export function parseAgentAsk(input: unknown, opts: ParseAskOptions = {}): AgentAsk {
  const o = mustObj(input, "body");
  const ask: AgentAsk = {
    id: o.id !== undefined ? str(o.id, "id", ID_RE) : opts.fill_defaults ? `ask_${Date.now()}_${rand()}` : missing("id"),
    project_id: str(o.project_id, "project_id", ID_RE),
    project_name: str(o.project_name, "project_name").slice(0, 200),
    project_type: enumOf(o.project_type, "project_type", PROJECT_TYPES),
    verification_surface: enumOf(o.verification_surface, "verification_surface", SURFACES),
    title: str(o.title, "title").slice(0, 200),
    context: str(o.context, "context").slice(0, 4000),
    options: parseOptions(o.options),
    default_option_id: enumOf(o.default_option_id, "default_option_id", OPTION_IDS),
    confidence: num01(o.confidence, "confidence"),
    reversibility: enumOf(o.reversibility, "reversibility", REVERSIBILITY),
    expected_loss_if_wrong: nonNegNum(o.expected_loss_if_wrong, "expected_loss_if_wrong"),
    requested_human_seconds: o.requested_human_seconds === undefined && opts.fill_defaults
      ? 30
      : nonNegInt(o.requested_human_seconds, "requested_human_seconds"),
    expires_in_seconds: o.expires_in_seconds === undefined && opts.fill_defaults
      ? 3600
      : posInt(o.expires_in_seconds, "expires_in_seconds"),
    created_at: o.created_at !== undefined ? iso(o.created_at, "created_at") : opts.fill_defaults ? new Date().toISOString() : missing("created_at"),
    callback_url: o.callback_url === undefined ? undefined : url(o.callback_url, "callback_url"),
  };

  // Cross-field invariants
  const ids = ask.options.map((o) => o.id);
  const seen = new Set<OptionId>();
  for (const id of ids) {
    if (seen.has(id)) throw new SchemaError(`duplicate option id: ${id}`);
    seen.add(id);
  }
  if (!ids.includes(ask.default_option_id)) {
    throw new SchemaError("default_option_id does not match any option");
  }
  return ask;
}

function parseOptions(input: unknown): AskOption[] {
  if (!Array.isArray(input)) throw new SchemaError("options must be an array");
  if (input.length === 0) throw new SchemaError("options is empty");
  return input.map((raw, i) => {
    const o = mustObj(raw, `options[${i}]`);
    return {
      id: enumOf(o.id, `options[${i}].id`, OPTION_IDS),
      label: str(o.label, `options[${i}].label`).slice(0, 200),
      evidence: parseEvidence(o.evidence, `options[${i}].evidence`),
      predicted_next_step: str(o.predicted_next_step, `options[${i}].predicted_next_step`).slice(0, 1000),
      cost_if_wrong: str(o.cost_if_wrong, `options[${i}].cost_if_wrong`).slice(0, 500),
      confidence: num01(o.confidence, `options[${i}].confidence`),
    };
  });
}

function parseEvidence(input: unknown, field: string): string[] {
  if (!Array.isArray(input)) throw new SchemaError(`${field} must be an array`);
  return input.map((e, i) => {
    if (typeof e !== "string") throw new SchemaError(`${field}[${i}] must be a string`);
    return e.slice(0, 500);
  });
}

export function parseHumanDecision(input: unknown): HumanDecision {
  const o = mustObj(input, "body");
  const choiceRaw = o.choice;
  if (typeof choiceRaw !== "string" || !["A", "B", "C", "override"].includes(choiceRaw)) {
    throw new SchemaError("choice must be one of A|B|C|override");
  }
  const choice = choiceRaw as HumanDecision["choice"];
  const override_text =
    choice === "override"
      ? str(o.override_text, "override_text").slice(0, 2000)
      : (o.override_text === undefined ? undefined : str(o.override_text, "override_text").slice(0, 2000));
  if (choice === "override" && !override_text) {
    throw new SchemaError("override_text required when choice=override");
  }
  return {
    ask_id: str(o.ask_id, "ask_id", ID_RE),
    choice,
    override_text,
    create_rule: o.create_rule === undefined ? false : bool(o.create_rule, "create_rule"),
    created_at: o.created_at !== undefined ? iso(o.created_at, "created_at") : new Date().toISOString(),
  };
}

export function parseRuleId(input: unknown): { id: string } {
  const o = mustObj(input, "body");
  return { id: str(o.id, "id", ID_RE) };
}

// ------- primitives -------

function mustObj(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new SchemaError(`${field} must be an object`);
  }
  return v as Record<string, unknown>;
}
function str(v: unknown, field: string, re?: RegExp): string {
  if (typeof v !== "string") throw new SchemaError(`${field} must be a string`);
  if (v.length === 0) throw new SchemaError(`${field} must be non-empty`);
  if (re && !re.test(v)) throw new SchemaError(`${field} fails pattern ${re}`);
  return v;
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw new SchemaError(`${field} must be boolean`);
  return v;
}
function enumOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new SchemaError(`${field} must be one of ${allowed.join("|")}`);
  }
  return v as T;
}
function num01(v: unknown, field: string): number {
  const n = mustFiniteNum(v, field);
  if (n < 0 || n > 1) throw new SchemaError(`${field} must be in [0, 1]`);
  return n;
}
function nonNegNum(v: unknown, field: string): number {
  const n = mustFiniteNum(v, field);
  if (n < 0) throw new SchemaError(`${field} must be >= 0`);
  return n;
}
function nonNegInt(v: unknown, field: string): number {
  const n = nonNegNum(v, field);
  if (!Number.isInteger(n)) throw new SchemaError(`${field} must be an integer`);
  return n;
}
function posInt(v: unknown, field: string): number {
  const n = nonNegInt(v, field);
  if (n <= 0) throw new SchemaError(`${field} must be > 0`);
  return n;
}
function mustFiniteNum(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaError(`${field} must be a finite number`);
  }
  return v;
}
function iso(v: unknown, field: string): string {
  const s = str(v, field);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new SchemaError(`${field} must be ISO 8601`);
  return d.toISOString();
}
function url(v: unknown, field: string): string {
  const s = str(v, field);
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new SchemaError(`${field} must be http(s) URL`);
    }
    return s;
  } catch (e) {
    if (e instanceof SchemaError) throw e;
    throw new SchemaError(`${field} must be a valid URL`);
  }
}
function missing(field: string): never {
  throw new SchemaError(`${field} is required`);
}
function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}
