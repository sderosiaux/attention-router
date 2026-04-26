#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srv = path.resolve(here, "..", "src", "mcp-server.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", srv], { stdio: "inherit" });
process.exit(r.status ?? 1);
