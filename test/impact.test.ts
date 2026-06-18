import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateImpact, aggregateImpact, resolveModel, resolveMix } from "../src/engine/index.js";

test("resolves a known proprietary model from EcoLogits data", () => {
  const arch = resolveModel("claude-sonnet-4-5-20250929");
  assert.ok(arch, "should resolve");
  assert.equal(arch!.provider, "anthropic");
  assert.equal(arch!.isMoe, true);
  assert.ok(arch!.totalParamsB > 0);
});

test("family fallback resolves an unreleased model version", () => {
  // claude-opus-4-8 isn't in the dataset; should fall back to the opus family.
  const arch = resolveModel("claude-opus-4-8");
  assert.ok(arch, "should fall back to opus family");
  assert.match(arch!.name, /opus/);
});

test("unknown model yields zeros + an explicit warning, not a fake number", () => {
  const r = calculateImpact({ model: "totally-made-up-model-xyz", inputTokens: 100, outputTokens: 500 });
  assert.equal(r.energyKwh, 0);
  assert.equal(r.assumptions.modelMatch, "unknown");
  assert.ok(r.assumptions.warnings.length > 0);
});

test("scenarios are monotonic for an MoE range: conservative <= midpoint <= high", () => {
  const u = { model: "claude-opus-4-5", inputTokens: 1000, outputTokens: 1000 };
  const c = calculateImpact(u, "conservative").energyKwh;
  const m = calculateImpact(u, "midpoint").energyKwh;
  const h = calculateImpact(u, "high").energyKwh;
  assert.ok(c <= m && m <= h, `expected ${c} <= ${m} <= ${h}`);
  assert.ok(h > c, "range should be non-degenerate for an MoE model");
});

test("more output tokens => more energy", () => {
  const small = calculateImpact({ model: "gpt-4o", inputTokens: 0, outputTokens: 100 }).energyKwh;
  const big = calculateImpact({ model: "gpt-4o", inputTokens: 0, outputTokens: 2000 }).energyKwh;
  assert.ok(big > small);
});

test("total carbon = usage + embodied, and miles uses the EPA 400 g/mi anchor", () => {
  const r = calculateImpact({ model: "claude-sonnet-4-5", inputTokens: 500, outputTokens: 800 }, "midpoint");
  assert.ok(Math.abs(r.co2eGrams - (r.co2eGramsUsage + r.co2eGramsEmbodied)) < 1e-9);
  assert.ok(Math.abs(r.milesDriven - r.co2eGrams / 400) < 1e-9);
});

test("electricity zone override changes carbon (grid intensity)", () => {
  const u = { model: "gpt-4o", inputTokens: 0, outputTokens: 1000 };
  const usa = calculateImpact(u, "midpoint", { zone: "USA" }).co2eGramsUsage;
  const fra = calculateImpact(u, "midpoint", { zone: "FRA" }).co2eGramsUsage; // France ~ nuclear, low
  assert.ok(fra < usa, `expected France (${fra}) < USA (${usa})`);
});

test("aggregate equals sum of parts", () => {
  const recs = [
    { model: "gpt-4o", inputTokens: 100, outputTokens: 200 },
    { model: "claude-opus-4-5", inputTokens: 300, outputTokens: 400 },
  ];
  const agg = aggregateImpact(recs, "midpoint");
  const sum =
    calculateImpact(recs[0], "midpoint").energyKwh + calculateImpact(recs[1], "midpoint").energyKwh;
  assert.ok(Math.abs(agg.energyKwh - sum) < 1e-12);
  assert.equal(agg.tokensOut, 600);
});

test("World electricity mix exists", () => {
  const mix = resolveMix("WOR");
  assert.ok(mix.gridGco2ePerKwh > 0);
});
