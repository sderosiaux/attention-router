import type { AskRecord } from "./types.ts";

export function formatCard(rec: AskRecord, now: Date = new Date()): string {
  const { ask, council, bid } = rec;
  const remaining = Math.max(
    0,
    Math.floor(
      (new Date(ask.created_at).getTime() + ask.expires_in_seconds * 1000 - now.getTime()) / 1000,
    ),
  );

  const head = `[${ask.id}]  ${ask.project_name} · ~${ask.requested_human_seconds}s requested · expires in ${formatSec(remaining)}`;
  const lines: string[] = [head, "", ask.title.toUpperCase(), "", "Context:"];
  for (const l of clip(ask.context, 5)) lines.push(`  ${l}`);

  for (const opt of ask.options) {
    lines.push("");
    lines.push(`${opt.id}. ${opt.label}`);
    lines.push("Evidence:");
    for (const e of opt.evidence) lines.push(`  - ${e}`);
    lines.push("Next:");
    lines.push(`  - ${opt.predicted_next_step}`);
    lines.push("Risk:");
    lines.push(`  - ${opt.cost_if_wrong}`);
  }

  lines.push("");
  lines.push(`Agent default: ${ask.default_option_id}`);
  if (council) lines.push(`Council prediction: ${council.predicted_human_choice}`);
  lines.push("Why this reached you:");
  if (rec.urgency) lines.push(`  - urgency=${rec.urgency}`);
  if (bid) {
    for (const r of (bid.reason || "low-impact").split(";").map((s) => s.trim()).filter(Boolean)) {
      lines.push(`  - ${r}`);
    }
  }
  if (council && council.entropy >= 1.0) {
    lines.push(`  - council split on ${council.disagreement_axis} (entropy=${council.entropy})`);
  } else if (council && council.disagreement_axis !== "unanimous") {
    lines.push(`  - ${council.disagreement_axis}`);
  }
  if (rec.status === "stale") lines.push("  - past TTL (stale, kept because high-risk)");

  lines.push("");
  lines.push("Reply (run in your shell):");
  lines.push(`  attn decide ${ask.id} A`);
  lines.push(`  attn decide ${ask.id} B`);
  lines.push(`  attn decide ${ask.id} C`);
  lines.push(`  attn override ${ask.id} "<your text>"`);
  lines.push(`  attn skip ${ask.id}`);
  return lines.join("\n");
}

function clip(s: string, maxLines: number): string[] {
  const lines = s.split("\n").slice(0, maxLines);
  return lines.map((l) => (l.length > 100 ? l.slice(0, 100) + "…" : l));
}

function formatSec(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
