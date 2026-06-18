#!/usr/bin/env node
/**
 * AI Impact MCP server (stdio). Exposes the impact engine + local usage store
 * to any MCP host (Claude Desktop, Claude Code, Cursor, …).
 *
 * Tools:
 *   estimate_impact   — one-off "what did this cost?" for given token counts
 *   log_usage         — record a usage event into the local store
 *   report            — period rollup (today/week/month/all) with the 4 metrics
 *   efficiency_score  — prompt-economy coach over a conversation's turns
 *   set_scenario      — set the default confidence scenario
 *
 * Resource:
 *   impact://methodology — how the numbers are derived (+ EcoLogits attribution)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { calculateImpact, formatImpact, type Scenario } from "./engine/index.js";
import { ImpactStore } from "./store/db.js";
import { buildReport, renderReport, type Period } from "./reporting.js";
import { scoreEfficiency, type Turn } from "./efficiency/score.js";
import { analyzeRecentSessions } from "./efficiency/session.js";
import { buildDashboardHtml } from "./dashboard.js";
import { startDashboardServer } from "./dashboard-serve.js";
import type { Server } from "node:http";
import { scanDir } from "./collectors/claude-code-collector.js";
import { estimateTurns, type ChatTurn } from "./collectors/estimate.js";
import { parseWebTranscript } from "./collectors/claude-web-parse.js";

const store = new ImpactStore();
const SCENARIOS = ["conservative", "midpoint", "high"] as const;

function defaultScenario(): Scenario {
  return (store.getSetting("scenario") as Scenario | undefined) ?? "midpoint";
}

/** Epoch ms — isolated so the rest of the code stays testable/deterministic. */
function nowMs(): number {
  return Date.now();
}

const server = new McpServer({ name: "ai-impact", version: "0.1.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// ── estimate_impact ────────────────────────────────────────────────────────
server.registerTool(
  "estimate_impact",
  {
    title: "Estimate AI environmental impact",
    description:
      "Estimate the environmental impact (energy kWh, miles driven in a gas car, water for cooling, CO2e) for a single AI request given its token counts. Uses the EcoLogits life-cycle methodology.",
    inputSchema: {
      model: z.string().describe('Model id, e.g. "claude-opus-4-5", "gpt-4o".'),
      input_tokens: z.number().int().nonnegative().default(0),
      output_tokens: z.number().int().nonnegative().describe("Output/completion tokens — the main energy driver."),
      scenario: z.enum(SCENARIOS).optional().describe("Confidence scenario; defaults to the configured one."),
      zone: z.string().optional().describe("Electricity zone override (ISO3 / WOR), e.g. FRA, USA."),
    },
  },
  async (a) => {
    const scenario = (a.scenario as Scenario) ?? defaultScenario();
    const r = calculateImpact(
      { model: a.model, inputTokens: a.input_tokens ?? 0, outputTokens: a.output_tokens },
      scenario,
      a.zone ? { zone: a.zone } : {},
    );
    const detail =
      `${formatImpact(r)}\n\n` +
      `Resolved: ${r.assumptions.resolvedModel} (${r.assumptions.modelMatch}), ` +
      `${r.assumptions.activeParamsB}B active params, ${r.assumptions.gpuCount} GPUs, zone ${r.assumptions.zone}.\n` +
      `Carbon: ${r.co2eGramsUsage.toFixed(3)} g electricity + ${r.co2eGramsEmbodied.toFixed(3)} g hardware.` +
      (r.assumptions.warnings.length ? `\n⚠ ${r.assumptions.warnings.join("; ")}` : "");
    return { ...text(detail), structuredContent: r as unknown as Record<string, unknown> };
  },
);

// ── log_usage ────────────────────────────────────────────────────────────────
server.registerTool(
  "log_usage",
  {
    title: "Record an AI usage event",
    description:
      "Record one AI request's token usage into the local store so it shows up in reports. Use this to manually log usage from any client.",
    inputSchema: {
      model: z.string(),
      input_tokens: z.number().int().nonnegative().default(0),
      output_tokens: z.number().int().nonnegative().default(0),
      cached_input_tokens: z.number().int().nonnegative().default(0),
      source: z.string().default("manual").describe('Where it came from: "claude-code", "codex", "web", "manual"...'),
      session_id: z.string().optional(),
      fidelity: z.enum(["exact", "estimated"]).default("exact"),
    },
  },
  async (a) => {
    const id = store.insert({
      ts: nowMs(),
      source: a.source ?? "manual",
      model: a.model,
      inputTokens: a.input_tokens ?? 0,
      outputTokens: a.output_tokens ?? 0,
      cachedInputTokens: a.cached_input_tokens ?? 0,
      sessionId: a.session_id ?? null,
      fidelity: a.fidelity ?? "exact",
    });
    const r = calculateImpact(
      { model: a.model, inputTokens: a.input_tokens ?? 0, outputTokens: a.output_tokens ?? 0 },
      defaultScenario(),
    );
    return text(`Logged event #${id} (${a.model}). This request: ${formatImpact(r)}`);
  },
);

// ── report ───────────────────────────────────────────────────────────────────
server.registerTool(
  "report",
  {
    title: "AI impact report",
    description:
      "Summarize recorded AI usage and its environmental impact over a period (today, week, month, all), broken down by model.",
    inputSchema: {
      period: z.enum(["today", "week", "month", "all"]).default("week"),
      scenario: z.enum(SCENARIOS).optional(),
    },
  },
  async (a) => {
    const scenario = (a.scenario as Scenario) ?? defaultScenario();
    const report = buildReport(store, (a.period as Period) ?? "week", scenario, nowMs());
    return text(renderReport(report));
  },
);

// ── efficiency_score ──────────────────────────────────────────────────────────
server.registerTool(
  "efficiency_score",
  {
    title: "Prompt-efficiency score",
    description:
      "Score how efficiently a conversation was set up (fewest prompts/rework). Pass the conversation turns. Returns a 0–100 score, grade, and actionable tips.",
    inputSchema: {
      turns: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string().optional(),
            output_tokens: z.number().int().nonnegative().optional(),
          }),
        )
        .describe("Conversation turns in order."),
    },
  },
  async (a) => {
    const turns: Turn[] = a.turns.map((t) => ({
      role: t.role,
      text: t.text,
      outputTokens: t.output_tokens,
    }));
    const r = scoreEfficiency(turns);
    const body =
      `Efficiency: ${r.score}/100 (grade ${r.grade})\n` +
      `Turns: ${r.metrics.userTurns} user / ${r.metrics.assistantTurns} assistant · ` +
      `rework signals: ${r.metrics.reworkSignals} · clarifying Qs: ${r.metrics.clarificationQuestions}\n\n` +
      r.tips.map((t) => `• ${t}`).join("\n");
    return { ...text(body), structuredContent: r as unknown as Record<string, unknown> };
  },
);

