/**
 * Public impact API. Resolves a model + electricity zone, runs the EcoLogits
 * LCA engine, and adds the consumer-friendly driving-miles equivalence.
 */

import type { UsageRecord, ImpactResult, Scenario, AppliedAssumptions } from "./types.js";
import { resolveModel, resolveMix } from "./data-loader.js";
import { providerConfig, DEFAULT_PROVIDER } from "./providers.js";
import { computeEcoImpact, type ActivePoint } from "./ecologits.js";

/** EPA: average passenger vehicle emits ~400 gCO2e per mile (tailpipe). */
export const CAR_GRAMS_PER_MILE = 400;

export const DEFAULT_SCENARIO: Scenario = "midpoint";

const SCENARIO_TO_POINT: Record<Scenario, ActivePoint> = {
  conservative: "min",
  midpoint: "mean",
  high: "max",
};

export interface CalcOptions {
  /** Electricity zone override (ISO3 / WOR). Defaults to the provider's region. */
  zone?: string;
}

/** Compute environmental impact for a single usage record. */
export function calculateImpact(
  usage: UsageRecord,
  scenario: Scenario = DEFAULT_SCENARIO,
  opts: CalcOptions = {},
): ImpactResult {
  const arch = resolveModel(usage.model);
  const point = SCENARIO_TO_POINT[scenario];

  if (!arch) {
    // Unknown model: return zeros but make the gap explicit rather than guessing.
    return zeroResult(usage, scenario, "unknown");
  }

  const provider = providerConfig(arch.provider);
  const zone = opts.zone ?? provider.zone;
  const mix = resolveMix(zone);

  const eco = computeEcoImpact(arch, mix, provider, usage.outputTokens, point);
  const milesDriven = eco.co2eGramsTotal / CAR_GRAMS_PER_MILE;

  // Exact if the input is the model name or a dated-alias of it (one is a
  // prefix of the other, e.g. "claude-opus-4-5" ⇄ "claude-opus-4-5-20251101").
  const inName = usage.model.toLowerCase();
  const resName = arch.name.toLowerCase();
  const modelMatch =
    resName === inName || resName.startsWith(inName) || inName.startsWith(resName)
      ? "exact"
      : "family-fallback";

  const assumptions: AppliedAssumptions = {
    scenario,
    resolvedModel: `${arch.provider}/${arch.name}`,
    modelMatch,
    provider: arch.provider,
    zone: mix.zone,
    isMoe: arch.isMoe,
    totalParamsB: arch.totalParamsB,
    activeParamsB: eco.activeParamsB,
    gpuCount: eco.gpuCount,
    pue: provider.pue,
    gridGco2ePerKwh: mix.gridGco2ePerKwh,
    carGramsPerMile: CAR_GRAMS_PER_MILE,
    warnings: arch.warnings,
  };

  return {
    energyKwh: eco.energyKwh,
    co2eGrams: eco.co2eGramsTotal,
    co2eGramsUsage: eco.co2eGramsUsage,
    co2eGramsEmbodied: eco.co2eGramsEmbodied,
    waterLiters: eco.waterLiters,
    milesDriven,
    adpeKg: eco.adpeKgTotal,
    peMj: eco.peMjTotal,
    tokensIn: Math.max(0, usage.inputTokens),
    tokensOut: Math.max(0, usage.outputTokens),
    assumptions,
  };
}

function zeroResult(usage: UsageRecord, scenario: Scenario, match: "unknown"): ImpactResult {
  return {
    energyKwh: 0,
    co2eGrams: 0,
    co2eGramsUsage: 0,
    co2eGramsEmbodied: 0,
    waterLiters: 0,
    milesDriven: 0,
    adpeKg: 0,
    peMj: 0,
    tokensIn: Math.max(0, usage.inputTokens),
    tokensOut: Math.max(0, usage.outputTokens),
    assumptions: {
      scenario,
      resolvedModel: usage.model,
      modelMatch: match,
      provider: "unknown",
      zone: DEFAULT_PROVIDER.zone,
      isMoe: false,
      totalParamsB: 0,
      activeParamsB: 0,
      gpuCount: 0,
      pue: DEFAULT_PROVIDER.pue,
      gridGco2ePerKwh: 0,
      carGramsPerMile: CAR_GRAMS_PER_MILE,
      warnings: [`Model "${usage.model}" not found in EcoLogits dataset; impact not estimated.`],
    },
  };
}

/** Sum impacts across many usage records (e.g. a whole session or a day). */
export function aggregateImpact(
  records: UsageRecord[],
  scenario: Scenario = DEFAULT_SCENARIO,
  opts: CalcOptions = {},
): ImpactResult {
  const results = records.map((r) => calculateImpact(r, scenario, opts));
  const sum = results.reduce(
    (acc, r) => {
      acc.energyKwh += r.energyKwh;
      acc.co2eGrams += r.co2eGrams;
      acc.co2eGramsUsage += r.co2eGramsUsage;
      acc.co2eGramsEmbodied += r.co2eGramsEmbodied;
      acc.waterLiters += r.waterLiters;
      acc.milesDriven += r.milesDriven;
      acc.adpeKg += r.adpeKg;
      acc.peMj += r.peMj;
      acc.tokensIn += r.tokensIn;
      acc.tokensOut += r.tokensOut;
      return acc;
    },
    {
      energyKwh: 0, co2eGrams: 0, co2eGramsUsage: 0, co2eGramsEmbodied: 0,
      waterLiters: 0, milesDriven: 0, adpeKg: 0, peMj: 0, tokensIn: 0, tokensOut: 0,
    },
  );

  const models = [...new Set(results.map((r) => r.assumptions.resolvedModel))];
  const warnings = [...new Set(results.flatMap((r) => r.assumptions.warnings))];

  return {
    ...sum,
    assumptions: {
      scenario,
      resolvedModel: models.length === 1 ? models[0] : `${models.length} models`,
      modelMatch: "exact",
      provider: "mixed",
      zone: "mixed",
      isMoe: false,
      totalParamsB: 0,
      activeParamsB: 0,
      gpuCount: 0,
      pue: 0,
      gridGco2ePerKwh: 0,
      carGramsPerMile: CAR_GRAMS_PER_MILE,
      warnings,
    },
  };
}

/** Human-readable one-liner for any result. */
export function formatImpact(r: ImpactResult): string {
  const wh = r.energyKwh * 1000;
  const energy = r.energyKwh >= 1 ? `${r.energyKwh.toFixed(3)} kWh` : `${wh.toFixed(2)} Wh`;
  const water = r.waterLiters >= 1 ? `${r.waterLiters.toFixed(2)} L` : `${(r.waterLiters * 1000).toFixed(1)} mL`;
  const miles = r.milesDriven >= 0.1 ? `${r.milesDriven.toFixed(2)} mi` : `${(r.milesDriven * 5280).toFixed(0)} ft`;
  return (
    `⚡ ${energy}  ·  🚗 ${miles}  ·  💧 ${water}  ·  ` +
    `🌍 ${r.co2eGrams.toFixed(2)} gCO₂e  ·  🔤 ${r.tokensIn.toLocaleString()} in / ${r.tokensOut.toLocaleString()} out ` +
    `(${r.assumptions.scenario})`
  );
}
