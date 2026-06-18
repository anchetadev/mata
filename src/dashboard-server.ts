#!/usr/bin/env node
/**
 * Generate the HTML dashboard from the local store and print its path.
 *
 * Usage:
 *   ai-impact-dashboard [output.html]
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ImpactStore } from "./store/db.js";
import { buildDashboardHtml } from "./dashboard.js";

function main() {
  const store = new ImpactStore();
  const out = process.argv[2] ?? join(homedir(), ".ai-impact", "dashboard.html");
  const scenario = (store.getSetting("scenario") as any) ?? "midpoint";
  const html = buildDashboardHtml(store, { scenario });
  writeFileSync(out, html, "utf8");
  store.close();
  console.error(`Dashboard written to ${out}`);
  console.log(out);
}

main();
