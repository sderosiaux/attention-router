# attention-router

Local attention router for parallel coding agents.

You're running several AI coding agents at once. You don't want to babysit terminals. Agents POST their *asks* here. The router:

1. **Rejects naked questions** — no options, no evidence, no default → bounced back with repair instructions.
2. **Runs a Doppelgänger Council** — 5 simulated reviewers vote. High entropy / high-loss / irreversible / low-confidence / council disagrees with default → escalate.
3. **Scores a bid** — `expected_loss × uncertainty × irreversibility × disagreement × starvation − human_seconds − interruption_penalty`.
4. **Batches** — only the top 1–3 cards reach you. Everything else auto-resolves silently or expires.
5. **Learns** — your decisions become draft `JudgmentRule`s. Accept them and the council starts citing them.

No cloud. No auth. Single Node process. JSON files on disk.

## Install

Requires Node ≥ 20.

```sh
cd attention-router
npm install
```

## Quickstart

```sh
# start the daemon
npm start
# (or)  npx tsx src/cli.ts start-server

# in another shell:
curl -sS -XPOST http://127.0.0.1:7777/asks -H 'content-type: application/json' --data-binary @examples/valid-ask.json
curl -sS -XPOST http://127.0.0.1:7777/asks -H 'content-type: application/json' --data-binary @examples/naked-ask.json

npx tsx src/cli.ts next
npx tsx src/cli.ts decide ask_demo_001 A
npx tsx src/cli.ts rules
```

See [`examples/human-flow.md`](examples/human-flow.md) for the full walkthrough.

## CLI

```
start-server                       start HTTP daemon (port 7777)
submit-ask <json-file>             submit a single ask (no server needed)
submit-jsonl <file>                submit one ask per line
next                               show the single best decision card
batch                              show top 3 cards
decide <ask_id> <A|B|C>            record decision (drafts a rule)
override <ask_id> "<text>"         record override (drafts a rule)
skip <ask_id>                      defer (status=skipped)
rules                              list rules incl. drafts
accept-rule <rule_id>              promote draft → accepted (loaded by future councils + bid)
reject-rule <rule_id>              kill a rule
edit-rule <id> <field> <value>     edit prefer|avoid|priority|when
projects                           list projects with pending counts
status                             overall counts
```

Env:
- `AR_DATA_DIR` (default `./data`), `AR_PORT` (7777), `AR_HOST` (127.0.0.1)
- `AR_MAX_BODY_BYTES` (1 MiB)
- `AR_INTERRUPTION_PENALTY` (5), `AR_SHOW_THRESHOLD` (20)
- `AR_ESCALATE_HIGH_ENTROPY` (1.0), `AR_ESCALATE_HIGH_LOSS` (100), `AR_ESCALATE_LOW_CONFIDENCE` (0.5)

## HTTP

| Route | Body | Notes |
|---|---|---|
| `POST /asks` | `AgentAsk` JSON | `202` accepted, `422` naked (with repair_instructions), `400` schema/JSON, `413` too large, `415` wrong content-type |
| `POST /asks/jsonl` | one ask per line | per-line result; bad lines reported, others succeed |
| `GET  /next?max=3` | — | clamped to `[1,3]` |
| `POST /decisions` | `HumanDecision` JSON | `404` unknown ask, `409` not pending, `400` bad choice |
| `POST /skip` | `{"id":"ask_…"}` | `404` unknown |
| `GET  /rules` | — | |
| `POST /rules/accept` | `{"id":"rule_…"}` | |
| `POST /rules/reject` | `{"id":"rule_…"}` | |
| `POST /rules/edit` | `{"id","field","value"}` | field ∈ prefer / avoid / priority / when |
| `GET  /projects` | — | |
| `GET  /status` | — | counters |
| `GET  /healthz` | — | |

All `POST` endpoints require `content-type: application/json`. Bodies > `AR_MAX_BODY_BYTES` → `413`.

## Data model

See `src/types.ts`. Storage is a single JSON file under `./data/state.json` with `schema_version`. Cross-process saves are protected by `data/state.lock` (stale > 30s ⇒ broken automatically). Corrupted state is quarantined to `state.json.corrupt-<unix-ts>` and the store starts fresh.

## Tests

```sh
npm test
```

Covers: naked-question rejection, valid acceptance, council vote generation, entropy, bid scoring, batching order, judgment-rule drafting, expiration.

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

Agent default: B
Council prediction: A
Why this reached you:
  - council split on X
  - expected loss is high
  - confidence is low

Reply:  A / B / C / override: <text> / skip
```

## Use as a Claude Code plugin

This repo is also a Claude Code plugin. Install it from the marketplace:

```
/plugin marketplace add sderosiaux/claude-plugins
/plugin install attention-router
```

Or locally before publishing:

```
/plugin marketplace add /path/to/this/repo
/plugin install attention-router
```

The plugin ships:
- An MCP server exposing `ask_human`, `wait_for_decision`, `get_pending` tools
- A `ask-human` skill that teaches Claude when to invoke `ask_human`
- A `SessionStart` hook that lazy-launches the daemon on `127.0.0.1:7777`

See [PLUGIN-INSTALL.md](PLUGIN-INSTALL.md) for full details.

## Connecting agents

### From Claude Code (or any terminal agent)

Agents only need to POST an `AgentAsk`:

```ts
await fetch("http://127.0.0.1:7777/asks", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(ask),
});
```

You can wire this into a Claude Code **Stop hook** or **PreToolUse hook** so the agent escalates only through the router rather than printing to a terminal you'll never read. Suggested flow:

- Agent reaches a fork → constructs an `AgentAsk` (3 options + evidence + default + cost-if-wrong) → POSTs it.
- If response is `rejected`, the agent reads `repair_instructions` and tries again — *no human paged*.
- If `auto_resolved`, the agent uses `default_option_id` (the council was confident enough).
- If `queued`, the agent blocks/polls `/next` or simply parks the work and waits for `/decisions` to arrive (use `ask_id` as the join key).

### From shell agents (no HTTP)

```sh
echo "$ASK_JSON" > /tmp/ask.json
npx tsx src/cli.ts submit-ask /tmp/ask.json
```

Same outcome, no daemon needed (each invocation reads/writes the JSON store).

## Out of scope (v1)

- Big dashboard UI.
- Rollback-first autonomy (agent runs both branches and you pick post-hoc).
- Deep Claude Code integration (hooks, SDK callbacks, IDE surfaces).

The point is to get the **router protocol** right first. UIs and integrations layer on top later.