// ── analyze_efficiency ────────────────────────────────────────────────────────
server.registerTool(
  "analyze_efficiency",
  {
    title: "Analyze prompt efficiency of recent sessions",
    description:
      "Run the efficiency coach over your most recent Claude Code sessions (reads transcript text on-demand, never stores it). Returns per-session scores, an average, wasted-rework tokens, and your top recurring tips.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(5).describe("How many recent sessions to analyze."),
      dir: z.string().optional(),
    },
  },
  async (a) => {
    const ov = analyzeRecentSessions(a.dir, a.limit ?? 5);
    if (ov.sessionsAnalyzed === 0) return text("No Claude Code sessions with user turns found to analyze.");
    const lines: string[] = [];
    lines.push(`# Efficiency coach — last ${ov.sessionsAnalyzed} session(s)\n`);
    lines.push(`Average score: ${ov.averageScore}/100 · rework redone ≈ ${ov.totalReworkWastedTokens.toLocaleString()} output tokens\n`);
    for (const s of ov.sessions) {
      lines.push(
        `• [${s.result.grade}] ${s.result.score}/100 — "${s.title}" (${s.userTurns} turns, ` +
          `${s.result.metrics.reworkSignals} rework, completeness ${s.result.metrics.firstPromptCompleteness}/100)`,
      );
    }
    if (ov.topTips.length) {
      lines.push(`\nTop tips:`);
      for (const t of ov.topTips) lines.push(`  → ${t}`);
    }
    return { ...text(lines.join("\n")), structuredContent: ov as unknown as Record<string, unknown> };
  },
);

// ── set_scenario ──────────────────────────────────────────────────────────────
server.registerTool(
  "set_scenario",
  {
    title: "Set default scenario",
    description:
      "Set the default confidence scenario for future estimates. conservative = lowest (min active params), midpoint = mean, high = max.",
    inputSchema: { scenario: z.enum(SCENARIOS) },
  },
  async (a) => {
    store.setSetting("scenario", a.scenario);
    return text(`Default scenario set to "${a.scenario}".`);
  },
);

// ── scan_logs ─────────────────────────────────────────────────────────────────
server.registerTool(
  "scan_logs",
  {
    title: "Scan Claude Code logs",
    description:
      "Backfill exact AI usage from Claude Code's local session transcripts (~/.claude/projects). Reads only token counts + metadata, never message content. Idempotent — safe to run repeatedly.",
    inputSchema: {
      dir: z.string().optional().describe("Override the Claude Code projects directory."),
    },
  },
  async (a) => {
    const res = scanDir(store, a.dir);
    const report = buildReport(store, "all", defaultScenario(), nowMs());
    return text(
      `Scanned ${res.files} session files: ${res.eventsFound} assistant turns, ${res.eventsAdded} newly recorded.\n\n` +
        renderReport(report),
    );
  },
);

