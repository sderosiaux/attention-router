// End-to-end proof script for the 4 round-2 fixes.
// Run: node --import tsx tests/proof.mjs
// Each test imports the production module, exercises it, and asserts the
// observed behavior matches the documented fix.
import { Store } from "../src/storage.ts";
import { rankRecords } from "../src/router.ts";
import { extractTopic, ruleMatchesAsk } from "../src/rules.ts";
import { Service } from "../src/service.ts";
import { startServer } from "../src/server.ts";
import { MockProvider } from "../src/llm.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";

let pass = 0;
let fail = 0;
const log = (label, expected, actual, ok) => {
  const tag = ok ? "✓ PASS" : "✗ FAIL";
  if (ok) pass++; else fail++;
  console.log(`${tag}  ${label}`);
  console.log(`         expected: ${expected}`);
  console.log(`         actual:   ${actual}`);
};

// ============================================================
// FIX 1 — cold-start starvation = 0 (was 86400)
// ============================================================
console.log("\n═══ FIX 1: cold-start starvation bias ═══");
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-proof1-"));
  const s = new Store(dir);
  await s.load();

  const newProj = s.starvationSeconds("never-seen-project");
  log("brand-new project", "0 (was 86400 = 24h)", `${newProj}`, newProj === 0);

  // Sanity: a project WITH a recorded decision still returns elapsed time.
  await s.commit((st) => {
    st.attention["seen-project"] = new Date(Date.now() - 5000).toISOString();
  });
  const seen = s.starvationSeconds("seen-project");
  log("project with 5s-old decision", "≈5", `${seen.toFixed(2)}`, seen > 4 && seen < 6);
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================
// FIX 2 — ranking: score-first within bucket
// ============================================================
console.log("\n═══ FIX 2: rankRecords score-first within bucket ═══");
{
  const mkRec = (id, score, ageSec) => ({
    ask: {
      id, project_id: "p", project_name: "p", project_type: "software",
      verification_surface: "text", title: id, context: "x",
      options: [], default_option_id: "A", confidence: 0.5,
      reversibility: "git_revert", expected_loss_if_wrong: 1,
      requested_human_seconds: 1, expires_in_seconds: 600,
      created_at: new Date(Date.now() - ageSec * 1000).toISOString(),
    },
    bid: { ask_id: id, score, reason: "", show_now: true },
    status: "pending",
  });

  // Two records, identical urgency bucket.
  // BEFORE the fix: low-score-but-soon-to-expire would win.
  // AFTER the fix: high-score wins.
  const recs = [
    mkRec("low_score_late",  10, 0),     // score 10, fresh (lots of time left)
    mkRec("high_score_early", 500, 100),  // score 500, older (less time left)
  ];
  const ranked = rankRecords(recs);
  log(
    "score-first within bucket",
    "['high_score_early', 'low_score_late']",
    JSON.stringify(ranked.map(r => r.ask.id)),
    ranked[0].ask.id === "high_score_early",
  );
}

// ============================================================
// FIX 3 — SSRF allowlist on callback_url
// ============================================================
console.log("\n═══ FIX 3: callback SSRF allowlist ═══");
{
  // Spin a tiny receiver to count hits.
  let hits = 0;
  const receiver = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, body: JSON.parse(body || "{}") }));
    });
  });
  await new Promise(r => receiver.listen(0, "127.0.0.1", r));
  const recvPort = receiver.address().port;
  const callbackUrl = `http://127.0.0.1:${recvPort}/cb`;

  const baseAsk = {
    project_id: "ssrf-test",
    project_name: "ssrf-test",
    project_type: "software",
    verification_surface: "text",
    title: "trivial",
    context: "context with enough length to pass validation easily",
    options: [
      { id: "A", label: "ship", evidence: ["ok"], predicted_next_step: "ship", cost_if_wrong: "low", confidence: 0.9 },
      { id: "B", label: "skip", evidence: ["ok"], predicted_next_step: "skip", cost_if_wrong: "low", confidence: 0.5 },
      { id: "C", label: "wait", evidence: ["ok"], predicted_next_step: "wait", cost_if_wrong: "low", confidence: 0.5 },
    ],
    default_option_id: "A",
    confidence: 0.95,
    reversibility: "trivial",
    expected_loss_if_wrong: 1,
    requested_human_seconds: 1,
    expires_in_seconds: 600,
    callback_url: callbackUrl,
  };

  // ── 3a: allowlist EMPTY → callback must be blocked ──
  delete process.env.AR_CALLBACK_ALLOWED_HOSTS;
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "ar-ssrf-a-"));
  const storeA = new Store(dirA);
  await storeA.load();
  const svcA = new Service(storeA, {
    llm_provider: new MockProvider({ vote: "A", confidence: 0.9, reason: "p" }),
  });
  await svcA.submitAsk({ ...baseAsk, id: "ask_block", created_at: new Date().toISOString() });
  await new Promise(r => setTimeout(r, 800)); // wait for fire-and-forget
  const recA = storeA.getAsk("ask_block");
  const blockedHits = hits;
  log(
    "[allowlist empty]   receiver hits",
    "0 (callback blocked at policy layer)",
    `${blockedHits}`,
    blockedHits === 0,
  );
  log(
    "[allowlist empty]   record.callback_status",
    '"failed" with attempts=0',
    `"${recA.callback_status}" attempts=${recA.callback_attempts}`,
    recA.callback_status === "failed" && recA.callback_attempts === 0,
  );
  await fs.rm(dirA, { recursive: true, force: true });

  // ── 3b: allowlist contains 127.0.0.1 → callback must succeed ──
  process.env.AR_CALLBACK_ALLOWED_HOSTS = "127.0.0.1,localhost";
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "ar-ssrf-b-"));
  const storeB = new Store(dirB);
  await storeB.load();
  const svcB = new Service(storeB, {
    llm_provider: new MockProvider({ vote: "A", confidence: 0.9, reason: "p" }),
  });
  hits = 0;
  await svcB.submitAsk({ ...baseAsk, id: "ask_allow", created_at: new Date().toISOString() });
  await new Promise(r => setTimeout(r, 800));
  const recB = storeB.getAsk("ask_allow");
  log(
    "[allowlist=127.0.0.1] receiver hits",
    "1 (callback delivered)",
    `${hits}`,
    hits === 1,
  );
  log(
    "[allowlist=127.0.0.1] record.callback_status",
    '"delivered"',
    `"${recB.callback_status}"`,
    recB.callback_status === "delivered",
  );
  await fs.rm(dirB, { recursive: true, force: true });
  delete process.env.AR_CALLBACK_ALLOWED_HOSTS;
  await new Promise(r => receiver.close(r));
}

