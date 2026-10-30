// The "not verified yet" safety net. Run: node tests/verified.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { VERIFIED_CATS } = new Function(src + "\nreturn { VERIFIED_CATS };")();
const rows = JSON.parse(fs.readFileSync(new URL("./data/real-titles-2026-10-26.json", import.meta.url), "utf8"));
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
t("every verified category has a check date", () => {
  for (const [id, d] of Object.entries(VERIFIED_CATS)) { assert.match(id, /^\d+$/); assert.match(d, /^\d{4}-\d{2}-\d{2}$/); }
});
t("only categories with hand-checked titles in the tests are marked verified", () => {
  const tested = new Set(rows.map((r) => String(r.cat)));
  for (const id of Object.keys(VERIFIED_CATS)) assert.ok(tested.has(id), "category " + id + " is marked verified but has no checked titles in tests/data");
});
t("deals from unchecked categories are capped and never alerted (rules are in the code)", () => {
  assert.match(src, /if \(!verified\) \{ score = Math\.min\(score, r\.alertScore - 1, 69\); tags\.push\("Not verified yet"\); \}/);
  assert.match(src, /!VERIFIED_CATS\[String\(d\.cat\)\]\) continue; \/\/ never alert on unchecked categories/);
});
t("very cheap Buy It Now deals are capped and so never alerted", () => {
  assert.match(src, /const VERY_CHEAP = 0\.6, HIDE_BELOW = 0\.4;/);
  assert.match(src, /if \(veryCheap\) \{ score = Math\.min\(score, r\.alertScore - 1, 69\); tags\.push\("Very cheap"\); \}/);
});
console.log(`\n${n} checks passed`);
