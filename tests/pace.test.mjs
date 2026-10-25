// eBay daily-limit pacing for scheduled scans. Run: node tests/pace.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { paceSkip } = new Function(src + "\nreturn { paceSkip };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const at = (h) => Date.parse(`2026-10-25T${String(h).padStart(2, "0")}:00:00Z`), M = 60000;
t("normal day: scans run at your interval", () => {
  assert.equal(paceSkip(500, at(6), 8, 10, 10 * M), "");
  assert.equal(paceSkip(2400, at(12), 8, 10, 10 * M), "");
});
t("running ahead of the day's allowance: scans space out", () => {
  assert.equal(paceSkip(4000, at(12), 8, 10, 10 * M), "slowed to stay under eBay's daily limit");
  assert.equal(paceSkip(4000, at(12), 8, 10, 120 * M), "", "runs once enough time has passed");
});
t("limit reached: scans stop until the day resets", () => {
  assert.equal(paceSkip(4840, at(20), 8, 10, 999 * M), "eBay daily limit reached");
});
console.log(`\n${n} checks passed`);
