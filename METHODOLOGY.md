# Methodology, Sources & Attribution

This tool estimates the environmental impact of AI use by porting the
**[EcoLogits](https://ecologits.ai/) life-cycle-assessment methodology** to
TypeScript and running it locally on token-usage data we capture across the AI
clients you actually use. We add a consumer-friendly **driving-miles**
equivalence on top.

The numbers are order-of-magnitude estimates with wide error bars (especially
for closed models, whose architectures are inferred). Every result prints the
exact assumptions it used; nothing is a hidden constant.

## What we ported from EcoLogits

- **Inference energy model** — energy per output token as a function of a
  model's *active* parameters and batch size, fitted to the ML.ENERGY
  leaderboard (H100 / vLLM). Constants α, β, γ as published.
- **Server + datacenter model** — non-GPU server power, GPU-count-from-VRAM,
  PUE overhead, generation-latency model (per-model TPS/TTFT when available).
- **Usage impacts** — electricity → carbon (GWP), water (on-site WUE + off-site
  generation water), abiotic depletion (ADPe), primary energy (PE), using
  per-country electricity mixes.
- **Embodied impacts** — manufacturing of server + GPUs (Boavizta / ADEME data),
  amortized over a 3-year hardware lifetime by a utilization factor.
- **Data files** — `models.json` (per-model architecture estimates) and
  `electricity_mixes.json` (per-zone impact factors), vendored under
  `src/engine/data/`.

See [EcoLogits' LLM-inference methodology](https://ecologits.ai/latest/methodology/llm_inference/)
for the full derivation and figures.

## What we add

- **Driving-miles equivalence** — total CO₂e ÷ **400 gCO₂e/mile**
  ([US EPA](https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle),
  average passenger vehicle).
- **Scenarios** map onto EcoLogits' active-parameter uncertainty range:
  `conservative` = min active params, `midpoint` = mean, `high` = max.
- **Capture layer** (proxy + logs) so impact is measured across Claude Code,
  Codex, and any repointed API client — not just code you instrument by hand.

## Important notes / limitations

- **Input tokens do not affect energy.** Following EcoLogits, energy is driven
  by *output* tokens (autoregressive decode); prefill is not modeled. Input
  tokens are still recorded for reporting and efficiency scoring.
- **Closed-model parameters are estimated** by EcoLogits from leaks, benchmarks,
  and pricing. Models flagged `model-arch-not-released` carry that warning
  through to results.
- **Unknown models return zero + a warning**, never a fabricated number. New
  releases fall back to the closest same-family entry where possible.
- **Grid intensity is country-level** (default `WOR` / World), not your live
  local grid.
- Cross-validation: a ~300-output-token reply lands sub-watt-hour, the same
  order as Google's measured 0.24 Wh/prompt (arXiv:2508.15734) and Epoch AI's
  ~0.3 Wh GPT-4o estimate.

## Licensing & attribution

EcoLogits' methodology and data are licensed **CC BY-SA 4.0**. Because we port
that methodology and vendor its data, the derived material here inherits
**attribution + share-alike** obligations:

- Attribution: *EcoLogits, by GenAI Impact / CodeCarbon* — Rincé & Banse (2025),
  *EcoLogits: Evaluating the Environmental Impacts of Generative AI*, JOSS
  10(111):7471. <https://ecologits.ai/>
- The ported engine (`src/engine/`) and vendored data (`src/engine/data/`)
  should be distributed under **CC BY-SA 4.0**.

> ⚠️ This affects how we license the project overall — our own original code
> (capture layer, MCP server, efficiency scorer) can stay permissive, but the
> impact engine + data must carry CC BY-SA. Confirm the licensing split before
> publishing.
