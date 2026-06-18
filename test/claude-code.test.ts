import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeCodeLine, parseClaudeCodeText } from "../src/collectors/claude-code.js";
import { scanDir, ClaudeCodeWatcher } from "../src/collectors/claude-code-collector.js";
import { ImpactStore } from "../src/store/db.js";

/** Build a realistic assistant JSONL line. */
function assistantLine(opts: {
  uuid: string;
  model?: string;
  iterations?: any[];
  input?: number;
  output?: number;
  ts?: string;
}): string {
  const usage: any = { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 };
  if (opts.iterations) usage.iterations = opts.iterations;
  return JSON.stringify({
    type: "assistant",
    uuid: opts.uuid,
    sessionId: "sess-1",
    requestId: "req-1",
    timestamp: opts.ts ?? "2026-06-05T14:27:09.803Z",
    message: { id: "msg-1", model: opts.model ?? "claude-opus-4-7", role: "assistant", usage },
  });
}

// ── Parser ──────────────────────────────────────────────────────────────────

test("sums iterations when headline tokens are 0 (the real-log quirk)", () => {
  const line = assistantLine({
    uuid: "u1",
    iterations: [
      { input_tokens: 1, output_tokens: 543, cache_read_input_tokens: 952330, cache_creation_input_tokens: 729 },
      { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ],
  });
  const ke = parseClaudeCodeLine(line)!;
  assert.equal(ke.event.outputTokens, 643);
  assert.equal(ke.event.inputTokens, 3);
  assert.equal(ke.event.cachedInputTokens, 953059);
  assert.equal(ke.event.model, "claude-opus-4-7");
  assert.equal(ke.key, "cc:u1");
});

test("falls back to headline tokens when no iterations", () => {
  const ke = parseClaudeCodeLine(assistantLine({ uuid: "u2", input: 120, output: 80 }))!;
  assert.equal(ke.event.inputTokens, 120);
  assert.equal(ke.event.outputTokens, 80);
});

test("ignores non-assistant lines and all-zero usage", () => {
  assert.equal(parseClaudeCodeLine(JSON.stringify({ type: "user", message: {} })), null);
  assert.equal(parseClaudeCodeLine(assistantLine({ uuid: "z", input: 0, output: 0 })), null);
  assert.equal(parseClaudeCodeLine("not json"), null);
  assert.equal(parseClaudeCodeLine(""), null);
});

test("parseClaudeCodeText extracts only token-bearing entries", () => {
  const blob = [
    JSON.stringify({ type: "user", message: {} }),
    assistantLine({ uuid: "a", output: 10 }),
    JSON.stringify({ type: "system" }),
    assistantLine({ uuid: "b", output: 20 }),
  ].join("\n");
  assert.equal(parseClaudeCodeText(blob).length, 2);
});

// ── Scan + dedup ──────────────────────────────────────────────────────────────

test("scanDir records events and dedups on re-scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-scan-"));
  try {
    const sub = join(dir, "proj");
    writeFileSync(join(dir, "ignore.txt"), "not a session file");
    mkdirSync(sub);
    writeFileSync(
      join(sub, "s1.jsonl"),
      [assistantLine({ uuid: "x1", output: 100 }), assistantLine({ uuid: "x2", output: 200 })].join("\n"),
    );

    const store = new ImpactStore(":memory:");
    const r1 = scanDir(store, dir);
    assert.equal(r1.files, 1);
    assert.equal(r1.eventsFound, 2);
    assert.equal(r1.eventsAdded, 2);

    const r2 = scanDir(store, dir); // idempotent
    assert.equal(r2.eventsAdded, 0);

    assert.equal(store.eventsSince(0).length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Live watcher (smoke) ──────────────────────────────────────────────────────

test("watcher records a turn appended after start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-watch-"));
  const store = new ImpactStore(":memory:");
  const file = join(dir, "live.jsonl");
  writeFileSync(file, assistantLine({ uuid: "seed", output: 50 }) + "\n");

  const seen: string[] = [];
  const watcher = new ClaudeCodeWatcher(store, dir, (ke) => seen.push(ke.key));
  const backfill = watcher.start();
  assert.equal(backfill.eventsAdded, 1, "seed turn should be backfilled");

  // Append a new turn and wait for the watcher to pick it up.
  appendFileSync(file, assistantLine({ uuid: "live1", output: 75 }) + "\n");

  const deadline = Date.now() + 3000;
  while (!seen.includes("cc:live1") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  watcher.stop();
  const total = store.eventsSince(0).length;
  store.close();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(seen.includes("cc:live1"), "watcher should have recorded the appended turn");
  assert.equal(total, 2);
});
