import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSeedState } from "./seed.ts";
import type { State } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(here, "../../../../.data");

/** Root folder for all household data (each home gets its own subfolder; the default home uses the root). */
export function dataRoot(): string {
  return process.env.BUDDY_DATA_DIR ?? DEFAULT_DIR;
}

/**
 * Durable household memory. Everything a returning learner expects Vidya to remember
 * (profile, interests, what clicked, mistakes, review schedule, exams, stories) lives here, so a
 * conversation can pick up days later in a brand-new MCP session.
 */
export class Store {
  private state: State;
  readonly file: string | null;

  constructor(opts: { dir?: string | null } = {}) {
    const dir = opts.dir === undefined ? (process.env.BUDDY_DATA_DIR ?? DEFAULT_DIR) : opts.dir;
    this.file = dir ? path.join(dir, "study-buddy-state.json") : null;
    this.state = this.load();
  }

  private load(): State {
    if (this.file && existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as State;
        if (parsed.version === 2) return parsed;
      } catch {
        // fall through to a fresh seed
      }
    }
    const fresh = createSeedState(new Date());
    this.write(fresh);
    return fresh;
  }

  private write(s: State) {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }

  get(): State {
    return this.state;
  }

  /** Apply a mutation and persist it. */
  update<T>(fn: (s: State) => T): T {
    const out = fn(this.state);
    this.write(this.state);
    return out;
  }

  now(): Date {
    return new Date(Date.now() + this.state.clockOffsetMs);
  }

  nextId(prefix: string): string {
    return this.update((s) => `${prefix}-${++s.seq}`);
  }

  reset() {
    this.state = createSeedState(new Date());
    this.write(this.state);
  }

  advanceClock(days: number) {
    this.update((s) => {
      s.clockOffsetMs += Math.round(days * 86_400_000);
    });
  }
}
