/**
 * Per-provider datacenter configuration: PUE, on-site water (WUE), and default
 * deployment location (electricity zone). Values from EcoLogits' supplemental
 * material ("providers" tab). Ranges are collapsed to their midpoint.
 *
 * Source: https://ecologits.ai/latest/methodology/llm_inference/ (CC BY-SA 4.0)
 */

export interface ProviderConfig {
  /** Power Usage Effectiveness (datacenter cooling/overhead multiplier). */
  pue: number;
  /** On-site water usage effectiveness, liters per kWh. */
  wueOnSiteLPerKwh: number;
  /** Default electricity zone (ISO3 / WOR). */
  zone: string;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { pue: 1.115, wueOnSiteLPerKwh: 0.56, zone: "USA" }, // PUE 1.09–1.14, WUE 0.13–0.99
  cohere: { pue: 1.09, wueOnSiteLPerKwh: 0.99, zone: "USA" },
  google: { pue: 1.09, wueOnSiteLPerKwh: 0.99, zone: "USA" },
  google_genai: { pue: 1.09, wueOnSiteLPerKwh: 0.99, zone: "USA" },
  huggingface_hub: { pue: 1.115, wueOnSiteLPerKwh: 0.56, zone: "USA" },
  mistralai: { pue: 1.16, wueOnSiteLPerKwh: 0.09, zone: "SWE" },
  openai: { pue: 1.2, wueOnSiteLPerKwh: 0.569, zone: "USA" },
  azure_openai: { pue: 1.2, wueOnSiteLPerKwh: 0.569, zone: "USA" },
};

/** Sensible default for providers we don't have published data for. */
export const DEFAULT_PROVIDER: ProviderConfig = {
  pue: 1.2,
  wueOnSiteLPerKwh: 0.5,
  zone: "WOR",
};

export function providerConfig(provider: string): ProviderConfig {
  return PROVIDERS[provider.toLowerCase()] ?? DEFAULT_PROVIDER;
}
