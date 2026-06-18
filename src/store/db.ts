/**
 * Local-only event store. Collectors WRITE normalized usage events here;
 * MCP tools READ aggregates. Nothing leaves the machine.
 *
 * The store deliberately holds only token counts + minimal metadata — never
 * prompt/response text. Efficiency scoring that needs structure works on
 * per-event signals captured at collection time, not raw content.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A row as stored. `ts` is epoch milliseconds. */
export interface UsageEvent {
  id?: number;
  ts: number;
  /** Where it came from: "proxy", "claude-code", "codex", "web", "manual"... */
  source: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Groups events into a conversation/session for efficiency scoring. */
  sessionId: string | null;
  /** "exact" (proxy/log usage block) or "estimated" (re-tokenized scrape). */
  fidelity: "exact" | "estimated";
}

export interface RollupRow {
  source: string;
  model: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Default DB path: ~/.ai-impact/usage.db (override via AI_IMPACT_DB). */
export function defaultDbPath(): string {
  return process.env.AI_IMPACT_DB ?? join(homedir(), ".ai-impact", "usage.db");
}

export class ImpactStore {
  private db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        fidelity TEXT NOT NULL DEFAULT 'exact'
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_session ON usage_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_source ON usage_events(source);

      -- Dedup guard: a collector replaying a log shouldn't double-count.
      CREATE TABLE IF NOT EXISTS seen_keys (
        key TEXT PRIMARY KEY,
        ts INTEGER NOT NULL
      );

      -- Simple key/value settings (e.g. default scenario).
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Read a setting, or undefined if unset. */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** Write a setting (upsert). */
  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Insert one event. Returns the new row id. */
  insert(e: UsageEvent): number {
    const stmt = this.db.prepare(`
      INSERT INTO usage_events
        (ts, source, model, input_tokens, output_tokens, cached_input_tokens, session_id, fidelity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      e.ts,
      e.source,
      e.model,
      e.inputTokens,
      e.outputTokens,
      e.cachedInputTokens,
      e.sessionId,
      e.fidelity,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * Idempotent insert keyed by a stable collector-supplied key (e.g. a log
   * line hash). Skips if already seen. Returns true if inserted.
   */
  insertOnce(key: string, e: UsageEvent): boolean {
    const exists = this.db.prepare("SELECT 1 FROM seen_keys WHERE key = ?").get(key);
    if (exists) return false;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO seen_keys (key, ts) VALUES (?, ?)").run(key, e.ts);
      this.insert(e);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Fetch raw events in a time window (ms epoch, inclusive of `since`). */
  eventsSince(since: number, until: number = Number.MAX_SAFE_INTEGER): UsageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, source, model,
                input_tokens AS inputTokens,
                output_tokens AS outputTokens,
                cached_input_tokens AS cachedInputTokens,
                session_id AS sessionId, fidelity
           FROM usage_events
          WHERE ts >= ? AND ts <= ?
          ORDER BY ts ASC`,
      )
      .all(since, until) as unknown as UsageEvent[];
    return rows;
  }

  /** Events for a single session, chronologically. */
  eventsForSession(sessionId: string): UsageEvent[] {
    return this.db
      .prepare(
        `SELECT id, ts, source, model,
                input_tokens AS inputTokens,
                output_tokens AS outputTokens,
                cached_input_tokens AS cachedInputTokens,
                session_id AS sessionId, fidelity
           FROM usage_events
          WHERE session_id = ?
          ORDER BY ts ASC`,
      )
      .all(sessionId) as unknown as UsageEvent[];
  }

  /** Aggregate token totals grouped by source + model in a time window. */
  rollup(since: number, until: number = Number.MAX_SAFE_INTEGER): RollupRow[] {
    return this.db
      .prepare(
        `SELECT source, model,
                COUNT(*) AS events,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                SUM(cached_input_tokens) AS cachedInputTokens
           FROM usage_events
          WHERE ts >= ? AND ts <= ?
          GROUP BY source, model
          ORDER BY outputTokens DESC`,
      )
      .all(since, until) as unknown as RollupRow[];
  }

  close(): void {
    this.db.close();
  }
}
