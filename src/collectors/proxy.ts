/**
 * Local LLM proxy collector — the capture backbone.
 *
 * Point any API client at this proxy (e.g. ANTHROPIC_BASE_URL or
 * OPENAI_BASE_URL = http://localhost:8788) and it transparently forwards every
 * request to the real provider, records EXACT token usage from the response
 * (JSON or SSE streaming), and returns the response byte-for-byte unchanged.
 *
 * Provider-agnostic: routes by request path, so it captures Claude Code,
 * Codex, Cursor, and any other client you can repoint. It cannot see the Claude
 * desktop/web apps (they talk to Anthropic directly) — that's a separate,
 * later collector.
 *
 * No extra dependencies: built on Node's http + global fetch.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { Readable } from "node:stream";
import { ImpactStore } from "../store/db.js";
import { detectProvider, parseUsage, type Provider } from "./usage-parser.js";

export interface ProxyOptions {
  port?: number;
  store?: ImpactStore;
  /** Upstream base URLs by provider. */
  upstreams?: Partial<Record<Provider, string>>;
  /** Called after each usage event is recorded (for logging/tests). */
  onUsage?: (e: { provider: Provider; model: string; inputTokens: number; outputTokens: number }) => void;
  /** Injected clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_UPSTREAMS: Record<Provider, string> = {
  anthropic: process.env.ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com",
  openai: process.env.OPENAI_UPSTREAM ?? "https://api.openai.com",
  unknown: "",
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Headers to drop when forwarding (hop-by-hop / recomputed by fetch). */
const STRIP_REQ = new Set(["host", "content-length", "connection", "accept-encoding"]);

export class ImpactProxy {
  private server: Server;
  private store: ImpactStore;
  private upstreams: Record<Provider, string>;
  private onUsage?: ProxyOptions["onUsage"];
  private now: () => number;

  constructor(opts: ProxyOptions = {}) {
    this.store = opts.store ?? new ImpactStore();
    this.upstreams = { ...DEFAULT_UPSTREAMS, ...opts.upstreams };
    this.onUsage = opts.onUsage;
    this.now = opts.now ?? Date.now;
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  listen(port = Number(process.env.AI_IMPACT_PROXY_PORT ?? 8788)): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.server.close((e) => (e ? reject(e) : resolve())));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = req.url ?? "/";
      const provider = detectProvider(path);
      const base = this.upstreams[provider];

      if (!base) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`ai-impact proxy: no upstream for path "${path}". Set a base URL the proxy recognizes.`);
        return;
      }

      const body = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!STRIP_REQ.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
      }
      headers["accept-encoding"] = "identity"; // keep SSE/text uncompressed for parsing

      const upstreamUrl = base.replace(/\/$/, "") + path;
      const method = req.method ?? "POST";

      const upstream = await fetch(upstreamUrl, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
      });

      // Mirror status + headers back to the client.
      const respHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "content-encoding") respHeaders[k] = v;
      });
      res.writeHead(upstream.status, respHeaders);

      const contentType = upstream.headers.get("content-type") ?? "";
      const isSse = contentType.includes("text/event-stream");

      if (!upstream.body) {
        res.end();
        return;
      }

      // Tee: one branch streams to the client untouched, the other is buffered
      // for usage parsing. Parsing never blocks or alters the client stream.
      const [toClient, toParse] = upstream.body.tee();

      Readable.fromWeb(toClient as any).pipe(res);

      void this.collect(provider, isSse, toParse).catch(() => {
        /* parsing failures must never affect the proxied response */
      });
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`ai-impact proxy error: ${(err as Error).message}`);
    }
  }

  private async collect(provider: Provider, isSse: boolean, stream: ReadableStream): Promise<void> {
    const text = await new Response(stream).text();
    const usage = parseUsage(provider, isSse, text);
    if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) return;

    this.store.insert({
      ts: this.now(),
      source: `proxy:${provider}`,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      sessionId: null,
      fidelity: "exact",
    });
    this.onUsage?.({ provider, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
  }
}
