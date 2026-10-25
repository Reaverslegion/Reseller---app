// Runs every FlipScout check and prints one summary. Run: node tests/run-all.mjs
import { spawnSync } from "node:child_process";
const files = ["finance.test.mjs", "autofill.test.mjs", "selftest.mjs"];
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [new URL(f, import.meta.url).pathname], { encoding: "utf8" });
  console.log(`\n=== ${f}: ${r.status === 0 ? "PASS" : "FAIL"} ===\n` + (r.stdout || "") + (r.stderr || ""));
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n${bad} test file(s) FAILED` : "\nAll test files PASSED");
process.exit(bad ? 1 : 0);
