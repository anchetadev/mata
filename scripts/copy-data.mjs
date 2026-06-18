// Copies the EcoLogits JSON datasets into dist/ after tsc (tsc doesn't copy
// non-TS assets). Keeps the built server self-contained.
import { mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "engine", "data");
const outDir = join(root, "dist", "engine", "data");

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(srcDir)) {
  copyFileSync(join(srcDir, f), join(outDir, f));
  console.log(`copied ${f}`);
}
