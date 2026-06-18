#!/usr/bin/env node
/**
 * Standalone Claude Code log tailer. Backfills all existing sessions, then
 * watches for new assistant turns and records their exact usage live.
 *
 * Usage:
 *   ai-impact-tail                 # watches ~/.claude/projects
 *   CLAUDE_PROJECTS_DIR=/path ai-impact-tail
 *
 * View the data with the `report` tool in the MCP server.
 */

import { ImpactStore } from "./store/db.js";
import { ClaudeCodeWatcher } from "./collectors/claude-code-collector.js";
import { defaultProjectsDir } from "./collectors/claude-code.js";
import { calculateImpact, formatImpact } from "./engine/index.js";

function main() {
  const store = new ImpactStore();
  const dir = defaultProjectsDir();
  const watcher = new ClaudeCodeWatcher(store, dir, ({ event }) => {
    const r = calculateImpact({ model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens });
    console.error(`[claude-code] ${event.model}  ${formatImpact(r)}`);
  });

  console.error(`ai-impact tailer: backfilling ${dir} …`);
  const res = watcher.start();
  console.error(`backfill: ${res.files} files, ${res.eventsAdded} new events recorded. Now watching for new activity.`);

  const shutdown = () => {
    console.error("\nstopping tailer…");
    watcher.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
