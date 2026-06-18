/**
 * Loads EcoLogits' open datasets (models.json, electricity_mixes.json) and
 * resolves a free-form model id to the architecture + deployment + provider
 * facts the LCA engine needs.
 *
 * Data source: https://github.com/mlco2/ecologits (CC BY-SA 4.0). We port the
 * data verbatim and keep it local — see METHODOLOGY.md for attribution.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Read a data file, tolerating both dev (src/) and built (dist/) layouts. */
function readData(file: string): string {
  const candidates = [
    join(here, "data", file), // co-located (normal case)
    join(here, "..", "..", "src", "engine", "data", file), // dist -> src fallback
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  throw new Error(`Could not locate data file "${file}" (looked in: ${candidates.join(", ")})`);
}

// ── Raw shapes as they appear in EcoLogits JSON ────────────────────────────

interface RawRange {
  min: number;
  max: number;
}
interface RawArchitecture {
  type: "dense" | "moe";
  /** Billions of params. Number for dense/simple MoE, object for proprietary. */
  parameters: number | { total: number; active: number | RawRange };
  active_parameters?: number;
}
interface RawModel {
  type: "model";
  provider: string;
  name: string;
  architecture: RawArchitecture;
  deployment?: { tps: number; ttft: number };
  warnings?: string[] | null;
}
interface RawAlias {
  type: "alias";
  provider: string;
  name: string;
  alias: string;
}
interface RawElectricityMix {
  name: string;
  /** kgCO2e per kWh. */
  gwp: number;
  /** kgSbeq per kWh (abiotic depletion). */
  adpe: number;
  /** MJ per kWh (primary energy). */
  pe: number;
  /** Off-site water from electricity generation, liters per kWh. */
  wue: number;
}

// ── Normalized shapes the engine consumes ──────────────────────────────────

/** Active-parameter estimate in billions; a range for proprietary models. */
export interface ActiveParams {
  min: number;
  max: number;
}

export interface ModelArchitecture {
  provider: string;
  name: string;
  isMoe: boolean;
  /** Total parameters in billions (determines GPU memory / count). */
  totalParamsB: number;
  /** Active parameters in billions (determines per-token energy). */
  activeParamsB: ActiveParams;
  /** Per-model latency stats when EcoLogits has them (else undefined). */
  tps?: number;
  ttft?: number;
  warnings: string[];
}

export interface ElectricityMix {
  zone: string;
  /** gCO2e per kWh. */
  gridGco2ePerKwh: number;
  adpePerKwh: number;
  peMjPerKwh: number;
  /** Off-site water, liters per kWh. */
  wueOffSiteLPerKwh: number;
}

// ── Lazy singletons ────────────────────────────────────────────────────────

let modelsIndex: Map<string, ModelArchitecture> | null = null;
let aliasIndex: Map<string, string> | null = null;
let mixIndex: Map<string, ElectricityMix> | null = null;

function normalizeArch(m: RawModel): ModelArchitecture {
  const arch = m.architecture;
  let totalParamsB: number;
  let activeParamsB: ActiveParams;

  if (typeof arch.parameters === "number") {
    // Dense, or simple MoE with separate active_parameters.
    totalParamsB = arch.parameters;
    const active = arch.active_parameters ?? arch.parameters;
    activeParamsB = { min: active, max: active };
  } else {
    const p = arch.parameters as { total?: number; active?: number | RawRange; min?: number; max?: number };
    // `total` may be absent if `parameters` is itself a {min,max} range.
    totalParamsB = p.total ?? p.max ?? p.min ?? 0;
    const a = p.active ?? arch.active_parameters;
    if (a == null) {
      // No active estimate: dense-like, use total.
      activeParamsB = { min: totalParamsB, max: totalParamsB };
    } else if (typeof a === "number") {
      activeParamsB = { min: a, max: a };
    } else {
      activeParamsB = { min: a.min, max: a.max };
    }
  }

  return {
    provider: m.provider,
    name: m.name,
    isMoe: arch.type === "moe",
    totalParamsB,
    activeParamsB,
    tps: m.deployment?.tps,
    ttft: m.deployment?.ttft,
    warnings: m.warnings ?? [],
  };
}

function loadModels(): void {
  if (modelsIndex) return;
  const raw = JSON.parse(readData("models.json")) as {
    aliases: RawAlias[];
    models: RawModel[];
  };
  modelsIndex = new Map();
  aliasIndex = new Map();
  for (const m of raw.models) {
    modelsIndex.set(`${m.provider}/${m.name}`.toLowerCase(), normalizeArch(m));
    modelsIndex.set(m.name.toLowerCase(), normalizeArch(m)); // also index bare name
  }
  for (const a of raw.aliases) {
    aliasIndex.set(a.name.toLowerCase(), a.alias.toLowerCase());
    aliasIndex.set(a.alias.toLowerCase(), a.name.toLowerCase());
  }
}

function loadMixes(): void {
  if (mixIndex) return;
  const raw = JSON.parse(readData("electricity_mixes.json")) as {
    electricity_mixes: RawElectricityMix[];
  };
  mixIndex = new Map();
  for (const z of raw.electricity_mixes) {
    mixIndex.set(z.name.toUpperCase(), {
      zone: z.name,
      gridGco2ePerKwh: z.gwp * 1000, // kg -> g
      adpePerKwh: z.adpe,
      peMjPerKwh: z.pe,
      wueOffSiteLPerKwh: z.wue,
    });
  }
}

/**
 * Resolve a model id to its architecture. Tries exact, alias, then a
 * family-prefix fallback (e.g. an unknown "claude-opus-4-8" matches the
 * closest "claude-opus-*" entry) so new releases still get a sane estimate.
 */
export function resolveModel(model: string): ModelArchitecture | null {
  loadModels();
  const key = model.toLowerCase();
  const idx = modelsIndex!;

  if (idx.has(key)) return idx.get(key)!;
  const alias = aliasIndex!.get(key);
  if (alias && idx.has(alias)) return idx.get(alias)!;

  // Family fallback: longest shared prefix among same-family model keys.
  const family = key.replace(/[-_]?\d.*$/, ""); // strip trailing version, e.g. claude-opus
  if (family.length >= 4) {
    let best: ModelArchitecture | null = null;
    for (const [k, v] of idx) {
      if (k.startsWith(family)) {
        // Prefer the entry whose name shares the most characters.
        if (!best || k.length > `${best.provider}/${best.name}`.length) best = v;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Resolve an electricity zone (ISO3 / WOR / EEE). Falls back to World. */
export function resolveMix(zone: string = "WOR"): ElectricityMix {
  loadMixes();
  return mixIndex!.get(zone.toUpperCase()) ?? mixIndex!.get("WOR")!;
}
