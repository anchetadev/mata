/**
 * EcoLogits LCA inference model, ported to TypeScript.
 *
 * Faithful implementation of the formulas at
 *   https://ecologits.ai/latest/methodology/llm_inference/  (CC BY-SA 4.0)
 *
 * Energy is driven by OUTPUT tokens and active parameters; input tokens are not
 * modeled (prefill is comparatively cheap and EcoLogits omits it). Total impact
 * = usage (electricity) + embodied (hardware manufacturing, amortized).
 *
 * All energy is computed in Wh internally and exposed in kWh.
 */

import type { ModelArchitecture, ElectricityMix } from "./data-loader.js";
import type { ProviderConfig } from "./providers.js";

// ── Fitted constants (ML.ENERGY leaderboard regressions) ───────────────────

/** Energy per output token: f_E(P,B) = α·e^(βB)·P + γ  [Wh], P in billions. */
const E_ALPHA = 1.17e-6;
const E_BETA = -1.12e-2;
const E_GAMMA = 4.05e-5;

/** Latency fallback per output token: f_L(P,B) = αP + βB + γ  [s]. */
const L_ALPHA = 6.78e-4;
const L_BETA = 3.12e-4;
const L_GAMMA = 1.94e-2;

/** Fixed serving batch size. */
const BATCH = 64;

// ── Hardware / datacenter constants ────────────────────────────────────────

const W_SERVER_NO_GPU = 1200; // watts (p5.48xlarge minus GPUs)
const GPUS_INSTALLED = 8;
const GPU_MEMORY_GB = 80; // H100 80GB
const QUANT_BITS = 16;
const SERVER_LIFETIME_S = 3 * 365.25 * 24 * 3600; // 3 years

/** Embodied impacts (manufacturing) of the base server, excluding GPUs. */
const SERVER_EMBODIED = { gwpKg: 5700, adpeKg: 0.37, peMj: 70000 };
/** Embodied impacts of one NVIDIA H100 80GB. */
const GPU_EMBODIED = { gwpKg: 273, adpeKg: 0.00895, peMj: 3721 };

/** Which point of the active-parameter range to use. */
export type ActivePoint = "min" | "mean" | "max";

export interface EcoImpact {
  energyKwh: number; // wall energy (E_request)
  co2eGramsUsage: number;
  co2eGramsEmbodied: number;
  co2eGramsTotal: number;
  waterLiters: number; // usage-phase only (embodied water unmodeled)
  adpeKgTotal: number; // abiotic resource depletion (Sb-eq)
  peMjTotal: number; // primary energy
  gpuCount: number;
  activeParamsB: number;
  generationLatencyS: number;
}

const expBetaBatch = Math.exp(E_BETA * BATCH);

/** Energy per output token (Wh) for a given active-param count (billions). */
function energyPerToken(activeParamsB: number): number {
  return E_ALPHA * expBetaBatch * activeParamsB + E_GAMMA;
}

/** Latency per output token (s) — fallback when no per-model deployment data. */
function latencyPerToken(activeParamsB: number): number {
  return L_ALPHA * activeParamsB + L_BETA * BATCH + L_GAMMA;
}

/** GPUs needed to hold the model in VRAM, rounded up to a power of two. */
function requiredGpus(totalParamsB: number): number {
  const memModelGb = 1.2 * totalParamsB * (QUANT_BITS / 8); // params(B)×bytes×overhead
  const raw = Math.ceil(memModelGb / GPU_MEMORY_GB);
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, raw))));
}

function pickActive(arch: ModelArchitecture, point: ActivePoint): number {
  const { min, max } = arch.activeParamsB;
  if (point === "min") return min;
  if (point === "max") return max;
  return (min + max) / 2;
}

/** Compute the full LCA impact for one request's worth of output tokens. */
export function computeEcoImpact(
  arch: ModelArchitecture,
  mix: ElectricityMix,
  provider: ProviderConfig,
  outputTokens: number,
  point: ActivePoint = "mean",
): EcoImpact {
  const activeParamsB = pickActive(arch, point);
  const tokens = Math.max(0, outputTokens);
  const gpus = requiredGpus(arch.totalParamsB);

  // Generation latency: prefer measured tps/ttft, else fitted fallback.
  const latencyS =
    arch.tps && arch.ttft
      ? arch.ttft + tokens / arch.tps
      : tokens * latencyPerToken(activeParamsB);

  // Energy (Wh).
  const eGpuWh = tokens * energyPerToken(activeParamsB); // per GPU
  const eServerNoGpuWh = ((W_SERVER_NO_GPU * latencyS) / 3600) * (gpus / GPUS_INSTALLED) / BATCH;
  const eServerWh = eServerNoGpuWh + gpus * eGpuWh;
  const eRequestWh = provider.pue * eServerWh;

  const energyKwh = eRequestWh / 1000;
  const eServerKwh = eServerWh / 1000;

  // Usage-phase impacts.
  const co2eGramsUsage = energyKwh * mix.gridGco2ePerKwh;
  const waterLiters = eServerKwh * (provider.wueOnSiteLPerKwh + provider.pue * mix.wueOffSiteLPerKwh);
  const adpeUsage = energyKwh * mix.adpePerKwh;
  const peUsage = energyKwh * mix.peMjPerKwh;

  // Embodied impacts, amortized over hardware lifetime by utilization factor.
  const alloc = latencyS / (BATCH * SERVER_LIFETIME_S);
  const serverGwpKg = (gpus / GPUS_INSTALLED) * SERVER_EMBODIED.gwpKg + gpus * GPU_EMBODIED.gwpKg;
  const serverAdpeKg = (gpus / GPUS_INSTALLED) * SERVER_EMBODIED.adpeKg + gpus * GPU_EMBODIED.adpeKg;
  const serverPeMj = (gpus / GPUS_INSTALLED) * SERVER_EMBODIED.peMj + gpus * GPU_EMBODIED.peMj;

  const co2eGramsEmbodied = alloc * serverGwpKg * 1000;
  const adpeEmbodied = alloc * serverAdpeKg;
  const peEmbodied = alloc * serverPeMj;

  return {
    energyKwh,
    co2eGramsUsage,
    co2eGramsEmbodied,
    co2eGramsTotal: co2eGramsUsage + co2eGramsEmbodied,
    waterLiters,
    adpeKgTotal: adpeUsage + adpeEmbodied,
    peMjTotal: peUsage + peEmbodied,
    gpuCount: gpus,
    activeParamsB,
    generationLatencyS: latencyS,
  };
}
