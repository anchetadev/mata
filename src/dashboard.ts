/**
 * Self-contained HTML dashboard generator. Reads the local store and produces a
 * single standalone .html file (inline CSS + inline SVG charts, no external
 * assets, no JS frameworks). Open it in any browser.
 */

import { ImpactStore } from "./store/db.js";
import { calculateImpact, aggregateImpact, type Scenario, type UsageRecord } from "./engine/index.js";

export interface DashboardOptions {
  scenario?: Scenario;
  /** Injected clock (epoch ms). */
  now?: number;
  /** Days of history to chart. */
  days?: number;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function fmtEnergy(kwh: number): string {
  return kwh >= 1 ? `${kwh.toFixed(2)} kWh` : `${(kwh * 1000).toFixed(1)} Wh`;
}
function fmtWater(l: number): string {
  return l >= 1 ? `${l.toFixed(1)} L` : `${(l * 1000).toFixed(0)} mL`;
}
function fmtMiles(mi: number): string {
  return mi >= 0.1 ? `${mi.toFixed(2)} mi` : `${(mi * 5280).toFixed(0)} ft`;
}

/** A horizontal bar chart as inline SVG. */
function barChart(rows: { label: string; value: number; sub: string }[], unit: string): string {
  if (rows.length === 0) return `<p class="empty">No data yet.</p>`;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = 34;
  const w = 760;
  const labelW = 150;
  const barMax = w - labelW - 90;
  const h = rows.length * rowH + 10;
  const bars = rows
    .map((r, i) => {
      const y = i * rowH + 6;
      const bw = Math.max(2, (r.value / max) * barMax);
      return `
      <text x="0" y="${y + 16}" class="bl">${esc(r.label.length > 22 ? r.label.slice(0, 21) + "…" : r.label)}</text>
      <rect x="${labelW}" y="${y + 4}" width="${bw}" height="18" rx="4" class="bar"/>
      <text x="${labelW + bw + 8}" y="${y + 17}" class="bv">${esc(r.sub)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${unit} by model">${bars}</svg>`;
}

/** A daily column chart as inline SVG. */
function columnChart(days: { label: string; value: number }[], unit: string): string {
  if (days.every((d) => d.value === 0)) return `<p class="empty">No activity in this window.</p>`;
  const max = Math.max(...days.map((d) => d.value), 1);
  const w = 760;
  const h = 180;
  const pad = 24;
  const cw = (w - pad * 2) / days.length;
  const cols = days
    .map((d, i) => {
      const ch = (d.value / max) * (h - 50);
      const x = pad + i * cw;
      const y = h - 24 - ch;
      const showLabel = i % Math.ceil(days.length / 8) === 0;
      return `
      <rect x="${x + 1}" y="${y}" width="${Math.max(1, cw - 2)}" height="${Math.max(0, ch)}" rx="2" class="col"/>
      ${showLabel ? `<text x="${x + cw / 2}" y="${h - 8}" class="ax">${esc(d.label)}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="daily ${unit}">${cols}</svg>`;
}

export function buildDashboardHtml(store: ImpactStore, opts: DashboardOptions = {}): string {
  const scenario: Scenario = opts.scenario ?? "midpoint";
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const dayMs = 86_400_000;

  const rollup = store.rollup(0, now);
  const records: UsageRecord[] = rollup.map((r) => ({
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens,
  }));
  const total = aggregateImpact(records, scenario);

  // By-model rows (sorted by carbon).
  const modelRows = rollup
    .map((r) => {
      const im = calculateImpact(
        { model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
        scenario,
      );
      return { label: r.model, value: im.co2eGrams, sub: `${im.co2eGrams.toFixed(1)} g · ${r.events} reqs`, energy: im.energyKwh };
    })
    .sort((a, b) => b.value - a.value);

  // Daily energy for the last `days`.
  const events = store.eventsSince(now - days * dayMs, now);
  const buckets = new Map<number, number>();
  for (const e of events) {
    const day = Math.floor(e.ts / dayMs);
    const im = calculateImpact({ model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens }, scenario);
    buckets.set(day, (buckets.get(day) ?? 0) + im.energyKwh);
  }
  const today = Math.floor(now / dayMs);
  const daily = Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i);
    const d = new Date(day * dayMs);
    return { label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, value: (buckets.get(day) ?? 0) * 1000 }; // Wh
  });

  const card = (icon: string, label: string, value: string) =>
    `<div class="card"><div class="ico">${icon}</div><div class="val">${value}</div><div class="lab">${label}</div></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mata — your AI footprint</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--fg:#e6edf3;--muted:#8b949e;--accent:#3fb950;--bar:#2ea043;--col:#388bfd}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:28px}
  h1{margin:0 0 2px;font-size:24px}.sub{color:var(--muted);margin:0 0 22px}
  .eye{color:var(--accent)}
  .cards{display:flex;flex-wrap:wrap;gap:14px;margin-bottom:26px}
  .card{background:var(--panel);border:1px solid #21262d;border-radius:12px;padding:16px 20px;min-width:150px;flex:1}
  .ico{font-size:20px}.val{font-size:26px;font-weight:700;margin-top:6px}.lab{color:var(--muted);font-size:13px}
  .panel{background:var(--panel);border:1px solid #21262d;border-radius:12px;padding:18px 20px;margin-bottom:20px}
  .panel h2{margin:0 0 14px;font-size:15px;font-weight:600;color:var(--fg)}
  .chart{width:100%;height:auto}
  .bl{fill:var(--fg);font-size:13px}.bv{fill:var(--muted);font-size:12px}.bar{fill:var(--bar)}
  .col{fill:var(--col)}.ax{fill:var(--muted);font-size:10px;text-anchor:middle}
  .empty{color:var(--muted)}
  footer{color:var(--muted);font-size:12px;margin-top:8px}
  code{background:#21262d;padding:1px 5px;border-radius:4px}
</style></head><body>
  <h1><span class="eye">👁 Mata</span> — your AI footprint</h1>
  <p class="sub">${total.tokensOut.toLocaleString()} output tokens across ${rollup.reduce((n, r) => n + r.events, 0).toLocaleString()} requests · <em>${scenario}</em> scenario</p>

  <div class="cards">
    ${card("⚡", "Energy", fmtEnergy(total.energyKwh))}
    ${card("🚗", "Miles driven (gas car)", fmtMiles(total.milesDriven))}
    ${card("💧", "Water (cooling)", fmtWater(total.waterLiters))}
    ${card("🌍", "CO₂e", `${(total.co2eGrams / 1000).toFixed(2)} kg`)}
    ${card("🔤", "Tokens out", total.tokensOut.toLocaleString())}
  </div>

  <div class="panel"><h2>Daily energy (last ${days} days, Wh)</h2>${columnChart(daily, "Wh")}</div>
  <div class="panel"><h2>Carbon by model</h2>${barChart(modelRows, "gCO₂e")}</div>

  <footer>
    Estimates via the EcoLogits LCA methodology (CC BY-SA 4.0); driving-miles per EPA (~400 gCO₂e/mi).
    Numbers are order-of-magnitude. Generated locally from <code>~/.ai-impact/usage.db</code> — nothing left your machine.
  </footer>
</body></html>`;
}