// ── record_web_chat ───────────────────────────────────────────────────────────
server.registerTool(
  "record_web_chat",
  {
    title: "Record consumer chat (estimated)",
    description:
      "Record ESTIMATED usage for a Claude desktop/web conversation that doesn't expose token counts. Preferred: pass structured `turns` (the host extracts them from the page). Fallback: pass raw `page_text` and it will be parsed best-effort. Tokens are estimated with a BPE proxy and tagged 'estimated'.",
    inputSchema: {
      turns: z
        .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }))
        .optional()
        .describe("Conversation turns in order (reliable input)."),
      page_text: z.string().optional().describe("Raw flattened transcript text (fallback if turns unavailable)."),
      model: z.string().optional().describe('Model the chat used; defaults to a Sonnet-class model.'),
      conversation_id: z.string().optional(),
    },
  },
  async (a) => {
    const turns: ChatTurn[] = a.turns ?? (a.page_text ? parseWebTranscript(a.page_text) : []);
    if (turns.length === 0) {
      return text("No turns provided. Pass `turns` (preferred) or `page_text`.");
    }
    const keyed = estimateTurns(turns, {
      model: a.model,
      conversationId: a.conversation_id,
      now: nowMs,
    });
    let added = 0;
    for (const ke of keyed) if (store.insertOnce(ke.key, ke.event)) added++;

    const inTok = keyed.reduce((n, k) => n + k.event.inputTokens, 0);
    const outTok = keyed.reduce((n, k) => n + k.event.outputTokens, 0);
    const r = calculateImpact(
      { model: a.model ?? "claude-sonnet-4-5", inputTokens: inTok, outputTokens: outTok },
      defaultScenario(),
    );
    return text(
      `Recorded ${added} assistant turn(s) as ESTIMATED usage (≈${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out).\n` +
        `${formatImpact(r)}\n⚠ Estimated via BPE proxy (not exact) — Claude's tokenizer is not public.`,
    );
  },
);

// ── generate_dashboard ────────────────────────────────────────────────────────
server.registerTool(
  "generate_dashboard",
  {
    title: "Generate visual dashboard",
    description:
      "Build a standalone HTML dashboard (charts of energy/carbon/water over time and by model) from your recorded usage. Returns the file path to open in a browser.",
    inputSchema: {
      path: z.string().optional().describe("Output .html path. Defaults to ~/.ai-impact/dashboard.html."),
      scenario: z.enum(SCENARIOS).optional(),
      days: z.number().int().min(1).max(365).default(30),
    },
  },
  async (a) => {
    const out = a.path ?? join(homedir(), ".ai-impact", "dashboard.html");
    const html = buildDashboardHtml(store, {
      scenario: (a.scenario as Scenario) ?? defaultScenario(),
      now: nowMs(),
      days: a.days ?? 30,
    });
    writeFileSync(out, html, "utf8");
    return text(`Dashboard written to ${out}\nOpen it in a browser to view your AI footprint.`);
  },
);

// ── serve_dashboard ───────────────────────────────────────────────────────────
let liveServer: { server: Server; port: number } | null = null;
server.registerTool(
  "serve_dashboard",
  {
    title: "Serve the live dashboard",
    description:
      "Start a local web server that serves an always-current dashboard (regenerates on every request, auto-refreshes). Returns a localhost URL to open. Calling again returns the existing URL.",
    inputSchema: {
      port: z.number().int().min(1).max(65535).optional().describe("Port (default 8799)."),
      refresh_seconds: z.number().int().min(0).max(3600).default(300).describe("Auto-refresh interval in seconds; 0 disables. Default 300 (5 min)."),
    },
  },
  async (a) => {
    if (!liveServer) {
      liveServer = await startDashboardServer({
        store,
        scenario: defaultScenario(),
        refreshSeconds: a.refresh_seconds ?? 300,
        port: a.port,
      });
    }
    const url = `http://localhost:${liveServer.port}`;
    return text(`Live dashboard running at ${url}\nOpen it in a browser — it auto-refreshes and always reflects your latest recorded usage.`);
  },
);

// ── methodology resource ──────────────────────────────────────────────────────
function readDoc(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "..", name), join(here, "..", "..", name)]) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* next */
    }
  }
  return "Methodology document not found.";
}

server.registerResource(
  "methodology",
  "impact://methodology",
  { title: "Impact methodology & sources", mimeType: "text/markdown" },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: readDoc("METHODOLOGY.md") }],
  }),
);

// ── boot ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel.
  console.error("ai-impact MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
