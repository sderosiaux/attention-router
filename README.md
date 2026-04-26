# attention-router

> Triage AI coding agents' questions. A 5-persona LLM council auto-resolves what's safe, surfaces only the highest-value decisions to you.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node ≥ 20](https://img.shields.io/badge/Node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

You run several AI coding agents in parallel. You miss half their questions because they're in terminals you tabbed away from. The other half are vague — "what should I do?" — and force you to rebuild context.

`attention-router` fixes both. Agents send **structured asks** to a local daemon. A council of 5 LLM personas votes. Naked questions are rejected with repair instructions. Safe decisions auto-resolve silently. Only the genuinely ambiguous, high-stakes forks reach you, ranked by urgency × score, never more than 3 at a time.

## Table of contents

- [Demo](#demo)
- [Install — Claude Code plugin (recommended)](#install--claude-code-plugin-recommended)
- [How it works](#how-it-works)
- [The human side](#the-human-side)
- [Other agents (raw HTTP)](#other-agents-raw-http)
- [Configuration](#configuration)
- [HTTP API reference](#http-api-reference)
- [Decision card format](#decision-card-format)
- [Architecture](#architecture)
- [Development](#development)
- [Status](#status)
- [License](#license)

## Demo

```
agent ── POST /asks/structure ──┐
                                ▼
                     ┌──────────────────────┐
                     │  attention-router    │
                     │  ┌────────────────┐  │
                     │  │ council (×5)   │  │  ← Claude personas vote
                     │  │ entropy / loss │  │     in parallel
                     │  │ reversibility  │  │
                     │  └───────┬────────┘  │
                     │          │           │
                     │   ┌──────┴──────┐    │
                     │   ▼             ▼    │
                     │ auto         queued  │
                     │ _resolved   for human│
                     └────┬─────────────┬───┘
                          │             │
              proceeds ◀──┘             └──▶  attn next  →  YOU
              silently                        (1-3 cards, ranked)
```

Decision card you actually see (ASCII):

```
billing-api · ~30s requested · expires in 25m

PICK BACKFILL STRATEGY FOR USERS_PROFILE TABLE

A. Inline backfill in the migration
   Evidence: lock window <30s on test data, atomic with schema change
   Next: run UPDATE in same txn
   Risk: lock contention on prod; rollback safe

B. Background job (Sidekiq), schema first
   Evidence: safer for live traffic, observed pattern across team
   Next: queue 1000 batches of 50k rows
   Risk: schema drift if job lags > 1h

C. Maintenance window tonight
   Evidence: zero risk, but delays release by 12h
   Next: schedule 02:00 deploy
   Risk: pager wakes you up if it slips

Agent default: B    Council prediction: B    (entropy=0.971)
Why this reached you:
  - urgency=now (reversibility=costly)
  - expected loss is high (estimated $5000)
  - council split between A and B

Reply:  A / B / C / override: <text> / skip
```

## Install — Claude Code plugin (recommended)

```
/plugin marketplace add sderosiaux/claude-plugins
/plugin install attention-router@sderosiaux-claude-plugins
```

That's it. The plugin ships:

| Component | Role |
|---|---|
| **MCP server** (stdio) | Exposes `ask_human`, `wait_for_decision`, `get_pending` tools to Claude |
| **`ask-human` skill** | Teaches Claude *when* to invoke `ask_human` (vs. resolving the fork itself) |
| **SessionStart hook** | Idempotently launches the daemon on `127.0.0.1:7777` if not already up |
| **CLI** (`attn`) | Your side: `attn next`, `attn batch`, `attn decide`, `attn status` |

### Requirements

- Node ≥ 20 in `PATH`
- An Anthropic API key as `THE_ANTHROPIC_API_KEY` (Claude Code overrides `ANTHROPIC_API_KEY=dummy`, so the daemon's hook reads `THE_ANTHROPIC_API_KEY` first). Without a key, the council falls back to `MockProvider` (deterministic but useless beyond smoke tests).
- **No `MCP_TIMEOUT` tweak needed** since v0.2.0. `ask_human` polls briefly (30s) and returns; the plugin's Stop hook (`asyncRewake: true`) then waits in the background and wakes the agent with the decision when the human responds — even hours later. If you previously set `MCP_TIMEOUT=14400000`, you can drop it.

### Your daily flow

1. Start any Claude Code session as usual. The hook launches the daemon transparently on session 0.
2. Agents that hit a real fork **invoke `ask_human` themselves** (the skill triggers them). You see nothing in that terminal.
3. In **one** dedicated watcher terminal:
   ```sh
   watch -n 5 attn batch
   ```
4. When a card surfaces, decide in seconds:
   ```sh
   attn decide ask_xxx A
   attn override ask_xxx "use mTLS, skip JWT"
   attn skip ask_xxx              # snooze for AR_SKIP_COOLDOWN_SEC
   ```

> **Don't try to invoke MCP tools by hand or curl the daemon manually.** Claude does it. Your job is to install the plugin and watch the queue. Manual HTTP usage is documented under [Other agents](#other-agents-raw-http) for non-Claude-Code integrations only.

### Local development install

If you cloned this repo and want to test the plugin locally before the marketplace publishes a new version:

```
/plugin marketplace add /path/to/your/clone
/plugin install attention-router
```

See [`PLUGIN-INSTALL.md`](PLUGIN-INSTALL.md) for the full plugin layout and publishing checklist.

## How it works

Five concepts, that's it.

1. **No Naked Questions** — every ask must carry options, evidence, a default, predicted next steps, cost-if-wrong. Naked asks are rejected with repair instructions; the agent has to do the work itself before it's allowed to interrupt you. The MCP `ask_human` tool hides this — you give it `(dilemma, context)` and the router LLM drafts the structured ask for you.
2. **Doppelgänger Council** — 5 LLM personas (strict product thinker, skeptical engineer, impatient user, business-rule guardian, learned-human-preference proxy) vote A/B/C with confidence and reason. Real `claude-haiku-4-5` calls, prompt-cached on the shared system prefix.
3. **Escalation rules** — escalate to you when any of: entropy ≥ 1.0, expected_loss ≥ 100, reversibility ∈ {costly, irreversible}, confidence ≤ 0.5, predicted ≠ default.
4. **Bid scoring** — `expected_loss × uncertainty × irreversibility × disagreement × starvation − human_seconds − interruption_penalty`. Above threshold + escalated → reaches the batch.
5. **Judgment rules** — your decisions become draft rules. Accept them and the council weighs them on future asks (topic-filtered to prevent cross-domain bleed).

Full spec: [`specs/attention-router.md`](specs/attention-router.md).

## The human side

The CLI is the only thing you regularly touch. **Note**: `/plugin install` does not auto-link the `attn` binary to your `PATH`. Add an alias once:

```sh
echo 'alias attn="npx -y tsx ~/.claude/plugins/attention-router/src/cli.ts"' >> ~/.zshrc
exec zsh
```

(or `git clone … && cd attention-router && npm install -g .` if you prefer a global install).

```
attn next                            top decision card (most important right now)
attn batch                           top 1–3 cards
attn decide <ask_id> <A|B|C>         record decision (drafts a rule)
attn override <ask_id> "<text>"      free-form override (drafts a rule)
attn skip <ask_id>                   defer (re-surfaces after AR_SKIP_COOLDOWN_SEC)
attn status                          counters (pending / decided / auto-resolved / …)
attn projects                        per-project pending counts

attn rules                           list rules incl. drafts
attn accept-rule <id>                draft → accepted (weighs future councils)
attn reject-rule <id>                kill a rule
attn edit-rule <id> <field> <value>  field ∈ prefer | avoid | priority | when
```

Server lifecycle (you rarely run these — the plugin's hook handles it):

```
attn start-server                    daemon on 127.0.0.1:7777
attn submit-ask <file.json>          submit a single pre-built AgentAsk
attn submit-jsonl <file>             one ask per line
attn smart-ask <file.json>           {dilemma, context, project_id} → router LLM drafts the ask
```

## Other agents (raw HTTP)

If you're integrating an agent **outside** Claude Code (custom Python script, internal CLI, CI bot), POST to the daemon directly. Both endpoints are valid:

**`POST /asks/structure`** — agent sends `{dilemma, context, project_id}`, router LLM drafts the 3 options. Recommended unless you have a reason to control every field.

```sh
curl -sS -XPOST http://127.0.0.1:7777/asks/structure \
  -H 'content-type: application/json' \
  --data '{
    "project_id": "billing-api",
    "project_name": "billing-api",
    "dilemma": "Backfill 50M rows inline vs. background — lock contention vs. schema drift.",
    "context": "users table is hot, ~3000 RPS. Migration adds tier column. Sidekiq queue exists. Test on staging showed inline lock window of 23s for 1M rows."
  }'
```

**`POST /asks`** — agent sends a fully-structured `AgentAsk` (3 options + evidence + default + cost-if-wrong + …). Use when you want full control or have already structured the question upstream.

```sh
curl -sS -XPOST http://127.0.0.1:7777/asks \
  -H 'content-type: application/json' \
  --data-binary @examples/valid-ask.json
```

Agent integration pattern (TypeScript):

```ts
const r = await fetch("http://127.0.0.1:7777/asks/structure", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ project_id, project_name, dilemma, context }),
});
const out = await r.json();

if (out.status === "auto_resolved") return out.safe_default_option_id; // proceed silently
if (out.status === "rejected") throw new Error(out.rejected.reason);  // fix and retry
// status === "queued" → poll /next or wait for callback_url webhook
```

Optional: pass `callback_url` (allowlisted via `AR_CALLBACK_ALLOWED_HOSTS`) and the daemon POSTs the decision when it lands — no polling needed.

## Configuration

All env vars; sane defaults; configure only what you need.

| Var | Default | Effect |
|---|---|---|
| `THE_ANTHROPIC_API_KEY` | — | Real Anthropic key for the council. Preferred over `ANTHROPIC_API_KEY` (which Claude Code overrides). |
| `AR_HOOK_MAX_WAIT_SEC` | `86400` (24h) | How long the Stop hook keeps polling for a decision before giving up |
| `AR_HOOK_POLL_INTERVAL_SEC` | `5` | Stop-hook poll interval |
| `ANTHROPIC_API_KEY` | `dummy` (in CC) | Fallback. If neither set, council uses `MockProvider`. |
| `AR_LLM_MODEL` | `claude-haiku-4-5` | Model for the 5 council personas. |
| `AR_LLM_MODE` | (auto) | Force `mock` to disable real LLM calls (used by the test suite). |
| `AR_PORT` / `AR_HOST` | `7777` / `127.0.0.1` | Daemon bind. Keep loopback unless you really know what you're doing. |
| `AR_DATA_DIR` | `./data` (CLI), `~/.attention-router/data` (plugin) | Where `state.json` lives. |
| `AR_AUTH_TOKEN` | — | If set, all HTTP requests need `Authorization: Bearer <token>`. |
| `AR_CALLBACK_ALLOWED_HOSTS` | — (all blocked) | Comma-separated allowlist for webhook `callback_url` (SSRF guard). |
| `AR_MAX_BODY_BYTES` | `1048576` | HTTP body cap → 413 above. |
| `AR_INTERRUPTION_PENALTY` | `5` | Subtracted from every bid score. |
| `AR_SHOW_THRESHOLD` | `20` | Bid must clear this to set `show_now=true`. |
| `AR_SKIP_COOLDOWN_SEC` | `1800` | Delay before a `skip`'d ask re-surfaces. |
| `AR_ESCALATE_HIGH_ENTROPY` | `1.0` | Council entropy ≥ this → escalate. |
| `AR_ESCALATE_HIGH_LOSS` | `100` | `expected_loss_if_wrong` ≥ this → escalate. |
| `AR_ESCALATE_LOW_CONFIDENCE` | `0.5` | Agent confidence ≤ this → escalate. |

## HTTP API reference

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/healthz` | — | `{ok: true, schema_version: 1}` |
| `POST` | `/asks/structure` | `{dilemma, context, project_id, …}` | LLM drafts 3 options, runs council, returns outcome + drafted_ask. **Preferred entry point.** |
| `POST` | `/asks` | `AgentAsk` JSON | Full-structured submit. `202` queued/auto, `422` naked + repair, `400/413/415` shape/size/type. |
| `POST` | `/asks/jsonl` | one ask per line | Per-line result; bad lines reported. |
| `GET` | `/next?max=3` | — | Top batch (clamped to `[1,3]`). |
| `POST` | `/decisions` | `HumanDecision` | `404` unknown, `409` not pending, `400` bad choice. |
| `POST` | `/skip` | `{id}` | `404` unknown. |
| `GET` | `/rules` | — | All rules. |
| `POST` | `/rules/accept` | `{id}` | Promote draft → accepted. |
| `POST` | `/rules/reject` | `{id}` | Kill rule. |
| `POST` | `/rules/stale` | `{id}` | Mark accepted rule stale (no future use). |
| `POST` | `/rules/edit` | `{id, field, value}` | `field ∈ prefer / avoid / priority / when`. |
| `GET` | `/projects` | — | Per-project pending counts. |
| `GET` | `/status` | — | Global counters. |

All `POST` endpoints require `content-type: application/json`. If `AR_AUTH_TOKEN` is set, requests need `Authorization: Bearer <token>` (constant-time compare).

## Decision card format

```
PROJECT_NAME · ~30s requested · expires in 25m

TITLE

Context:
  …max 5 lines…

A. label
   Evidence: …
   Next:     …
   Risk:     …
B. label
…
C. label
…

Agent default: B    Council prediction: A
Why this reached you:
  - urgency=now
  - council split on …
  - expected loss is high

Reply:  A / B / C / override: <text> / skip
```

## Architecture

- **Single Node process**, no external services, JSON file persistence.
- **Storage**: `data/state.json` with `schema_version`. Cross-process file lock (`state.lock`, `O_EXCL` create, stale > 30s ⇒ broken). In-process write mutex serializes commits. Corruption is quarantined to `state.json.corrupt-<unix-ts>` and the store starts fresh.
- **Council**: 5 parallel `claude-haiku-4-5` calls per ask (~1.5s p95). Shared system prefix is prompt-cached → marginal cost ≈ $0.0003/ask. Strict JSON output, fallback to agent default with low confidence on parse/network error.
- **Schema validation**: every external entity goes through `src/parsers.ts` (no SDK dependency). Type errors → `400`, business-rule failures → `422` with `repair_instructions`.
- **MCP server**: `src/mcp-server.ts` (stdio transport, `@modelcontextprotocol/sdk` v1) thin-wraps the HTTP daemon. Tools validated with Zod, schemas auto-emitted as JSON Schema for Claude.

Full spec including escalation thresholds, bid formula, batching algorithm: [`specs/attention-router.md`](specs/attention-router.md).

## Development

```sh
git clone https://github.com/sderosiaux/attention-router
cd attention-router
npm install
npm test                                       # 102 tests, deterministic (mock LLM)
node --import tsx tests/proof.mjs              # end-to-end proof of the 4 round-2 fixes
ANTHROPIC_API_KEY=$THE_ANTHROPIC_API_KEY \
  npx tsx src/cli.ts start-server              # real LLM council
```

Project layout:

```
src/
  council.ts        5-persona LLM council (Claude API + prompt cache)
  llm.ts            LlmProvider interface (Anthropic / Mock)
  router.ts         bid scoring + ranking
  batching.ts       urgency buckets + top-N selection
  validation.ts     business rules (No Naked Questions)
  parsers.ts        zero-dep runtime schemas (HTTP boundary)
  storage.ts        single-file JSON store + cross-process lock
  service.ts        orchestration (ask → council → bid → store)
  server.ts         HTTP daemon (auth, body cap, content-type guard)
  cli.ts            attn … commands
  mcp-server.ts     MCP server (stdio) for Claude Code plugin
  rules.ts          JudgmentRule drafting + topic extraction
.claude-plugin/     plugin manifest
.mcp.json           MCP server declaration
hooks/              SessionStart hook
skills/ask-human/   Skill (when to invoke ask_human)
specs/              Spec source-of-truth
tests/              node:test suite + proof.mjs
```

## Status

**Alpha.** The protocol (`AgentAsk`, council, bid, batching) is stable enough for daily use. The MCP plugin is tested manually but hasn't seen wide deployment. Expect breaking changes only for documented friction; the [`specs/`](specs/) folder tracks every accepted change.

## License

MIT — see `package.json`. Free to use, fork, integrate.
