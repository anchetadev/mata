/**
 * Public domain types. Provider-agnostic: a usage record is a token count for
 * a named model; how it was captured is the collector's concern.
 */

/** A normalized usage record — the unit the engine operates on. */
export interface UsageRecord {
  /** Model identifier, e.g. "claude-opus-4-5", "gpt-4o". Resolved to EcoLogits data. */
  model: string;
  /** Prompt/input tokens. Reported but NOT used for energy (EcoLogits omits prefill). */
  inputTokens: number;
  /** Completion/output tokens — the energy driver. */
  outputTokens: number;
  /** Cached input tokens (reported only). */
  cachedInputTokens?: number;
}

/**
 * Confidence scenario. EcoLogits expresses proprietary-model uncertainty as a
 * range of active parameters; we map scenarios onto that range:
 *   conservative → min active params, midpoint → mean, high → max.
 */
export type Scenario = "conservative" | "midpoint" | "high";

/** The computed environmental impact for a usage record (or aggregate). */
export interface ImpactResult {
  /** Wall energy (IT load × PUE), kilowatt-hours. */
  energyKwh: number;
  /** Total GHG emissions (usage + embodied), grams CO2-equivalent. */
  co2eGrams: number;
  /** Split of the above, for transparency. */
  co2eGramsUsage: number;
  co2eGramsEmbodied: number;
  /** Usage-phase water (on-site cooling + off-site generation), liters. */
  waterLiters: number;
  /** Equivalent miles driven by an average gas passenger vehicle. */
  milesDriven: number;
  /** Abiotic resource depletion, kg antimony-eq (mineral/metal use). */
  adpeKg: number;
  /** Primary energy, megajoules. */
  peMj: number;
  tokensIn: number;
  tokensOut: number;
  assumptions: AppliedAssumptions;
}

/** The exact assumptions applied to a calculation, surfaced in every result. */
export interface AppliedAssumptions {
  scenario: Scenario;
  /** Resolved model name (may differ from input via alias/family fallback). */
  resolvedModel: string;
  modelMatch: "exact" | "family-fallback" | "unknown";
  provider: string;
  /** Electricity zone used (ISO3 / WOR). */
  zone: string;
  isMoe: boolean;
  totalParamsB: number;
  activeParamsB: number;
  gpuCount: number;
  pue: number;
  gridGco2ePerKwh: number;
  carGramsPerMile: number;
  /** Non-fatal data warnings (e.g. model arch not officially released). */
  warnings: string[];
}
