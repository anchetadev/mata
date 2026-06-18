/**
 * Claude Code log collector. Reads the JSONL session transcripts Claude Code
 * writes under ~/.claude/projects/<project>/<session>.jsonl and extracts EXACT
 * token usage from assistant entries.
 *
 * Privacy: only model, token counts, ids, and timestamps are read — never the
 * content of your messages.
 *
 * Format notes (verified against real logs):
 *  - One JSON object per line; `type` is "assistant", "user", "system", …
 *  - Assistant entries carry `message.model`, `message.usage`, a unique `uuid`
 *    (our dedup key), `requestId`, `sessionId`, and an ISO `timestamp`.
 *  - The headline `usage.input_tokens` / `output_tokens` can be 0; the true
 *    counts are split across `usage.iterations[]`, which we sum.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "../store/db.js";

/** Default Claude Code projects directory (override via CLAUDE_PROJECTS_DIR). */
export function defaultProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** A parsed event plus the stable key used to dedup it. */
export interface KeyedEvent {
  key: string;
  event: UsageEvent;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

interface Iteration {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Sum the per-iteration token fields, used when the headline counts are 0. */
function sumIterations(iters: Iteration[]) {
  return iters.reduce(
    (a, it) => ({
      input: a.input + n(it.input_tokens),
      output: a.output + n(it.output_tokens),
      cache: a.cache + n(it.cache_read_input_tokens) + n(it.cache_creation_input_tokens),
    }),
    { input: 0, output: 0, cache: 0 },
  );
}

/**
 * Parse a single JSONL line into a keyed usage event, or null if the line is
 * not a token-bearing assistant entry.
 */
export function parseClaudeCodeLine(line: string): KeyedEvent | null {
  if (!line.trim()) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o?.type !== "assistant" || !o.message?.usage) return null;

  const msg = o.message;
  const u = msg.usage;

  let input: number, output: number, cache: number;
  if (Array.isArray(u.iterations) && u.iterations.length > 0) {
    const s = sumIterations(u.iterations as Iteration[]);
    input = s.input;
    output = s.output;
    cache = s.cache;
  } else {
    input = n(u.input_tokens);
    output = n(u.output_tokens);
    cache = n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  }

  // Nothing to record.
  if (input === 0 && output === 0 && cache === 0) return null;

  // uuid is unique per entry — the natural idempotency key.
  const key = `cc:${o.uuid ?? `${o.sessionId}:${o.requestId}:${msg.id}`}`;
  const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now();

  return {
    key,
    event: {
      ts: Number.isFinite(ts) ? ts : Date.now(),
      source: "claude-code",
      model: String(msg.model ?? "unknown"),
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cache,
      sessionId: o.sessionId ?? null,
      fidelity: "exact",
    },
  };
}

/** Parse all token-bearing entries from a JSONL blob. */
export function parseClaudeCodeText(text: string): KeyedEvent[] {
  const out: KeyedEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const e = parseClaudeCodeLine(line);
    if (e) out.push(e);
  }
  return out;
}

/** Recursively list *.jsonl files under a directory. */
export function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listSessionFiles(p));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
