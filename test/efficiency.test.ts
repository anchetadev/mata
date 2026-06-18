import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreEfficiency } from "../src/efficiency/score.js";

test("a clean, well-specified single exchange scores high", () => {
  const r = scoreEfficiency([
    {
      role: "user",
      text: "Write a Python CLI that reads a CSV at path X, sums column 'total', and prints it. Use argparse. No external deps.",
    },
    { role: "assistant", text: "Here is the script. Done." },
  ]);
  assert.ok(r.score >= 90, `expected high score, got ${r.score}`);
  assert.equal(r.grade, "A");
});

test("rework and clarification loops lower the score", () => {
  const r = scoreEfficiency([
    { role: "user", text: "make a thing" },
    { role: "assistant", text: "Could you clarify what kind of thing?" },
    { role: "user", text: "no, actually I meant a CLI tool" },
    { role: "assistant", text: "Done." },
  ]);
  assert.ok(r.score < 90, `expected penalty, got ${r.score}`);
  assert.equal(r.metrics.reworkSignals, 1);
  assert.equal(r.metrics.clarificationQuestions, 1);
});

test("many turns push toward a lower grade", () => {
  const turns = Array.from({ length: 16 }, (_, i) =>
    i % 2 === 0 ? { role: "user" as const, text: "do more" } : { role: "assistant" as const, text: "ok" },
  );
  const r = scoreEfficiency(turns);
  assert.ok(r.score < 75, `expected sub-B for a long back-and-forth, got ${r.score}`);
});