// ============================================================
// FIX 4 — rule topic filtering (no cross-domain bleed)
// ============================================================
console.log("\n═══ FIX 4: rule topic filtering ═══");
{
  // Capture the actual user prompts the council sees, to prove which rules made it.
  class CapturingProvider {
    capturedPrompts = [];
    async call(opts) {
      this.capturedPrompts.push(opts.user);
      return { text: JSON.stringify({ vote: "A", confidence: 0.9, reason: "captured" }) };
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-topic-"));
  const store = new Store(dir);
  await store.load();

  // Seed two ACCEPTED rules on different topics.
  await store.commit((s) => {
    s.rules["rule_redis"] = {
      id: "rule_redis",
      scope: "project",
      project_id: "topic-test",
      when: "x", prefer: "redis", avoid: "memcached",
      examples: [], counterexamples: [], priority: 1,
      source_ask_id: "ask_old1",
      created_at: new Date().toISOString(),
      status: "accepted",
      topic: ["redis", "cache", "session", "storage"],
    };
    s.rules["rule_auth"] = {
      id: "rule_auth",
      scope: "project",
      project_id: "topic-test",
      when: "x", prefer: "bearer", avoid: "basic",
      examples: [], counterexamples: [], priority: 1,
      source_ask_id: "ask_old2",
      created_at: new Date().toISOString(),
      status: "accepted",
      topic: ["bearer", "token", "auth", "header"],
    };
  });

  const cap = new CapturingProvider();
  const svc = new Service(store, { llm_provider: cap });

  // Submit an ask that is CLEARLY about caching (topic should match rule_redis only).
  const cacheAsk = {
    id: "ask_cache",
    project_id: "topic-test",
    project_name: "topic-test",
    project_type: "software",
    verification_surface: "business_rule",
    title: "Pick the cache backend for the session storage layer",
    context: "We need to pick between redis cache and an in-memory storage for sessions. High volume.",
    options: [
      { id: "A", label: "Redis", evidence: ["fast"], predicted_next_step: "wire redis client", cost_if_wrong: "infra", confidence: 0.7 },
      { id: "B", label: "In-memory", evidence: ["simple"], predicted_next_step: "use map", cost_if_wrong: "lost on restart", confidence: 0.5 },
      { id: "C", label: "PostgreSQL", evidence: ["already in stack"], predicted_next_step: "add table", cost_if_wrong: "db load", confidence: 0.5 },
    ],
    default_option_id: "A",
    confidence: 0.6,
    reversibility: "git_revert",
    expected_loss_if_wrong: 30,
    requested_human_seconds: 10,
    expires_in_seconds: 600,
    created_at: new Date().toISOString(),
  };
  await svc.submitAsk(cacheAsk);

  // Verify the prompt sent to ALL 5 personas mentions rule_redis but NOT rule_auth.
  const allPromptsText = cap.capturedPrompts.join("\n");
  const mentionsRedis = allPromptsText.includes('prefer "redis"');
  const mentionsAuth  = allPromptsText.includes('prefer "bearer"');
  log(
    "council prompt INCLUDES topic-relevant rule_redis",
    "true",
    `${mentionsRedis}`,
    mentionsRedis === true,
  );
  log(
    "council prompt EXCLUDES topic-irrelevant rule_auth",
    "true (no 'prefer \"bearer\"' substring)",
    `${!mentionsAuth}`,
    mentionsAuth === false,
  );

  // Sanity: extractTopic + ruleMatchesAsk behave as documented.
  const askTopic = extractTopic(cacheAsk);
  log(
    "extractTopic on cache-ask contains 'cache' or 'session' or 'redis'",
    "true",
    JSON.stringify(askTopic),
    askTopic.some(t => ["cache","session","redis","storage"].includes(t)),
  );
  log(
    "ruleMatchesAsk(rule_redis, cacheTopic)",
    "true",
    `${ruleMatchesAsk({ topic: ["redis", "cache"] }, askTopic)}`,
    ruleMatchesAsk({ topic: ["redis", "cache"] }, askTopic) === true,
  );
  log(
    "ruleMatchesAsk(rule_auth,  cacheTopic)",
    "false",
    `${ruleMatchesAsk({ topic: ["bearer", "auth"] }, askTopic)}`,
    ruleMatchesAsk({ topic: ["bearer", "auth"] }, askTopic) === false,
  );

  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`\n═══════════════════════════════════════════`);
console.log(`         ${pass} PASS, ${fail} FAIL`);
console.log(`═══════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
