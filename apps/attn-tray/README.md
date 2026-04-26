# AttnTray

A floating macOS window that pops up when `attention-router` queues a new card and lets you decide with one click.

## What you get

- **Floating window** above all your other apps when a card escalates
- **Big A/B/C buttons** with each option's label, next-step, and risk in plain view
- **Tags** showing which option is the agent default and which is the council pick
- **Keyboard**: press `A`/`B`/`C` to decide, `⌘O` for override, `⌘S` to skip
- **No Dock icon** (runs as accessory app); window dismisses on click
- Polls the daemon every 5s (configurable), seeds with current pending so it doesn't re-pop existing cards

## Requirements

- macOS 13+
- Swift toolchain (`xcode-select --install` is enough — no full Xcode needed)
- The attention-router daemon running on `127.0.0.1:7777` (the plugin's SessionStart hook handles that)

## Run

From the plugin install path:

```sh
cd ~/.claude/plugins/cache/sderosiaux-claude-plugins/attention-router/<latest>/apps/attn-tray
swift run
```

First run takes ~30s to compile; subsequent runs start in <2s thanks to swift's build cache. Leave it in a terminal in the background, or detach with `&`.

Or via the CLI:

```sh
attn tray
```

## Env vars

| Var | Default | Effect |
|---|---|---|
| `AR_ROUTER_URL` | `http://127.0.0.1:7777` | Daemon base URL |
| `AR_HOST` / `AR_PORT` | 127.0.0.1 / 7777 | Used if `AR_ROUTER_URL` not set |
| `AR_AUTH_TOKEN` | — | Sent as `Authorization: Bearer <token>` if set |
| `AR_TRAY_INTERVAL_SEC` | `5` | Polling interval |

## How it differs from `attn watch`

| | `attn watch` | `attn tray` |
|---|---|---|
| UX | passive macOS notification | foreground floating window |
| Action from notification | none — must open terminal, copy ask_id, type `attn decide …` | one click on the option button |
| OS | any (macOS+others via osascript) | macOS only |
| Dependencies | none beyond Node | Swift toolchain |

Use `attn watch` if you want low-friction passive nudges. Use `attn tray` when you want decision speed.
