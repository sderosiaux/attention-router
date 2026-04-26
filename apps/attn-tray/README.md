# AttnTray

macOS **menubar app** for `attention-router` with two surfaces:

1. **Persistent icon in the top menubar** (📥) with a badge showing pending count.
2. **Floating window that auto-pops** above every other app the moment a new card arrives — push, not pull.

No Dock icon. Stays running until you `cmd-Q` or kill it.

## What you get

- 📥 icon in the menubar; badge `3` when 3 cards pending, `⚠` if daemon unreachable
- **Click the icon** → popover with the highest-priority card and big A/B/C buttons
- **New card arrives** → floating window pops up above everything, auto-focused
- Big buttons with each option's `label`, `→ predicted_next_step`, `⚠ cost_if_wrong`
- Tags showing `default` (agent) and `council` pick
- **Keyboard**: `A`/`B`/`C` to decide, `⌘O` override, `⌘S` skip
- Skipped → re-surfaces after `AR_SKIP_COOLDOWN_SEC` (server-side)
- Override → free-text → posted as `choice=override`
- Polls daemon every 5s (configurable); first-poll cards are not auto-popped (you don't get spammed at startup)

## Requirements

- macOS 13+
- Swift toolchain: `xcode-select --install` (~3GB CommandLineTools, no full Xcode needed)
- Daemon running on `127.0.0.1:7777` (the plugin's SessionStart hook handles that)

## Run

Via the CLI:

```sh
attn tray
```

First run compiles ~30s, then starts in <2s. The icon appears in your menubar; nothing else (no terminal output beyond Swift's build log, no Dock icon, no main window).

To detach so the terminal is free:

```sh
attn tray &
disown
```

To stop: click the icon → ⌘Q is not bound, so just `pkill -f AttnTray` or close the floating window when one's open and use Activity Monitor.

## Env vars

| Var | Default | Effect |
|---|---|---|
| `AR_ROUTER_URL` | `http://127.0.0.1:7777` | Daemon base URL |
| `AR_HOST` / `AR_PORT` | 127.0.0.1 / 7777 | Used if `AR_ROUTER_URL` not set |
| `AR_AUTH_TOKEN` | — | Sent as `Authorization: Bearer <token>` if set |
| `AR_TRAY_INTERVAL_SEC` | `5` | Polling interval |

## How push actually works

The `Poller` keeps a `seenIds` set. On the first poll after launch, it stuffs all currently-pending IDs into the set without firing — so old cards from before you started AttnTray don't pop the window. From then on, any ID it sees that wasn't in the set is "new" → fires `onNewCard` → `FloatingWindowController.show()` activates the app and orders a `level=.floating` window front-and-center on the active screen.

The floating window is `.canJoinAllSpaces` so it follows you across desktops, and `.fullScreenAuxiliary` so it appears even over fullscreen apps.

## How it differs from `attn watch`

| | `attn watch` | `attn tray` |
|---|---|---|
| Surface | passive `osascript` notification (top-right banner that fades) | floating window with click-to-decide buttons |
| Action from notif | none — must open terminal | click an option, done |
| OS | any | macOS only |
| Dependencies | none beyond Node | Swift toolchain |

`attn watch` is for "I want a soft nudge, I'll get to it." `attn tray` is for "interrupt me when something matters, let me decide in 2 seconds."
