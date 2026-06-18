/**
 * Live dashboard server. Serves the HTML dashboard and regenerates it from the
 * store on every request, so a browser refresh always shows current data. An
 * injected meta-refresh keeps an open tab updating on its own.
 *
 * Built on Node's http — no extra dependencies.
 */

import { createServer, type Server } from "node:http";
import type { ImpactStore } from "./store/db.js";
import { buildDashboardHtml } from "./dashboard.js";
import type { Scenario } from "./engine/index.js";

export interface ServeOptions {
  store: ImpactStore;
  scenario?: Scenario;
  days?: number;
  /** Auto-refresh interval injected into the page (seconds). 0 disables. */
  refreshSeconds?: number;
}

/** Create (but don't start) a live dashboard HTTP server. */
export function createDashboardServer(opts: ServeOptions): Server {
  const refresh = opts.refreshSeconds ?? 30;
  return createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url !== "/") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // Regenerate fresh from the store → always current.
    const html = buildDashboardHtml(opts.store, {
      scenario: opts.scenario,
      days: opts.days,
      autoRefreshSeconds: refresh > 0 ? refresh : undefined,
    });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
}

/** Create + start the server. Resolves with the bound port. */
export function startDashboardServer(opts: ServeOptions & { port?: number }): Promise<{ server: Server; port: number }> {
  const server = createDashboardServer(opts);
  const port = opts.port ?? Number(process.env.AI_IMPACT_DASHBOARD_PORT ?? 8799);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
