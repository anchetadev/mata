import { test } from "node:test";
import assert from "node:assert/strict";
import { ImpactStore } from "../src/store/db.js";
import { buildDashboardHtml } from "../src/dashboard.js";

test("dashboard renders standalone HTML with headline metrics", () => {
  const store = new ImpactStore(":memory:");
  const now = 1_700_000_000_000;
  store.insert({ ts: now - 1000, source: "claude-code", model: "claude-opus-4-5", inputTokens: 5000, outputTokens: 2000, cachedInputTokens: 0, sessionId: "s", fidelity: "exact" });
  store.insert({ ts: now - 2000, source: "proxy:openai", model: "gpt-4o", inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0, sessionId: null, fidelity: "exact" });

  const html = buildDashboardHtml(store, { scenario: "midpoint", now, days: 30 });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Mata/);
  assert.match(html, /Energy/);
  assert.match(html, /Miles driven/);
  assert.match(html, /claude-opus-4-5/);
  assert.match(html, /<svg/); // charts present
  assert.match(html, /@media\(max-width:600px\)/); // mobile responsive
  assert.match(html, /width=device-width/); // viewport meta
  assert.match(html, /grid-template-columns:repeat\(auto-fit/); // fluid card grid
  store.close();
});

test("dashboard handles an empty store gracefully", () => {
  const store = new ImpactStore(":memory:");
  const html = buildDashboardHtml(store, { now: 1_700_000_000_000 });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /No data yet|No activity/);
  store.close();
});
