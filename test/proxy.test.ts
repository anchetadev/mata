import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { detectProvider, parseUsage } from "../src/collectors/usage-parser.js";
import { ImpactProxy } from "../src/collectors/proxy.js";

// ── Pure parser tests ──────────────────────────────────────────────────────

test("detectProvider routes by path", () => {
  assert.equal(detectProvider("/v1/messages"), "anthropic");
  assert.equal(detectProvider("/v1/chat/completions"), "openai");
  assert.equal(detectProvider("/v1/responses"), "openai");
  assert.equal(detectProvider("/health"), "unknown");
});

test("parses Anthropic non-streaming JSON usage incl. cache", () => {
  const body = JSON.stringify({
    model: "claude-sonnet-4-5",
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 50 },
  });
  const u = parseUsage("anthropic", false, body)!;
  assert.equal(u.model, "claude-sonnet-4-5");
  assert.equal(u.inputTokens, 1200);
  assert.equal(u.outputTokens, 300);
  assert.equal(u.cachedInputTokens, 50);
});

test("parses OpenAI non-streaming JSON usage (chat completions)", () => {
  const body = JSON.stringify({
    model: "gpt-4o",
    usage: { prompt_tokens: 800, completion_tokens: 250, prompt_tokens_details: { cached_tokens: 100 } },
  });
  const u = parseUsage("openai", false, body)!;
  assert.equal(u.inputTokens, 800);
  assert.equal(u.outputTokens, 250);
  assert.equal(u.cachedInputTokens, 100);
});

test("parses Anthropic SSE stream (message_start + message_delta)", () => {
  const sse = [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { model: "claude-opus-4-5", usage: { input_tokens: 2000, output_tokens: 1 } } })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 456 } })}`,
    ``,
    `data: [DONE]`,
  ].join("\n");
  const u = parseUsage("anthropic", true, sse)!;
  assert.equal(u.model, "claude-opus-4-5");
  assert.equal(u.inputTokens, 2000);
  assert.equal(u.outputTokens, 456);
});

test("parses OpenAI SSE stream with include_usage final chunk", () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
    `data: ${JSON.stringify({ model: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
    `data: [DONE]`,
  ].join("\n");
  const u = parseUsage("openai", true, sse)!;
  assert.equal(u.outputTokens, 5);
});

// ── Integration: real proxy in front of a fake upstream ────────────────────

function fakeUpstream(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Echo a canned Anthropic-style response with usage.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "claude-sonnet-4-5", usage: { input_tokens: 500, output_tokens: 120 } }));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

test("proxy forwards and records exact usage", async () => {
  const up = await fakeUpstream();
  const events: any[] = [];
  // Use an in-memory store path so the test doesn't touch the real DB.
  const { ImpactStore } = await import("../src/store/db.js");
  const store = new ImpactStore(":memory:");

  const proxy = new ImpactProxy({
    store,
    upstreams: { anthropic: up.url, openai: up.url, unknown: "" },
    onUsage: (e) => events.push(e),
    now: () => 1_700_000_000_000,
  });
  const port = await proxy.listen(0);

  const resp = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }),
  });
  const json = (await resp.json()) as any;

  // Response passed through unchanged.
  assert.equal(json.usage.output_tokens, 120);

  // Give the async collector a tick to record.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 500);
  assert.equal(events[0].outputTokens, 120);

  const rows = store.eventsSince(0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "proxy:anthropic");

  await proxy.close();
  await new Promise<void>((r) => up.server.close(() => r()));
  store.close();
});
