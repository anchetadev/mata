import { test } from "node:test";
import assert from "node:assert/strict";
import { ImpactStore } from "../src/store/db.js";
import { startDashboardServer } from "../src/dashboard-serve.js";

test("live server regenerates on each request (always current)", async () => {
  const store = new ImpactStore(":memory:");
  store.insert({ ts: Date.now(), source: "claude-code", model: "claude-opus-4-5", inputTokens: 100, outputTokens: 500, cachedInputTokens: 0, sessionId: null, fidelity: "exact" });

  const { server, port } = await startDashboardServer({ store, refreshSeconds: 15, port: 0 });
  try {
    const r1 = await fetch(`http://localhost:${port}/`);
    const html1 = await r1.text();
    assert.equal(r1.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(html1, /claude-opus-4-5/);
    assert.match(html1, /http-equiv="refresh" content="15"/); // auto-refresh injected
    assert.doesNotMatch(html1, /gpt-4o/);

    // Add new usage, then refetch — should appear without restarting the server.
    store.insert({ ts: Date.now(), source: "proxy:openai", model: "gpt-4o", inputTokens: 50, outputTokens: 200, cachedInputTokens: 0, sessionId: null, fidelity: "exact" });
    const html2 = await (await fetch(`http://localhost:${port}/`)).text();
    assert.match(html2, /gpt-4o/, "new model should appear on refresh");

    const health = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(await health.text(), "ok");
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    store.close();
  }
});
