// Snapshot of 480 REAL eBay titles (40 per category, sampled from live listings on 26 Oct 2026), each reviewed by hand.
// "expect" is the model group FlipScout must give it (or BLOCKED / null). If a change alters any of these, this test fails:
// either the change is wrong, or the new answer is better and the snapshot is updated on purpose with a reason in the record.
// Run: node tests/real-titles.test.mjs
import fs from "node:fs";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { groupOf, RISK_WORDS, MULTI_VAR, FAKE_SSD };")();
const rows = JSON.parse(fs.readFileSync(new URL("./data/real-titles-2026-10-26.json", import.meta.url), "utf8"));
const out = (x) => { if (W.RISK_WORDS.test(x.title)) return "BLOCKED"; if (W.MULTI_VAR.test(x.title)) return "BLOCKED-multi"; if (W.FAKE_SSD(x.title)) return "BLOCKED-fake";
  const g = W.groupOf({ title: x.title }, x.cat, x.catName, x.bucket); return g ? g.key : null; };
const bad = rows.filter((x) => out(x) !== x.expect);
for (const x of bad.slice(0, 20)) console.log("✗", x.catName, "|", x.title.slice(0, 70), "| expected", x.expect, "got", out(x));
if (bad.length) { console.log(`\n${bad.length} of ${rows.length} real titles now match differently`); process.exit(1); }
console.log(`✓ all ${rows.length} real titles match as reviewed`);
