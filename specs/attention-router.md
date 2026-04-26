# Attention Router — Spec

## Goal

A local prototype for a multi-agent attention router for long-running coding agents.

I run several AI coding agents in parallel. I do not want to constantly check terminals. The system collects agent "asks", rejects bad vague questions, batches the valid ones, scores which one deserves human attention, and presents only compact, high-quality decision cards.

## Core Ideas

1. **No Naked Questions** — every ask must carry options, evidence, default, cost-if-wrong, predicted next step
2. **Doppelgänger Council** — simulated reviewer panel votes before escalating to a human
3. **Attention Router** — bid scoring decides what reaches the human
4. **Human Batching** — human sees only top 1–3 cards, never a queue to open
5. **Optional project-specific UI surfaces** later — do not spend time on advanced UI now
6. **Ignore rollback-first autonomy** for now

## Architecture

- A local daemon/server
- Agents send JSONL or HTTP events to it
- Server validates events, rejects vague asks
- Server can ask a "council" of simulated reviewers before escalating
- Server scores bids and batches them
- Human gets a compact local CLI view showing only the best decision cards
- Human answers are saved as reusable judgment rules

### Storage

- SQLite or flat JSON files (start with JSON for inspectability)
- No cloud, no auth
- Simple, inspectable code

## Entities

### AgentAsk

```ts
{
  id: string,
  project_id: string,
  project_name: string,
  project_type: "game" | "software" | "other",
  verification_surface: "visual" | "business_rule" | "mixed" | "text",
  title: string,
  context: string,
  options: [
    {
      id: "A" | "B" | "C",
      label: string,
      evidence: string[],
      predicted_next_step: string,
      cost_if_wrong: string,
      confidence: number
    }
  ],
  default_option_id: "A" | "B" | "C",
  confidence: number,
  reversibility: "trivial" | "git_revert" | "costly" | "irreversible",
  expected_loss_if_wrong: number,
  requested_human_seconds: number,
  expires_in_seconds: number,
  created_at: string
}
```

### RejectedAsk

```ts
{
  id: string,
  project_id: string,
  reason: string,
  repair_instructions: string[]
}
```

### CouncilResult

```ts
{
  ask_id: string,
  votes: [
    { persona: string, vote: "A" | "B" | "C", confidence: number, reason: string }
  ],
  entropy: number,
  predicted_human_choice: "A" | "B" | "C",
  escalate: boolean,
  disagreement_axis: string
}
```

### AttentionBid

```ts
{ ask_id: string, score: number, reason: string, show_now: boolean }
```

### HumanDecision

```ts
{
  ask_id: string,
  choice: "A" | "B" | "C" | "override",
  override_text?: string,
  create_rule: boolean,
  created_at: string
}
```

### JudgmentRule

```ts
{
  id: string,
  scope: "project" | "all",
  project_id?: string,
  when: string,
  prefer: string,
  avoid: string,
  examples: string[],
  counterexamples: string[],
  priority: number,
  source_ask_id: string,
  created_at: string,
  status: "draft" | "accepted" | "rejected"
}
```

Lifecycle: `draft` (created from a HumanDecision) → `accepted` (loaded by future councils & router context) or `rejected` (kept as audit trail; ignored).

## No Naked Questions

An ask is **invalid** if any of:
- no options
- fewer than 3 options (A, B, C must all be present)
- option IDs not exactly the set {A, B, C}, or duplicated
- no default
- default not one of {A, B, C}
- lacks evidence (per option, ≥1 item)
- no predicted next step (per option)
- no cost-if-wrong (per option)
- open-ended title or context (matches "what should I do", "thoughts", "any ideas", "help", "suggestions", or context shorter than 20 chars without a concrete artifact reference)
- confidence missing, not in [0, 1], or NaN
- expected_loss_if_wrong missing, negative, or NaN
- requested_human_seconds or expires_in_seconds missing/negative
- created_at not ISO 8601 (server may fill if absent)

When invalid, return repair instructions:
- generate 3 options
- add evidence per option
- pick a default
- estimate confidence
- estimate cost if wrong
- explain what happens next for each option

## Doppelgänger Council

