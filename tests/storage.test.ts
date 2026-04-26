import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, SCHEMA_VERSION } from "../src/storage.ts";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Store load/commit", () => {
  it("starts empty when no file exists", async () => {
    const s = new Store(dir);
    await s.load();
    assert.equal(s.allAsks().length, 0);
    assert.equal(s.allRules().length, 0);
    assert.equal(s.snapshot().schema_version, SCHEMA_VERSION);
  });

  it("persists across re-load", async () => {
    const s1 = new Store(dir);
    await s1.load();
    await s1.commit((st) => {
      st.attention["proj"] = new Date().toISOString();
    });
    const s2 = new Store(dir);
    await s2.load();
    assert.ok(s2.snapshot().attention["proj"]);
  });

  it("quarantines corrupted state", async () => {
    await fs.writeFile(path.join(dir, "state.json"), "{not json");
    const s = new Store(dir);
    await s.load();
    assert.equal(s.allAsks().length, 0);
    const files = await fs.readdir(dir);
    assert.ok(files.some((f) => f.startsWith("state.json.corrupt-")));
  });

  it("serial commits within one process don't lose updates", async () => {
    const s = new Store(dir);
    await s.load();
    const N = 30;
    const ops = Array.from({ length: N }, (_, i) =>
      s.commit((st) => {
        st.attention[`p${i}`] = new Date().toISOString();
      }),
    );
    await Promise.all(ops);
    const snap = s.snapshot();
    for (let i = 0; i < N; i++) assert.ok(snap.attention[`p${i}`]);
  });

  it("two store instances on the same dir don't corrupt each other", async () => {
    const a = new Store(dir);
    const b = new Store(dir);
    await Promise.all([a.load(), b.load()]);
    await Promise.all([
      a.commit((st) => {
        st.attention["A"] = "1";
      }),
      b.commit((st) => {
        st.attention["B"] = "2";
      }),
      a.commit((st) => {
        st.attention["A2"] = "3";
      }),
      b.commit((st) => {
        st.attention["B2"] = "4";
      }),
    ]);
    // Final state must be parseable JSON with all four keys present (each commit reloads first).
    const fresh = new Store(dir);
    await fresh.load();
    const snap = fresh.snapshot();
    assert.equal(snap.attention["A"], "1");
    assert.equal(snap.attention["B"], "2");
    assert.equal(snap.attention["A2"], "3");
    assert.equal(snap.attention["B2"], "4");
  });

  it("a failing mutate does not poison the write chain", async () => {
    const s = new Store(dir);
    await s.load();
    await assert.rejects(
      s.commit(() => {
        throw new Error("boom");
      }),
      /boom/,
    );
    // The next commit must succeed.
    await s.commit((st) => {
      st.attention["after-failure"] = "ok";
    });
    assert.equal(s.snapshot().attention["after-failure"], "ok");
  });

  it("breaks a stale lock file", async () => {
    // Pre-create a lock file with old mtime.
    const lock = path.join(dir, "state.lock");
    await fs.writeFile(lock, "stale");
    const oldMs = Date.now() - 60_000;
    await fs.utimes(lock, oldMs / 1000, oldMs / 1000);
    const s = new Store(dir);
    await s.load();
    await s.commit((st) => {
      st.attention["after-stale"] = "ok";
    });
    assert.equal(s.snapshot().attention["after-stale"], "ok");
  });
});
