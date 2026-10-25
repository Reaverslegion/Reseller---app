// Scan service key check. Run: node tests/security.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { sameKey } = new Function(src + "\nreturn { sameKey };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
t("the right key is accepted", () => assert.equal(sameKey("abc123XYZ", "abc123XYZ"), true));
t("wrong, shorter, longer, empty or missing keys are refused", () => {
  for (const k of ["abc123XYz", "abc123XY", "abc123XYZ0", "", null, undefined, "a"]) assert.equal(sameKey(k, "abc123XYZ"), false, String(k));
});
t("a key that repeats the real one isn't accepted", () => assert.equal(sameKey("abcabc", "abc"), false));
console.log(`\n${n} checks passed`);
