# Installing attention-router as a Claude Code plugin

## Option 1 — via the marketplace (recommended)

Add this entry to `.claude-plugin/marketplace.json` in `sderosiaux/claude-plugins`:

```json
{
  "name": "attention-router",
  "source": {
    "source": "github",
    "repo": "sderosiaux/attention-router"
  },
  "description": "Triage AI coding agents' questions. 5-persona LLM council auto-resolves what's safe, surfaces only the highest-value decisions to you.",
  "version": "0.1.0",
  "category": "productivity",
  "tags": ["agent", "decision", "council", "router", "llm", "triage", "attention", "no-naked-questions"]
}
```

Then in any Claude Code session:

```
/plugin marketplace add sderosiaux/claude-plugins   # if not already added
/plugin install attention-router@sderosiaux-claude-plugins
```

## Option 2 — local, before publishing

In Claude Code, install directly from your local clone:

```
/plugin marketplace add /Users/sderosiaux/code/personal/attention-router
/plugin install attention-router
```

Or symlink into `~/.claude/plugins/` if you prefer the manual path.

## What gets installed

The plugin ships:

| File | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin metadata |
| `.mcp.json` | Declares the `attention-router` MCP server (stdio transport, `node bin/attn-mcp.mjs`) |
| `skills/ask-human/SKILL.md` | Tells Claude WHEN to invoke the `ask_human` MCP tool |
| `hooks/hooks.json` + `scripts/ensure-daemon.sh` | SessionStart hook: lazy-launches the HTTP daemon on `127.0.0.1:7777` if not already running |
| `bin/attn-mcp.mjs` | MCP server entry point (wraps `src/mcp-server.ts` via tsx) |
| `bin/attn.mjs` | CLI for the human side (`next`, `decide`, `status`, …) |

## Prerequisites

- Node ≥ 20 in `PATH`.
- A Claude API key as `THE_ANTHROPIC_API_KEY` (Claude Code stomps on `ANTHROPIC_API_KEY=dummy` so the daemon's hook reads `THE_ANTHROPIC_API_KEY` first). Without a key, the council falls back to MockProvider.
- First run installs `tsx` lazily via `npx -y tsx` — give it a few seconds on session 1.

## How the human sees pending cards

The plugin doesn't pop a UI. You watch the queue in one terminal:

```sh
watch -n 5 attn batch
```

If `attn` is not on your PATH (the plugin install doesn't auto-link it), add an alias once:

```sh
echo 'alias attn="npx -y tsx ~/.claude/plugins/attention-router/src/cli.ts"' >> ~/.zshrc
# or `npm install -g .` from a clone of the repo
```

Or one-shot:

```sh
attn next                          # top card
attn decide ask_xxx A              # take option A
attn override ask_xxx "use mTLS"   # override with text
attn skip ask_xxx                  # defer (re-surfaces after cooldown)
attn status                        # global counters
```

## How a Claude Code agent sees the tools

Once installed, Claude has three new tools (and the `ask-human` skill teaches it when to use them):

- `ask_human({dilemma, context, project_id})` — submit a fork, get back `auto_resolved` or `queued`
- `wait_for_decision({ask_id})` — block until the human answers
- `get_pending({project_id?})` — introspect the queue

## Configuration env vars

| Var | Default | Effect |
|---|---|---|
| `THE_ANTHROPIC_API_KEY` | — | Real Anthropic key for the council (preferred over `ANTHROPIC_API_KEY` because Claude Code overrides the latter) |
| `AR_LLM_MODEL` | `claude-haiku-4-5` | Model used by the 5 council personas |
| `AR_PORT` / `AR_HOST` | 7777 / 127.0.0.1 | Daemon bind |
| `AR_DATA_DIR` | `~/.attention-router/data` | Where `state.json` lives (in plugin context) |
| `AR_CALLBACK_ALLOWED_HOSTS` | empty (all blocked) | Allowlist for `callback_url` (SSRF guard) |
| `AR_AUTH_TOKEN` | — | If set, all HTTP requests need `Authorization: Bearer …` |
| `AR_SKIP_COOLDOWN_SEC` | 1800 | Delay before a skipped ask re-surfaces |
| `AR_ESCALATE_HIGH_LOSS` | 100 | Escalation threshold for `expected_loss_if_wrong` |

## Publishing checklist (for sderosiaux)

1. `git init` in `attention-router/` (it's not a repo yet) and push to `github.com/sderosiaux/attention-router`.
2. Tag `v0.1.0`.
3. Add the marketplace entry above to `sderosiaux/claude-plugins`.
4. Test locally first: `/plugin marketplace add /path/to/local/clone` then `/plugin install attention-router`.
5. Once green, push the marketplace.json change.
