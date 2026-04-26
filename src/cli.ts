import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { Store } from "./storage.ts";
import { Service, DecisionError } from "./service.ts";
import { startServer } from "./server.ts";
import { formatCard } from "./card.ts";
import { parseAgentAsk, parseHumanDecision, SchemaError } from "./parsers.ts";
import type { HumanDecision, OptionId } from "./types.ts";

const DATA_DIR =
  process.env.AR_DATA_DIR ?? path.resolve(process.cwd(), "data");
const PORT = Number(process.env.AR_PORT ?? 7777);
const HOST = process.env.AR_HOST ?? "127.0.0.1";

async function makeService(): Promise<Service> {
  const store = new Store(DATA_DIR);
  await store.load();
  return new Service(store);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return printHelp();

  switch (cmd) {
    case "start-server": {
      const svc = await makeService();
      startServer({ service: svc, port: PORT, host: HOST });
      return; // keep process alive
    }
    case "submit-ask": {
      const file = args[0];
      if (!file) return die("usage: submit-ask <json-file>");
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      try {
        const ask = parseAgentAsk(raw, { fill_defaults: true });
        const svc = await makeService();
        const out = await svc.submitAsk(ask);
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        if (e instanceof SchemaError) return die(`schema error: ${e.message}`);
        throw e;
      }
      return;
    }
    case "smart-ask": {
      const file = args[0];
      if (!file) return die("usage: smart-ask <json-file>  (json: {project_id, project_name, dilemma, context, ...})");
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
        project_id: string;
        project_name: string;
        project_type?: "game" | "software" | "other";
        verification_surface?: "visual" | "business_rule" | "mixed" | "text";
        dilemma: string;
        context: string;
        requested_human_seconds?: number;
        expires_in_seconds?: number;
        callback_url?: string;
      };
      const svc = await makeService();
      try {
        const out = await svc.structureAndSubmit(raw);
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        if (e instanceof SchemaError) return die(`schema error: ${e.message}`);
        throw e;
      }
      return;
    }
    case "submit-jsonl": {
      const file = args[0];
      if (!file) return die("usage: submit-jsonl <file>");
      const lines = (await fs.readFile(file, "utf8"))
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      const svc = await makeService();
      const results: unknown[] = [];
      for (const [i, line] of lines.entries()) {
        try {
          const ask = parseAgentAsk(JSON.parse(line), { fill_defaults: true });
          results.push(await svc.submitAsk(ask));
        } catch (e) {
          if (e instanceof SchemaError || e instanceof SyntaxError) {
            results.push({ status: "error", line: i + 1, error: (e as Error).message });
          } else throw e;
        }
      }
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }
    case "tray": {
      // Spawn the SwiftUI floating-decision app from apps/attn-tray.
      // Resolves the swift project relative to this CLI file (works for both
      // dev clone AND the plugin install path).
      const here = path.dirname(new URL(import.meta.url).pathname);
      const swiftDir = path.resolve(here, "..", "apps", "attn-tray");
      try {
        await fs.access(path.join(swiftDir, "Package.swift"));
      } catch {
        return die(`attn-tray sources not found at ${swiftDir}\nReinstall the plugin or check your repo layout.`);
      }
      console.log(`[attn tray] launching SwiftUI app from ${swiftDir}`);
      console.log(`[attn tray] first run compiles for ~30s; subsequent runs <2s`);
      const swift = spawn("swift", ["run", "--package-path", swiftDir, "AttnTray"], {
        stdio: "inherit",
      });
      swift.on("error", (e) => {
        die(`failed to spawn swift: ${e.message}\nInstall Swift toolchain: xcode-select --install`);
      });
      // Keep this process alive until swift exits
      await new Promise<void>((res) => swift.on("exit", () => res()));
      return;
    }
    case "watch": {
      const intervalSec = Number(args[0] ?? process.env.AR_WATCH_INTERVAL_SEC ?? 5);
      if (!Number.isFinite(intervalSec) || intervalSec < 1) return die("usage: watch [interval_sec]");
      console.log(`[attn watch] polling every ${intervalSec}s; ctrl-C to quit`);
      const seen = new Set<string>();
      // Seed with currently-pending so we don't notify on existing cards at startup
      try {
        const svc = await makeService();
        for (const r of svc.listPending()) seen.add(r.ask.id);
      } catch (e) {
        console.error(`[attn watch] could not read state: ${(e as Error).message}`);
      }
      while (true) {
        try {
          const svc = await makeService();
          for (const r of svc.listPending()) {
            if (seen.has(r.ask.id)) continue;
            seen.add(r.ask.id);
            await notify({
              title: `attention-router · ${r.ask.project_name}`,
              subtitle: r.ask.title.slice(0, 80),
              body: `ask_id=${r.ask.id} · urgency=${r.urgency ?? "?"} · default=${r.ask.default_option_id}`,
            });
            console.log(`[attn watch] notified: ${r.ask.id} — ${r.ask.title.slice(0, 60)}`);
          }
        } catch (e) {
          console.error(`[attn watch] poll error: ${(e as Error).message}`);
        }
        await new Promise((res) => setTimeout(res, intervalSec * 1000));
      }
    }
    case "next": {
      const svc = await makeService();
      const batch = await svc.nextBatch(1);
      if (batch.length === 0) {
        console.log("No cards waiting. Inbox zero.");
        return;
      }
      console.log(formatCard(batch[0]!));
      return;
    }
    case "batch": {
      const svc = await makeService();
      const batch = await svc.nextBatch(3);
      if (batch.length === 0) {
        console.log("No cards waiting.");
        return;
      }
      for (const r of batch) {
        console.log(formatCard(r));
        console.log("\n" + "─".repeat(60) + "\n");
      }
      return;
    }
    case "decide": {
      const [askId, choice] = args;
      if (!askId || !choice) return die("usage: decide <ask_id> <A|B|C>");
      if (!["A", "B", "C"].includes(choice)) return die("choice must be A|B|C");
      try {
        const dec = parseHumanDecision({
          ask_id: askId,
          choice: choice as OptionId,
          create_rule: true,
        });
        const svc = await makeService();
        const out = await svc.decide(dec);
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        return handleDecisionError(e);
      }
      return;
    }
    case "override": {
      const [askId, ...textParts] = args;
      const text = textParts.join(" ");
      if (!askId || !text) return die('usage: override <ask_id> "<text>"');
      try {
        const dec: HumanDecision = parseHumanDecision({
          ask_id: askId,
          choice: "override",
          override_text: text,
          create_rule: true,
        });
        const svc = await makeService();
        const out = await svc.decide(dec);
        console.log(JSON.stringify(out, null, 2));
      } catch (e) {
        return handleDecisionError(e);
      }
      return;
    }
    case "skip": {
      const askId = args[0];
      if (!askId) return die("usage: skip <ask_id>");
      const svc = await makeService();
      const r = await svc.skip(askId);
      if (!r) return die(`ask not found: ${askId}`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "rules": {
      const svc = await makeService();
      console.log(JSON.stringify(svc.listRules(), null, 2));
      return;
    }
    case "accept-rule": {
      const id = args[0];
      if (!id) return die("usage: accept-rule <rule_id>");
      const svc = await makeService();
      const r = await svc.setRuleStatus(id, "accepted");
      if (!r) return die(`rule not found: ${id}`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "reject-rule": {
      const id = args[0];
      if (!id) return die("usage: reject-rule <rule_id>");
      const svc = await makeService();
      const r = await svc.setRuleStatus(id, "rejected");
      if (!r) return die(`rule not found: ${id}`);
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    case "edit-rule": {
      const [id, field, ...valueParts] = args;
      const value = valueParts.join(" ");
      if (!id || !field || !value) return die("usage: edit-rule <rule_id> <prefer|avoid|priority|when> <value>");
      if (!["prefer", "avoid", "priority", "when"].includes(field)) {
        return die("field must be prefer|avoid|priority|when");
      }
      try {
        const svc = await makeService();
        const v = field === "priority" ? Number(value) : value;
        if (field === "priority" && !Number.isFinite(v)) return die("priority must be a number");
        const r = await svc.editRule(id, field as "prefer" | "avoid" | "priority" | "when", v);
        if (!r) return die(`rule not found: ${id}`);
        console.log(JSON.stringify(r, null, 2));
      } catch (e) {
        if (e instanceof DecisionError) return die(e.message);
        throw e;
      }
      return;
    }
    case "projects": {
      const svc = await makeService();
      console.log(JSON.stringify(svc.listProjects(), null, 2));
      return;
    }
    case "status": {
      const svc = await makeService();
      console.log(JSON.stringify(svc.status(), null, 2));
      return;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
}

function handleDecisionError(e: unknown): never {
  if (e instanceof SchemaError) die(`schema error: ${e.message}`);
  if (e instanceof DecisionError) die(e.message);
  throw e;
}

function printHelp(): void {
  console.log(`attention-router CLI

Commands:
  start-server                       start HTTP daemon (port ${PORT})
  submit-ask <json-file>             submit a single ask
  submit-jsonl <file>                submit one ask per line (JSONL)
  next                               show top decision card
  batch                              show top 3 cards
  watch [interval_sec]               poll daemon, fire macOS notification on each new pending card
  tray                               launch the SwiftUI floating-decision UI (macOS, requires Swift)
  decide <ask_id> <A|B|C>            record human decision
  override <ask_id> "<text>"         record override
  skip <ask_id>                      defer (status=skipped)
  rules                              list rules (incl. drafts)
  accept-rule <rule_id>              accept a rule draft
  reject-rule <rule_id>              reject a rule
  edit-rule <rule_id> <field> <val>  edit prefer|avoid|priority|when
  projects                           list projects with pending counts
  status                             overall counts

Env:
  AR_DATA_DIR (default ./data)
  AR_PORT     (default 7777)
  AR_HOST     (default 127.0.0.1)
  AR_MAX_BODY_BYTES (default 1048576)
  AR_INTERRUPTION_PENALTY (default 5)
  AR_SHOW_THRESHOLD (default 20)
  AR_ESCALATE_HIGH_ENTROPY (default 1.0)
  AR_ESCALATE_HIGH_LOSS (default 100)
  AR_ESCALATE_LOW_CONFIDENCE (default 0.5)
`);
}

/**
 * Native macOS notification via osascript. Silently no-ops on non-darwin
 * (or falls back to terminal-notifier if the user has it installed).
 * AppleScript strings escape backslash and double-quote.
 */
function escAS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function notify(opts: { title: string; subtitle?: string; body: string }): Promise<void> {
  if (process.platform !== "darwin") {
    console.log(`[notify] ${opts.title} :: ${opts.body}`);
    return Promise.resolve();
  }
  const args = [
    "-e",
    `display notification "${escAS(opts.body)}" with title "${escAS(opts.title)}"${
      opts.subtitle ? ` subtitle "${escAS(opts.subtitle)}"` : ""
    }`,
  ];
  return new Promise((res) => {
    const p = spawn("osascript", args, { stdio: "ignore" });
    p.on("exit", () => res());
    p.on("error", () => res());
  });
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
