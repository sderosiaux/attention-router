/**
 * MCP server for attention-router.
 * Wraps the local HTTP daemon (127.0.0.1:7777 by default).
 *
 * Tools exposed to Claude Code:
 *   - ask_human(dilemma, context, ...)   → smart-ask via /asks/structure
 *   - wait_for_decision(ask_id, ...)     → polls /next until decision lands
 *   - get_pending(project_id?)           → lists pending asks the human hasn't seen
 *
 * Transport: stdio (Claude Code spawns the process per session).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import process from "node:process";

const ROUTER_BASE =
  process.env.AR_ROUTER_URL ?? `http://${process.env.AR_HOST ?? "127.0.0.1"}:${process.env.AR_PORT ?? 7777}`;
const AUTH_TOKEN = process.env.AR_AUTH_TOKEN;

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN ? { authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

async function routerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${ROUTER_BASE}${path}`;
  const headers = {
    "content-type": "application/json",
    ...authHeaders(),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(url, { ...init, headers });
}

const server = new McpServer(
  { name: "attention-router", version: "0.1.0" },
  {
    instructions: `attention-router collects "asks" from coding agents and surfaces only the highest-value ones to the human.

WHEN TO USE ask_human:
- You hit a decision fork that you cannot resolve confidently from context alone.
- The decision is irreversible, costly, or has multiple defensible answers.
- You are about to do something the human would regret if you got it wrong.

WHEN NOT TO USE:
- Trivial choices (variable names, formatting).
- Anything you can verify by reading more code or running a test.
- Lookups answerable from documentation.

The router will:
- Reject naked questions (no options, vague title) — fix what it tells you to fix and retry.
- Auto-resolve safe decisions silently — proceed with the returned safe_default_option_id.
- Queue genuine forks for the human — call wait_for_decision(ask_id) to receive A|B|C or override text.

PREREQ: the attention-router daemon must be running on ${ROUTER_BASE}. The plugin's SessionStart hook should auto-start it.`,
  },
);

// ──────────────────────────────────────────────────────────────────────
// Tool: ask_human
// ──────────────────────────────────────────────────────────────────────
server.tool(
  "ask_human",
  "Submit a decision to the local attention-router. The router LLM drafts 3 options from your dilemma+context, runs a council, and either auto-resolves or queues for the human. You only need to provide the dilemma and context — the router builds the structured ask for you.",
  {
    dilemma: z
      .string()
      .min(20)
      .describe(
        "The decision in 1-2 sentences. Describe the actual tension, NOT a vague 'what should I do'. Example: 'Backfill 50M-row table inline in migration vs. background job — lock contention vs. schema drift risk.'",
      ),
    context: z
      .string()
      .min(20)
      .describe(
        "Concrete facts the human needs to decide. File paths, observations, what you already ruled out. Up to ~2000 chars.",
      ),
    project_id: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Stable identifier for the project/repo. Use the repo name (e.g. 'billing-api'). Used for rule scoping and starvation tracking.",
      ),
    project_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Human-readable project name. Defaults to project_id."),
    project_type: z
      .enum(["software", "game", "other"])
      .optional()
      .describe("Defaults to 'software'."),
    verification_surface: z
      .enum(["visual", "business_rule", "mixed", "text"])
      .optional()
      .describe("How the outcome will be verified. Defaults to 'business_rule'."),
    requested_human_seconds: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How long you estimate the human needs. Defaults to 30. Higher values reduce bid score (interrupt cost)."),
    expires_in_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("TTL on the ask. Defaults to 3600 (1h)."),
  },
  async (input) => {
    const body = {
      project_id: input.project_id,
      project_name: input.project_name ?? input.project_id,
      project_type: input.project_type ?? "software",
      verification_surface: input.verification_surface ?? "business_rule",
      dilemma: input.dilemma,
      context: input.context,
      requested_human_seconds: input.requested_human_seconds,
      expires_in_seconds: input.expires_in_seconds,
    };

    let resp: Response;
    try {
      resp = await routerFetch("/asks/structure", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      return errorContent(
        `attention-router daemon unreachable at ${ROUTER_BASE} (${(e as Error).message}). Start it: \`npx tsx ~/code/personal/attention-router/src/cli.ts start-server\``,
      );
    }

    const out = (await resp.json()) as any;
    if (resp.status === 422) {
      return errorContent(
        `Router rejected the ask: ${out.rejected?.reason}. Repair instructions:\n- ${(out.rejected?.repair_instructions ?? []).join("\n- ")}`,
      );
    }
    if (!resp.ok) {
      return errorContent(`HTTP ${resp.status}: ${JSON.stringify(out)}`);
    }

    if (out.status === "auto_resolved") {
      return textContent(
        `auto_resolved: proceed with option ${out.safe_default_option_id}\n\nDrafted ask: ${out.drafted_ask?.title}\nCouncil predicted: ${out.council?.predicted_human_choice} (entropy=${out.council?.entropy})\nReason: low impact, council unanimous, no escalation triggers met.\n\nThe human was NOT notified. Continue with option ${out.safe_default_option_id}.`,
      );
    }

    // queued
    const optionsSummary = (out.drafted_ask?.options ?? [])
      .map(
        (o: { id: string; label: string; predicted_next_step: string }) =>
          `  ${o.id}. ${o.label} → ${o.predicted_next_step}`,
      )
      .join("\n");

    return textContent(
      `queued: ask_id=${out.ask_id}\n\n` +
        `Title: ${out.drafted_ask?.title}\n` +
        `Default: ${out.drafted_ask?.default_option_id}  Council pick: ${out.council?.predicted_human_choice}\n\n` +
        `Options:\n${optionsSummary}\n\n` +
        `Why this reached the human: ${out.bid?.reason}\n\n` +
        `Next: call wait_for_decision({ask_id: "${out.ask_id}"}) to block until the human answers, ` +
        `or proceed on something else and check back. The human sees this card via \`ar next\` (or your watcher).`,
    );
  },
);

// ──────────────────────────────────────────────────────────────────────
// Tool: wait_for_decision
// ──────────────────────────────────────────────────────────────────────
server.tool(
  "wait_for_decision",
  "Poll the router until the human decides on a queued ask. Returns the choice (A|B|C) or override text. Times out gracefully — call again to keep waiting.",
  {
    ask_id: z.string().min(1).describe("The ask_id returned by ask_human."),
    poll_interval_sec: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("How often to poll. Defaults to 5."),
    max_wait_sec: z
      .number()
      .int()
      .min(5)
      .max(900)
      .optional()
      .describe("Hard timeout. Defaults to 300 (5min). After timeout, call again to keep waiting."),
  },
  async ({ ask_id, poll_interval_sec, max_wait_sec }) => {
    const intervalMs = (poll_interval_sec ?? 5) * 1000;
    const deadlineMs = Date.now() + (max_wait_sec ?? 300) * 1000;

    while (Date.now() < deadlineMs) {
      let batch: { ask: { id: string }; status: string; decision?: { choice: string; override_text?: string } }[];
      try {
        const r = await routerFetch(`/next?max=99`);
        const out = (await r.json()) as any;
        batch = out.batch ?? [];
      } catch (e) {
        return errorContent(`router unreachable: ${(e as Error).message}`);
      }

      const rec = batch.find((b) => b.ask.id === ask_id);

      if (!rec) {
        // Not in pending batch — might be auto_resolved/decided already. Inspect directly.
        // Easiest: check status counters; for now report not found and return.
        return textContent(
          `ask_id=${ask_id} not in current pending batch. It may have been auto_resolved before this wait started, or already decided. Check the daemon's state directly via the CLI: \`ar status\`.`,
        );
      }

      if (rec.decision) {
        const c = rec.decision;
        const value = c.choice === "override" ? `override: ${c.override_text}` : c.choice;
        return textContent(
          `decided: ${value}\n\nask_id=${ask_id}\nApply this choice and proceed.`,
        );
      }

      if (rec.status === "expired") {
        return textContent(
          `expired: ask_id=${ask_id} aged out before the human responded. Either proceed with the agent default or re-submit with a tighter expires_in_seconds.`,
        );
      }
      if (rec.status === "skipped") {
        return textContent(
          `skipped: the human deferred this ask. It will re-surface after AR_SKIP_COOLDOWN_SEC (default 1800s) if score still warrants. Decide whether to wait or use the default.`,
        );
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    return textContent(
      `timeout after ${max_wait_sec ?? 300}s waiting for ask_id=${ask_id}. The ask is still pending; call wait_for_decision again to keep waiting, or proceed with the agent default if the work is unblocked.`,
    );
  },
);

// ──────────────────────────────────────────────────────────────────────
// Tool: get_pending
// ──────────────────────────────────────────────────────────────────────
server.tool(
  "get_pending",
  "List asks currently pending human review (optionally filtered by project_id). Use this to introspect the router state, NOT as a polling primitive (use wait_for_decision for that).",
  {
    project_id: z
      .string()
      .optional()
      .describe("If provided, only list asks for this project."),
  },
  async ({ project_id }) => {
    let batch: { ask: { id: string; title: string; project_id: string }; urgency?: string; bid?: { score: number } }[];
    try {
      const r = await routerFetch(`/next?max=99`);
      const out = (await r.json()) as any;
      batch = out.batch ?? [];
    } catch (e) {
      return errorContent(`router unreachable: ${(e as Error).message}`);
    }
    const filtered = project_id
      ? batch.filter((r) => r.ask.project_id === project_id)
      : batch;
    if (filtered.length === 0) {
      return textContent("Inbox zero. No pending asks.");
    }
    const lines = filtered.map(
      (r) =>
        `- ${r.ask.id} [${r.urgency ?? "?"}, score=${r.bid?.score ?? "?"}] ${r.ask.project_id} :: ${r.ask.title}`,
    );
    return textContent(`Pending asks (${filtered.length}):\n${lines.join("\n")}`);
  },
);

// ──────────────────────────────────────────────────────────────────────
function textContent(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}
function errorContent(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[attention-router-mcp] connected; daemon=${ROUTER_BASE}`);
