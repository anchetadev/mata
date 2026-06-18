/**
 * Turns stored usage events into period reports with the four headline metrics.
 * Bridges the store (raw events) and the engine (impact math).
 */

import { ImpactStore, type RollupRow } from "./store/db.js";
import { aggregateImpact, formatImpact, type Scenario, type UsageRecord, type ImpactResult } from "./engine/index.js";

export type Period = "today" | "week" | "month" | "all";

/** Start-of-window epoch ms for a named period, given "now". */
export function periodStart(period: Period, now: number): number {
  const day = 24 * 60 * 60 * 1000;
  switch (period) {
    case "today":
      return now - day;
    case "week":
      return now - 7 * day;
    case "month":
      return now - 30 * day;
    case "all":
      return 0;
  }
}

export interface ReportLine {
  source: string;
  model: string;
  events: number;
  impact: ImpactResult;
}

export interface Report {
  period: Period;
  scenario: Scenario;
  total: ImpactResult;
  byModel: ReportLine[];
  eventCount: number;
}

/** Build a report for a period from the store. `now` is epoch ms (injected). */
export function buildReport(
  store: ImpactStore,
  period: Period,
  scenario: Scenario,
  now: number,
): Report {
  const since = periodStart(period, now);
  const rollup: RollupRow[] = store.rollup(since, now);

  const byModel: ReportLine[] = rollup.map((r) => {
    const rec: UsageRecord = {
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedInputTokens: r.cachedInputTokens,
    };
    return { source: r.source, model: r.model, events: r.events, impact: aggregateImpact([rec], scenario) };
  });

  const allRecords: UsageRecord[] = rollup.map((r) => ({
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens,
  }));

  return {
    period,
    scenario,
    total: aggregateImpact(allRecords, scenario),
    byModel,
    eventCount: byModel.reduce((n, l) => n + l.events, 0),
  };
}

/** Render a report as readable text for an MCP tool response. */
export function renderReport(r: Report): string {
  if (r.eventCount === 0) {
    return `No AI usage recorded for "${r.period}". Once a collector is running (or you log usage via the log_usage tool), this report will fill in.`;
  }
  const lines: string[] = [];
  lines.push(`# AI environmental impact — ${r.period} (${r.scenario} scenario)\n`);
  lines.push(`TOTAL: ${formatImpact(r.total)}`);
  lines.push(`Carbon split: ${r.total.co2eGramsUsage.toFixed(2)} g electricity + ${r.total.co2eGramsEmbodied.toFixed(2)} g hardware\n`);
  lines.push(`By model (${r.eventCount} requests):`);
  for (const l of r.byModel) {
    lines.push(`  • ${l.model} ×${l.events}: ${formatImpact(l.impact)}`);
  }
  return lines.join("\n");
}