Before escalating, simulate 5 default personas:
- strict product thinker
- skeptical engineer
- impatient user
- business-rule guardian
- learned-human-preference proxy

Each votes A/B/C with confidence and reason. Compute entropy over votes.

**Escalate to human if** any of:
- `entropy ≥ ESCALATE_HIGH_ENTROPY` (default `1.0`, ~uniform vote across 3 options ≈ `1.585`)
- `expected_loss_if_wrong ≥ ESCALATE_HIGH_LOSS` (default `100`)
- reversibility ∈ {`costly`, `irreversible`}
- `confidence ≤ ESCALATE_LOW_CONFIDENCE` (default `0.5`)
- `predicted_human_choice ≠ default_option_id`

Thresholds are configurable via env (`AR_ESCALATE_HIGH_ENTROPY`, `AR_ESCALATE_HIGH_LOSS`, `AR_ESCALATE_LOW_CONFIDENCE`).

Otherwise auto-resolve silently with `status="auto_resolved"` and `safe_default_option_id = default_option_id`. The agent reads the auto-resolve outcome and proceeds with that option.

## Attention Router

```
score =
  expected_loss_if_wrong
  * uncertainty_weight
  * irreversibility_weight
  * disagreement_weight
  * starvation_bonus
  - requested_human_seconds
  - interruption_penalty
```

Weights:
- `uncertainty_weight = 1 + (1 - confidence)`
- `irreversibility_weight`: trivial 0.5 / git_revert 0.8 / costly 1.5 / irreversible 2.5
- `disagreement_weight` = 1.5 if council disagrees with default, else 1
- `starvation_bonus` = small boost if project hasn't received human attention recently
- `interruption_penalty` = configurable

## Batching

- Do not show every ask immediately
- Human batch view: **top 1–3 only**, ordered by urgency bucket then score:
  - `now` — `council.escalate=true` OR `<5m` to expiry OR `reversibility ∈ {costly, irreversible}`
  - `soon` — score above show-threshold and `<30m` to expiry
  - `today` — everything else passing show-threshold
- **Auto-expire only low-risk asks** (`!council.escalate` AND `reversibility ∈ {trivial, git_revert}` AND `expected_loss_if_wrong < 100`). High-risk asks past TTL are marked `stale` but still surface in the batch with a stale flag.
- Expiry boundary: an ask is expired when `now - created_at >= expires_in_seconds * 1000` (closed at boundary).
- Records that escalated must always be eligible for the batch regardless of `bid.show_now`.
- Rank tie-break: escalation > earliest expiry > older created_at > ask id.
- Never force the human to open a queue. `next` CLI returns the best current card.

## Decision Card Format

```
PROJECT_NAME · requested seconds · expires in X

TITLE

Context:
short context, max 5 lines

A. option label
Evidence: …
Next: …
Risk: …

B. option label
…

C. option label
…

Agent default: B
Council prediction: A
Why this reached you:
- council split on X
- expected loss is high
- confidence is low

Reply: A / B / C / override: <text> / skip
```

## Post-Decision Flow

- save `HumanDecision`
- propose a `JudgmentRule` draft
- accept/edit/reject through CLI
- future asks load matching rules and include them in scoring/context

## CLI Commands

- `start-server`
- `submit-ask <json-file>` — single JSON document
- `submit-jsonl <file>` — one ask per line; each validated independently
- `next` — top card
- `batch` — top 1–3 cards
- `decide <ask_id> <A|B|C>` — record human decision, drafts a rule
- `override <ask_id> "<text>"` — record override, drafts a rule
- `skip <ask_id>` — defer; record reaches the batch again only if score rises
- `rules`
- `accept-rule <rule_id>`
- `reject-rule <rule_id>`
- `edit-rule <rule_id> <field> <value>` — edit `prefer|avoid|priority|when`
- `projects`
- `status`

## Storage

- Single JSON file (`data/state.json`) with `schema_version` field.
- Cross-process **lock file** (`data/state.lock`, `O_EXCL` create with stale-detection > 30s) protects every save.
- Within a process, an async mutex serializes saves; saves write `state.json.<pid>.<n>.tmp` and atomically rename.
- On parse failure: rename corrupted file to `state.json.corrupt-<unix-ts>` and start with empty state.

