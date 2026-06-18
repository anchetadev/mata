/**
 * Run the efficiency coach over REAL Claude Code session transcripts.
 *
 * Reads the JSONL (user + assistant message text and per-turn output tokens),
 * extracts turns, and scores them. Text is read on-demand for analysis only —
 * never persisted.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { listSessionFiles, defaultProjectsDir } from "../collectors/claude-code.js";
import { scoreEfficiency, type Turn, type EfficiencyResult } from "./score.js";

/** Concatenate the visible text from a message `content` (string or blocks). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as any).type === "text")
    .map((b) => (b as any).text ?? "")
    .join("\n")
    .trim();
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b && (b as any).type === "tool_result");
}

// Slash-command invocations / command output wrappers — not genuine prompts.
const COMMAND_WRAPPER_RE = /^\s*<(command-name|command-message|command-args|local-command-stdout)/;

/** Sum output tokens for an assistant entry, handling the iterations quirk. */
function outputTokens(usage: any): number {
  if (!usage) return 0;
  if (Array.isArray(usage.iterations) && usage.iterations.length) {
    return usage.iterations.reduce((s: number, it: any) => s + (Number(it.output_tokens) || 0), 0);
  }
  return Number(usage.output_tokens) || 0;
}

/** Extract ordered conversation turns (genuine prompts + visible replies). */
export function extractSessionTurns(filePath: string): Turn[] {
  const text = readFileSync(filePath, "utf8");
  const turns: Turn[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o?.message?.content;
    if (o?.type === "user") {
      if (o.isCompactSummary || o.isMeta || hasToolResult(content)) continue; // not a human turn
      const t = extractText(content);
      if (t && !COMMAND_WRAPPER_RE.test(t)) turns.push({ role: "user", text: t });
    } else if (o?.type === "assistant") {
      const t = extractText(content);
      const out = outputTokens(o.message?.usage);
      if (t) turns.push({ role: "assistant", text: t, outputTokens: out });
    }
  }
  return turns;
}

export interface SessionAnalysis {
  sessionId: string;
  title: string;
  userTurns: number;
  totalOutputTokens: number;
  result: EfficiencyResult;
}

function deriveTitle(turns: Turn[]): string {
  const first = turns.find((t) => t.role === "user")?.text ?? "";
  const words = first.trim().split(/\s+/).slice(0, 8).join(" ");
  return words.length > 60 ? words.slice(0, 57) + "…" : words || "(untitled)";
}

/** Analyze one session file. Returns null if it has no genuine user turns. */
export function analyzeSession(filePath: string): SessionAnalysis | null {
  const turns = extractSessionTurns(filePath);
  const userTurns = turns.filter((t) => t.role === "user").length;
  if (userTurns === 0) return null;
  const totalOutputTokens = turns.reduce((s, t) => s + (t.outputTokens ?? 0), 0);
  return {
    sessionId: basename(filePath).replace(/\.jsonl$/, ""),
    title: deriveTitle(turns),
    userTurns,
    totalOutputTokens,
    result: scoreEfficiency(turns),
  };
}

export interface EfficiencyOverview {
  sessionsAnalyzed: number;
  averageScore: number;
  totalReworkWastedTokens: number;
  worst: SessionAnalysis | null;
  best: SessionAnalysis | null;
  sessions: SessionAnalysis[];
  topTips: string[];
}

/** Analyze the most recently active sessions and summarize. */
export function analyzeRecentSessions(
  dir: string = defaultProjectsDir(),
  limit = 5,
): EfficiencyOverview {
  const files = listSessionFiles(dir)
    .map((f) => ({ f, mtime: safeMtime(f) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.f);

  const sessions = files.map(analyzeSession).filter((s): s is SessionAnalysis => s !== null);

  if (sessions.length === 0) {
    return { sessionsAnalyzed: 0, averageScore: 0, totalReworkWastedTokens: 0, worst: null, best: null, sessions: [], topTips: [] };
  }

  const averageScore = Math.round(sessions.reduce((s, x) => s + x.result.score, 0) / sessions.length);
  const totalReworkWastedTokens = sessions.reduce((s, x) => s + x.result.metrics.reworkWastedTokens, 0);
  const sorted = [...sessions].sort((a, b) => a.result.score - b.result.score);

  // Most common tip across sessions.
  const tipCounts = new Map<string, number>();
  for (const s of sessions) for (const t of s.result.tips) tipCounts.set(t, (tipCounts.get(t) ?? 0) + 1);
  const topTips = [...tipCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);

  return {
    sessionsAnalyzed: sessions.length,
    averageScore,
    totalReworkWastedTokens,
    worst: sorted[0],
    best: sorted[sorted.length - 1],
    sessions,
    topTips,
  };
}

function safeMtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
