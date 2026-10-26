// Listings the hunter must never show as deals. Run: node tests/filters.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { RISK_WORDS, gpuKey } = new Function(src + "\nreturn { RISK_WORDS, gpuKey };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
t("parts, spares, faulty and sold-as-seen listings are blocked", () => {
  for (const x of ["Gigabyte GTX 1050 PARTS ONLY", "RTX 3070 for parts", "GTX 1080 spares or repair", "RX 580 faulty", "RTX 2060 sold as seen", "GTX 970 not tested", "Empty box RTX 3080", "RTX 3090 damaged fan"]) assert.ok(RISK_WORDS.test(x), x);
});
t("normal listings are not blocked", () => {
  for (const x of ["EVGA GTX 1080 Ti Founders Edition 11GB", "RTX 3060 12GB boxed with receipt", "Sapphire RX 6800 XT Nitro+"]) assert.ok(!RISK_WORDS.test(x), x);
});
t("laptop GPU chips and modules aren't priced as graphics cards", () => {
  for (const x of ["NVIDIA Quadro RTX 5000 Mobile GPU - N19E-Q5-A1", "Dell MXM GTX 1070 8GB module", "RTX 3060 laptop GPU chip"]) assert.equal(gpuKey(x), null, x);
  assert.ok(gpuKey("NVIDIA Quadro RTX 5000 16GB GDDR6 Graphics Card"), "a real card still matches");
});
t("heat sinks and coolers sold on their own aren't graphics cards", () => {
  for (const x of ["EVGA RTX 2080 TI HEAT SINK AND FUN ONLY BRAND NEW", "Palit Geforce RTX 3080/3080Ti GamingPro Cooler"]) assert.equal(gpuKey(x), null, x);
  assert.ok(gpuKey("MSI Mech OC AMD Radeon RX 5700 XT Dual Fan Graphics Card GPU"), "a card with fans is still a card");
});
t("changing your rules makes the next scan look back 3 days (raising £200 to £500 brings back skipped cards)", () => {
  assert.match(src, /wide = sig !== \(await kvGet\(env, "rulesSig", ""\)\)/);
  assert.match(src, /const back = wide \? 3 \* DAY : DAY/);
  assert.match(src, /await kvSet\(env, "rulesSig", JSON\.stringify\(\[r, cfg\.cats\.map\(\(c\) => c\.id\)\]\)\)/);
});
console.log(`\n${n} checks passed`);
