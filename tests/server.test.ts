import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { Store } from "../src/storage.ts";
import { Service } from "../src/service.ts";
import { startServer } from "../src/server.ts";

let dir: string;
let srv: http.Server;
let baseUrl: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ar-srv-"));
  const store = new Store(dir);
  await store.load();
  const svc = new Service(store);
  srv = startServer({ service: svc, port: 0, host: "127.0.0.1", max_body_bytes: 256 });
  await once(srv, "listening");
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((res) => srv.close(() => res()));
  await fs.rm(dir, { recursive: true, force: true });
});

async function req(
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      "content-type": body === undefined ? "" : "application/json",
      ...headers,
    },
  });
  let parsed: any = undefined;
  const text = await res.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe("HTTP server", () => {
  it("GET /healthz", async () => {
    const r = await req("GET", "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  it("POST /asks rejects malformed JSON with 400", async () => {
    const r = await req("POST", "/asks", "{not json", { "content-type": "application/json" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid JSON/);
  });

  it("POST /asks rejects body without content-type=json with 415", async () => {
    const r = await req("POST", "/asks", "hello", { "content-type": "text/plain" });
    assert.equal(r.status, 415);
  });

  it("POST /asks rejects oversized body with 413", async () => {
    const big = { junk: "x".repeat(5000) };
    const r = await req("POST", "/asks", big);
    assert.equal(r.status, 413);
  });

  it("POST /asks 400s on schema violation", async () => {
    const r = await req("POST", "/asks", { foo: "bar" });
    assert.equal(r.status, 400);
  });

  it("GET /next?max=99 clamps to 3", async () => {
    const r = await req("GET", "/next?max=99");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.batch));
  });

  it("POST /decisions 404s for unknown ask", async () => {
    const r = await req("POST", "/decisions", {
      ask_id: "nope",
      choice: "A",
      create_rule: false,
    });
    assert.equal(r.status, 404);
  });

  it("POST /decisions 400s on bad choice", async () => {
    const r = await req("POST", "/decisions", {
      ask_id: "x",
      choice: "Z",
      create_rule: false,
    });
    assert.equal(r.status, 400);
  });
});

function once(emitter: NodeJS.EventEmitter, ev: string): Promise<void> {
  return new Promise((res) => emitter.once(ev, () => res()));
}
