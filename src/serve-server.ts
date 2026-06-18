#!/usr/bin/env node
/**
 * Live, always-current dashboard server.
 *
 * Usage:
 *   ai-impact-serve            # http://localhost:8799 (or $AI_IMPACT_DASHBOARD_PORT)
 *   ai-impact-serve --no-open  # don't auto-open the browser
 *
 * The page regenerates from ~/.ai-impact/usage.db on every request and
 * auto-refreshes, so it always reflects your latest recorded usage.
 */

import { spawn } from "node:child_process";
import { ImpactStore } from "./store/db.js";
import { startDashboardServer } from "./dashboard-serve.js";

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* opening is best-effort */
  }
}

async function main() {
  const store = new ImpactStore();
  const scenario = (store.getSetting("scenario") as any) ?? "midpoint";
  const { server, port } = await startDashboardServer({ store, scenario, refreshSeconds: 30 });
  const url = `http://localhost:${port}`;
  console.error(`Mata dashboard live at ${url}  (auto-refreshes every 30s)`);
  if (!process.argv.includes("--no-open")) openBrowser(url);

  const shutdown = () => {
    console.error("\nstopping dashboard server…");
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
