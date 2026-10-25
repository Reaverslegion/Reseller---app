// "Most I'll spend on one item" setting. Run: node tests/spend.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { cleanConfig } = new Function(src + "\nreturn { cleanConfig };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
t("no limit unless you set one", () => assert.equal(cleanConfig({}).rules.maxSpend, 0));
t("your limit is kept", () => assert.equal(cleanConfig({ rules: { maxSpend: 200 } }).rules.maxSpend, 200));
t("nonsense values become no limit", () => {
  for (const v of [-5, "abc", null]) assert.equal(cleanConfig({ rules: { maxSpend: v } }).rules.maxSpend, 0, String(v));
});
console.log(`\n${n} checks passed`);
