// The app must receive every deal, and must say so if it ever doesn't (3 Nov 2026: a hidden "best 200" cap meant
// 841 deals in the database but 192 on screen). Run: node tests/no-hidden-caps.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const w = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8"), app = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
t("deals sent to the app and re-judged use the shared limit, not a small fixed cap", () => {
  assert.doesNotMatch(w, /FROM deals WHERE expires>\? ORDER BY score DESC LIMIT \d/);
  assert.doesNotMatch(w, /JOIN listings l ON l\.id = d\.id WHERE d\.expires > \? LIMIT \d/);
  assert.ok(+w.match(/const DEALS_MAX = (\d+)/)[1] >= 2000);
});
t("the app is told the true total and warns when fewer arrive", () => {
  assert.match(w, /json\(\{ deals, dealsTotal,/);
  assert.match(app, /HD\.dealsTotal&&\(HD\.deals\|\|\[\]\)\.length<HD\.dealsTotal/);
});
console.log(`\n${n} checks passed`);
