import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens, estimateTurns, type ChatTurn } from "../src/collectors/estimate.js";
import { parseWebTranscript } from "../src/collectors/claude-web-parse.js";
import { ImpactStore } from "../src/store/db.js";

test("countTokens is positive for text and 0 for empty", () => {
  assert.ok(countTokens("Hello, how does AI inference use energy?") > 5);
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens("   "), 0);
});

test("estimateTurns emits one estimated event per assistant turn", () => {
  const turns: ChatTurn[] = [
    { role: "user", text: "Write a haiku about data centers." },
    { role: "assistant", text: "Silicon hums warm / rivers of electrons flow / cooling towers sigh." },
    { role: "user", text: "Another one?" },
    { role: "assistant", text: "Night shift in the racks / fans exhale the day's queries / dawn bills arrive cold." },
  ];
  const events = estimateTurns(turns, { conversationId: "c1", model: "claude-sonnet-4-5" });
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.event.fidelity, "estimated");
    assert.equal(e.event.source, "claude-web");
    assert.ok(e.event.outputTokens > 0);
    assert.ok(e.event.inputTokens > 0); // preceding user text attributed as input
  }
});

test("estimateTurns keys are stable across re-runs (dedup-safe)", () => {
  const turns: ChatTurn[] = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello there, how can I help?" },
  ];
  const a = estimateTurns(turns, { conversationId: "c2", now: () => 1 });
  const b = estimateTurns(turns, { conversationId: "c2", now: () => 999 });
  assert.equal(a[0].key, b[0].key); // key independent of timestamp
});

test("record pipeline dedups via insertOnce", () => {
  const turns: ChatTurn[] = [
    { role: "user", text: "explain photosynthesis briefly" },
    { role: "assistant", text: "Plants convert sunlight, water, and CO2 into glucose and oxygen." },
  ];
  const store = new ImpactStore(":memory:");
  const events = estimateTurns(turns, { conversationId: "c3" });
  let added = 0;
  for (const e of events) if (store.insertOnce(e.key, e.event)) added++;
  for (const e of events) store.insertOnce(e.key, e.event); // re-run
  assert.equal(added, 1);
  assert.equal(store.eventsSince(0).length, 1);
  store.close();
});

test("parseWebTranscript segments by role markers", () => {
  const page = [
    "You said:",
    "How much water does a prompt use?",
    "Claude said:",
    "It depends on the data center, but on the order of milliliters per short prompt.",
  ].join("\n");
  const turns = parseWebTranscript(page);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  assert.match(turns[1].text, /milliliters/);
});

test("parseWebTranscript handles real claude.ai markers (You said / Claude responded)", () => {
  // Calibrated against the real claude.ai accessibility tree.
  const page = [
    "You said: add this mcp to your server list please",
    "Claude responded: I can help you add that MCP server. Here is the config you need.",
  ].join("\n");
  const turns = parseWebTranscript(page);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.match(turns[0].text, /add this mcp/);
  assert.equal(turns[1].role, "assistant");
  assert.match(turns[1].text, /config you need/);
});

test("parseWebTranscript falls back to one assistant block when no markers", () => {
  const turns = parseWebTranscript("just some unlabeled text blob");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].role, "assistant");
});
