#!/usr/bin/env node
/**
 * Standalone runner for the local LLM proxy collector.
 *
 * Usage:
 *   ai-impact-proxy                # listens on :8788 (or $AI_IMPACT_PROXY_PORT)
 *
 * Then point a client at it, e.g.:
 *   ANTHROPIC_BASE_URL=http://localhost:8788   (Claude Code, Anthropic SDK)
 *   OPENAI_BASE_URL=http://localhost:8788/v1   (Codex, OpenAI SDK)
 *
 * Every request is forwarded to the real provider and returned unchanged; exact
 * token usage is recorded locally. See `report` in the MCP server to view it.
 */

import { ImpactProxy } from "./collectors/proxy.js";
import { calculateImpact, formatImpact } from "./engine/index.js";

async function main() {
  const proxy = new ImpactProxy({
    onUsage: ({ provider, model, inputTokens, outputTokens }) => {
      const r = calculateImpact({ model, inputTokens, outputTokens });
      console.error(`[${provider}] ${model}  ${formatImpact(r)}`);
    },
  });
  const port = await proxy.listen();
  console.error(`ai-impact proxy listening on http://localhost:${port}`);
  console.error("Point a client at it via ANTHROPIC_BASE_URL / OPENAI_BASE_URL, then run reports from the MCP server.");

  const shutdown = () => {
    console.error("\nshutting down proxy…");
    void proxy.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
