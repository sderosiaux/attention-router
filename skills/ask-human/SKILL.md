---
name: ask-human
description: Use when you reach a decision fork that you cannot resolve confidently from context alone — irreversible operations (migrations, force-pushes, deletions), architectural choices with several defensible answers, or ambiguous requirements where guessing wrong would cost real time. Sends a structured ask to the local attention-router via the `ask_human` MCP tool. The router LLM drafts 3 options from your dilemma + context, runs a 5-persona council, and either auto-resolves silently or queues for the human. Do NOT use for trivial choices, lookups answerable from documentation, or anything you can verify by reading more code or running a test.
---

# ask-human

When you hit a decision fork:

## 1. Decide if you should ask

You should ask when **all** of these are true:
- The choice is **non-trivial** (not naming a variable; not formatting).
- You have **multiple defensible options** and the evidence doesn't clearly pick one.
- Guessing wrong has a **real cost** (rework, data loss, incident, deploy churn).
- You **cannot resolve it** by reading more code, checking docs, or running a test.

You should NOT ask when:
- You can answer it yourself with one more `Read` / `Grep` / `Bash` call.
- It's a stylistic micro-choice the human would not care about.
- The "default" is overwhelmingly safer (e.g. always read before edit).

If in doubt, lean toward NOT asking — the router will reject naked asks anyway, and an ignored question is worse than no question.

## 2. Frame the dilemma

Before invoking the tool, write down in your head:
- **The actual tension** in 1-2 sentences. NOT "what should I do" — describe the trade-off concretely.
  - Bad: *"How should I handle this migration?"*
  - Good: *"Backfill 50M-row table inline in the migration vs. background job — lock contention vs. schema drift if the job lags."*
- **The context** the human needs to decide: relevant file paths, observations, what you've already ruled out, scale/risk numbers if you have them.

## 3. Invoke the MCP tool

Call `ask_human` (provided by the `attention-router` MCP server):

```
ask_human({
  dilemma: "<the tension in 1-2 sentences>",
  context: "<concrete facts: paths, observations, ruled-out alternatives, ~500-2000 chars>",
  project_id: "<repo or project name — used for rule scoping>",
  // optional:
  // verification_surface: "business_rule" | "visual" | "mixed" | "text",
  // requested_human_seconds: 30,
  // expires_in_seconds: 3600
})
```

The router's LLM drafts 3 distinct options from your dilemma + context — you do **not** need to pre-build them.

## 4. Handle the response

`ask_human` does a **short poll (~30s)** then returns:
- If the council auto-resolves OR the human responds in those 30s → tool returns the decision and you proceed.
- If still pending after 30s → tool returns `queued`. **You don't need to wait inside the tool.** Continue the rest of your task. When you finish your turn, the plugin's Stop hook (`asyncRewake`) waits in the background for the human's decision and wakes you with the resolution as a system-reminder — even hours later. No manual `wait_for_decision` call needed in the typical path.

Three possible outcomes:

- **`auto_resolved`** — the council was unanimous and the impact is low. The tool returns `safe_default_option_id` (A, B, or C). **Proceed silently** with that option. The human was not notified. Do not announce "I asked the router" — just continue the task.

- **`decided` / `expired` / `skipped`** — the human responded (or didn't in time). The tool returns the choice (A|B|C or override text), or tells you the ask aged out / was deferred. Apply the choice and continue. If `expired`, fall back to the agent's original `default_option_id`.

- **`timeout`** — 4 hours elapsed without a human decision. The tool returns the `ask_id` so you can call `wait_for_decision({ask_id})` to keep waiting, or proceed with the agent default if the work is unblocked.

- **error / rejected** — the router rejected the ask as too vague. The tool tells you what's missing (longer dilemma, more concrete context). Fix and retry **once**. If still rejected, fall back to direct conversation with the user.

For explicit fire-and-forget (rare), pass `wait: false`. You'll then need to call `wait_for_decision({ask_id})` later.

## 5. Anti-patterns to avoid

- ❌ Asking the same dilemma twice in a row. If the first ask was rejected with repair instructions, you must address those instructions.
- ❌ Pasting the whole codebase as context. ~500-2000 chars is right — distill the load-bearing facts.
- ❌ Asking for permission to do things the user already greenlit ("can I write the file you asked me to write?").
- ❌ Inventing options the router didn't return. The tool's response IS the choice set.
- ❌ Using `wait_for_decision` in a tight loop. The tool already polls — call it once.

## 6. Example

You're refactoring `src/payment.ts` and find the existing API uses callbacks while the rest of the codebase has migrated to async/await. Migrating it touches 12 files. Skipping it leaves a stylistic split. Both are defensible.

```
ask_human({
  dilemma: "Migrate payment.ts to async/await (12-file blast radius) vs. leave callbacks for now and document the split — consistency vs. scope creep on a payment module.",
  context: "src/payment.ts uses node-style callbacks (err, data) => . The rest of src/ is async/await since commit a3f12b4 (3 months ago). The payment module hasn't changed in 14 months. Tests cover the public API but not internals. The original task was 'add Apple Pay support' — payment.ts callback style is incidental to that.",
  project_id: "billing-api"
})
```

If the impact is low and the council agrees, the router will likely auto_resolve to "leave callbacks, document the split" and you proceed. If the council splits or the loss-if-wrong is high, you wait for the human.