## HTTP Boundary

- All bodies parsed with explicit runtime schemas; missing/wrong types → `400`.
- Bodies > `AR_MAX_BODY_BYTES` (default `1 MiB`) → `413`.
- `POST` endpoints require `content-type: application/json` (or no body) → otherwise `415`.
- `/next?max=N` clamped to `[1, 3]`.

## Constraints

- clean small code
- sample data
- README with examples
- Tests:
  - naked question rejection
  - valid ask acceptance
  - council vote generation
  - entropy calculation
  - bid scoring
  - batching order
  - judgment rule creation

## Frictions Captured From Dogfooding (next iterations)

Observed while using the router on its own design decisions:

1. **Council was a heuristic, not a real reviewer** — keyword-matching personas systematically preferred status-quo options ("simple", "minimal") and failed on security-flavored asks (auth question was not escalated). **Resolved**: replaced with real LLM personas (`AnthropicProvider`, default `claude-haiku-4-5`, prompt-cached shared system) — see `src/llm.ts` and `src/council.ts`. Set `ANTHROPIC_API_KEY` to use real LLM; otherwise `MockProvider` is used.
2. **Starvation bonus inflates first-use scores** — every newly-seen project triggers "project starved of attention" because no decision has ever been recorded. Cold-start should suppress the bonus until at least one decision exists.
3. **Ranking puts time-pressure ahead of importance** — `rankRecords()` orders by escalation > earliest expiry > created_at > score. A high-loss ask with a long TTL can be buried under a low-stakes ask with a short TTL. Consider a hybrid: first bucket by urgency, but rank by score within the bucket. (Already partially addressed by urgency buckets, but the within-bucket sort still falls back to expiry.)
4. **Parser silently ignores unknown fields** — typos in agent payloads (`predicted_next_function` vs `predicted_next_step`) pass through as missing required fields rather than as targeted errors. Add an "unknown field" warning to parser output.
5. **`topKeyword` rule extraction is fragile** — initial implementation produced `prefer=heuristic` / `avoid=default` / `prefer=humandecision` for plainly-named decisions. **Resolved** with weighted extraction + domain stopwords (`src/rules.ts`). Still imperfect for long override texts; a future improvement is to ask the LLM to summarize the chosen option's intent in 3-5 words.
6. **No way to revisit auto-resolved decisions** — once an ask auto-resolves, there's no surfacing if the human disagrees in retrospect. Consider an `audit-resolved` CLI listing recent auto-resolutions.

### Round 2 (real LLM council audited the router itself)

7. **Cold-start starvation bonus** — first-use asks for a project always carried "starved of attention" because `starvationSeconds` returned 24h placeholder. **Resolved**: returns 0 when no decision recorded.
8. **Within-bucket ranking favored expiry over score** — `rankRecords` ordered: escalation > earliest expiry > created_at > score. Real LLM council unanimously preferred score-first within buckets. **Resolved**: now escalation > score > expiry > created_at > id.
9. **Callback URL was an SSRF vector** — `deliverCallback` POSTed to any http(s) URL the agent named, including 127.0.0.1, link-local, internal subnets. **Resolved**: explicit allowlist via `AR_CALLBACK_ALLOWED_HOSTS` (default empty = all blocked, callback marked `failed` with log).
10. **Cross-domain rule bleed** — accepted rules were injected into every council prompt for that project regardless of topic relevance. **Resolved**: each rule carries a `topic` (top keywords from source ask); council only sees rules whose topic intersects the new ask's topic. Legacy rules without topic still match (back-compat).
11. **`topKeyword` still flakes when chosen and rejected options share a domain word** — observed `prefer=callback / avoid=callback` for the SSRF audit decision. Future: ask the LLM to summarize the chosen option's intent in 3-5 words instead of frequency-weighted extraction.

## Out of Scope (v1)

- Big dashboard
- Rollback features
- Deep Claude Code integration

The first version works as a local attention router that any agent can call by writing JSON or POSTing HTTP.

## Deliverables

1. Working code
2. README
3. Example valid ask
4. Example rejected naked ask
5. Example human flow
6. Tests
7. Notes on connecting later to Claude Code hooks or terminal agents
