import http from "node:http";
import process from "node:process";
import { URL } from "node:url";
import { DecisionError, type Service } from "./service.ts";
import { parseAgentAsk, parseHumanDecision, parseRuleId, SchemaError } from "./parsers.ts";
import { clampMax } from "./batching.ts";

export interface ServerOptions {
  service: Service;
  port?: number;
  host?: string;
  max_body_bytes?: number;
  /** If set, requests must carry `Authorization: Bearer <token>`. */
  auth_token?: string;
}

const DEFAULT_MAX_BODY = Number(process.env.AR_MAX_BODY_BYTES ?? 1024 * 1024);
const DEFAULT_AUTH_TOKEN = process.env.AR_AUTH_TOKEN || undefined;

export function startServer(opts: ServerOptions): http.Server {
  const port = opts.port ?? 7777;
  const host = opts.host ?? "127.0.0.1";
  const maxBody = opts.max_body_bytes ?? DEFAULT_MAX_BODY;
  const authToken = opts.auth_token ?? DEFAULT_AUTH_TOKEN;

  const server = http.createServer((req, res) => {
    if (authToken && !checkAuth(req, authToken)) {
      return send(res, 401, { error: "unauthorized" });
    }
    handle(req, res, opts.service, maxBody).catch((e) => {
      console.error("[server] unhandled", e);
      send(res, 500, { error: "internal" });
    });
  });
  server.listen(port, host, () => {
    console.error(`[attention-router] listening on http://${host}:${port}`);
  });
  return server;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  svc: Service,
  maxBody: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  try {
    switch (route) {
      case "GET /healthz":
        return send(res, 200, { ok: true, schema_version: 1 });

      case "POST /asks": {
        const body = await readBody(req, maxBody);
        const obj = parseJson(body);
        const ask = parseAgentAsk(obj, { fill_defaults: true });
        const out = await svc.submitAsk(ask);
        return send(res, out.status === "rejected" ? 422 : 202, out);
      }

      case "POST /asks/structure": {
        const body = await readBody(req, maxBody);
        const o = parseJson(body) as Record<string, unknown>;
        const requireStr = (k: string): string => {
          if (typeof o[k] !== "string" || !(o[k] as string).length) {
            throw new SchemaError(`${k} is required (string)`);
          }
          return o[k] as string;
        };
        const out = await svc.structureAndSubmit({
          project_id: requireStr("project_id"),
          project_name: requireStr("project_name"),
          project_type: o.project_type as never,
          verification_surface: o.verification_surface as never,
          dilemma: requireStr("dilemma"),
          context: requireStr("context"),
          requested_human_seconds: typeof o.requested_human_seconds === "number" ? o.requested_human_seconds : undefined,
          expires_in_seconds: typeof o.expires_in_seconds === "number" ? o.expires_in_seconds : undefined,
          callback_url: typeof o.callback_url === "string" ? o.callback_url : undefined,
        });
        return send(res, out.status === "rejected" ? 422 : 202, out);
      }

      case "POST /asks/jsonl": {
        const body = await readBody(req, maxBody);
        const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const results: unknown[] = [];
        for (const [i, line] of lines.entries()) {
          try {
            const ask = parseAgentAsk(JSON.parse(line), { fill_defaults: true });
            results.push(await svc.submitAsk(ask));
          } catch (e) {
            if (e instanceof SchemaError || e instanceof SyntaxError) {
              results.push({ status: "error", line: i + 1, error: e.message });
            } else throw e;
          }
        }
        return send(res, 200, { results });
      }

      case "GET /next": {
        const max = clampMax(Number(url.searchParams.get("max") ?? "3"));
        const batch = await svc.nextBatch(max);
        return send(res, 200, { batch });
      }

      case "POST /decisions": {
        const body = await readBody(req, maxBody);
        const dec = parseHumanDecision(parseJson(body));
        const out = await svc.decide(dec);
        return send(res, 200, out);
      }

      case "POST /skip": {
        const body = await readBody(req, maxBody);
        const { id } = parseRuleId(parseJson(body));
        const rec = await svc.skip(id);
        return send(res, rec ? 200 : 404, { record: rec });
      }

      case "GET /rules":
        return send(res, 200, { rules: svc.listRules() });

      case "POST /rules/accept": {
        const { id } = parseRuleId(parseJson(await readBody(req, maxBody)));
        const r = await svc.setRuleStatus(id, "accepted");
        return send(res, r ? 200 : 404, { rule: r });
      }

      case "POST /rules/reject": {
        const { id } = parseRuleId(parseJson(await readBody(req, maxBody)));
        const r = await svc.setRuleStatus(id, "rejected");
        return send(res, r ? 200 : 404, { rule: r });
      }

      case "POST /rules/stale": {
        const { id } = parseRuleId(parseJson(await readBody(req, maxBody)));
        const r = await svc.markRuleStale(id);
        return send(res, r ? 200 : 404, { rule: r });
      }

      case "POST /rules/edit": {
        const o = parseJson(await readBody(req, maxBody)) as Record<string, unknown>;
        if (typeof o.id !== "string") return send(res, 400, { error: "id required" });
        const field = String(o.field ?? "");
        if (!["prefer", "avoid", "priority", "when"].includes(field)) {
          return send(res, 400, { error: "field must be prefer|avoid|priority|when" });
        }
        const value = o.value;
        if (typeof value !== "string" && typeof value !== "number") {
          return send(res, 400, { error: "value must be string or number" });
        }
        const r = await svc.editRule(
          o.id,
          field as "prefer" | "avoid" | "priority" | "when",
          value,
        );
        return send(res, r ? 200 : 404, { rule: r });
      }

      case "GET /projects":
        return send(res, 200, { projects: svc.listProjects() });

      case "GET /status":
        return send(res, 200, svc.status());

      default:
        return send(res, 404, { error: `no route: ${route}` });
    }
  } catch (e) {
    if (e instanceof SchemaError) return send(res, 400, { error: e.message });
    if (e instanceof DecisionError) {
      const code = e.code === "not_found" ? 404 : e.code === "not_pending" ? 409 : 400;
      return send(res, code, { error: e.message });
    }
    if (e instanceof BodyError) return send(res, e.status, { error: e.message });
    if (e instanceof SyntaxError) return send(res, 400, { error: `invalid JSON: ${e.message}` });
    throw e;
  }
}

class BodyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return "";
  const ct = (req.headers["content-type"] ?? "").toString().toLowerCase();
  // Empty body OK; otherwise must be JSON.
  if (ct && !ct.startsWith("application/json")) {
    throw new BodyError("content-type must be application/json", 415);
  }

  let total = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new BodyError(`body exceeds ${maxBytes} bytes`, 413);
    chunks.push(buf);
  }
  if (total === 0) return "";
  if (!ct) throw new BodyError("content-type must be application/json", 415);
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new SyntaxError((e as Error).message);
  }
}

function checkAuth(req: http.IncomingMessage, expected: string): boolean {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return false;
  if (!h.startsWith("Bearer ")) return false;
  const got = h.slice(7);
  // constant-time comparison
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
