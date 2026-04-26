import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { AskRecord, JudgmentRule } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface StoreState {
  schema_version: number;
  asks: Record<string, AskRecord>;
  rules: Record<string, JudgmentRule>;
  attention: Record<string, string>; // project_id -> ISO of last decision
}

const EMPTY: StoreState = {
  schema_version: SCHEMA_VERSION,
  asks: {},
  rules: {},
  attention: {},
};

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

export class Store {
  private state: StoreState = clone(EMPTY);
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private tmpCounter = 0;

  constructor(private dir: string) {}

  get statePath(): string {
    return path.join(this.dir, "state.json");
  }

  get lockPath(): string {
    return path.join(this.dir, "state.lock");
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const raw = await safeReadFile(this.statePath);
    if (raw === null) {
      this.state = clone(EMPTY);
    } else {
      try {
        const parsed = JSON.parse(raw) as Partial<StoreState>;
        this.state = migrate(parsed);
      } catch {
        const corrupt = `${this.statePath}.corrupt-${Date.now()}`;
        await fs.rename(this.statePath, corrupt).catch(() => undefined);
        console.error(`[storage] corrupted state quarantined to ${corrupt}; starting fresh`);
        this.state = clone(EMPTY);
      }
    }
    this.loaded = true;
  }

  /**
   * Serialize all writes through a single chain (per-process mutex)
   * AND a cross-process file lock around the rename. Reloads from disk
   * before applying the mutator so concurrent writers don't lose updates.
   */
  async commit(mutate: (state: StoreState) => void | Promise<void>): Promise<void> {
    const previous = this.writeChain;
    const next = previous.then(async () => {
      await this.withFileLock(async () => {
        await this.reloadFromDisk();
        await mutate(this.state);
        await this.persist();
      });
    });
    // The chain must keep flowing even if this mutate rejected; otherwise every
    // subsequent commit would inherit this error. Callers still see the rejection
    // through `next`.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  // ------- read API (reads from in-memory state) -------

  getAsk(id: string): AskRecord | undefined {
    return this.state.asks[id];
  }

  allAsks(): AskRecord[] {
    return Object.values(this.state.asks);
  }

  getRule(id: string): JudgmentRule | undefined {
    return this.state.rules[id];
  }

  allRules(): JudgmentRule[] {
    return Object.values(this.state.rules);
  }

  rulesForProject(projectId: string, status?: JudgmentRule["status"]): JudgmentRule[] {
    return this.allRules().filter(
      (r) =>
        (status ? r.status === status : true) &&
        (r.scope === "all" || r.project_id === projectId),
    );
  }

  starvationSeconds(projectId: string, now: Date = new Date()): number {
    const last = this.state.attention[projectId];
    // Cold-start: a project that has never received a decision is NEW, not starved.
    // Returning a placeholder 24h here inflates first-use scores with phantom urgency.
    if (!last) return 0;
    return Math.max(0, (now.getTime() - new Date(last).getTime()) / 1000);
  }

  projects(): { project_id: string; project_name: string; pending: number }[] {
    const map = new Map<string, { project_id: string; project_name: string; pending: number }>();
    for (const r of this.allAsks()) {
      const k = r.ask.project_id;
      if (!map.has(k)) {
        map.set(k, { project_id: k, project_name: r.ask.project_name, pending: 0 });
      }
      if (r.status === "pending") map.get(k)!.pending += 1;
    }
    return Array.from(map.values());
  }

  /** Returns a deep clone — for tests/inspection only. */
  snapshot(): StoreState {
    return clone(this.state);
  }

  // ------- internals -------

  private async reloadFromDisk(): Promise<void> {
    const raw = await safeReadFile(this.statePath);
    if (raw === null) {
      // First write — keep current in-memory state.
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      this.state = migrate(parsed);
    } catch {
      // Already-loaded process; keep in-memory state if disk turned bad.
      console.error("[storage] disk state unparseable on reload; keeping in-memory state");
    }
  }

  private async persist(): Promise<void> {
    const tmp = path.join(
      this.dir,
      `state.json.${process.pid}.${++this.tmpCounter}.tmp`,
    );
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, this.statePath);
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.loaded) await this.load();
    const start = Date.now();
    while (true) {
      try {
        const fh = await fs.open(this.lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
        await fh.writeFile(`${process.pid}\n${Date.now()}\n`);
        await fh.close();
        try {
          return await fn();
        } finally {
          await fs.unlink(this.lockPath).catch(() => undefined);
        }
      } catch (e) {
        if (!isENodeErr(e) || e.code !== "EEXIST") throw e;
        if (await isLockStale(this.lockPath)) {
          await fs.unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new Error(`storage lock timeout (${this.lockPath})`);
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
}

function migrate(parsed: Partial<StoreState>): StoreState {
  return {
    schema_version: SCHEMA_VERSION,
    asks: parsed.asks ?? {},
    rules: parsed.rules ?? {},
    attention: parsed.attention ?? {},
  };
}

async function safeReadFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (isENodeErr(e) && e.code === "ENOENT") return null;
    throw e;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const st = await fs.stat(lockPath);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function isENodeErr(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === "object" && e !== null && "code" in e;
}
