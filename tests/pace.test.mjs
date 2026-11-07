// eBay daily-limit pacing for scheduled scans. Run: node tests/pace.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { paceSkip, autoInterval, cleanConfig, ebayDay, minsToEbayReset } = new Function(src + "\nreturn { paceSkip, autoInterval, cleanConfig, ebayDay, minsToEbayReset };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
// hours into eBay's day (eBay's day starts at midnight US Pacific); lim = eBay's daily calls and minutes until its reset
const M = 60000, into = (h) => ({ daily: 5000, minsLeft: 1440 - h * 60 }), now = Date.parse("2026-11-07T12:00:00Z");
t("normal day: scans run at your interval", () => {
  assert.equal(paceSkip(500, now, 8, 10, 10 * M, into(6)), "");
  assert.equal(paceSkip(2200, now, 8, 10, 10 * M, into(12)), "");
});
t("running ahead of the day's allowance: scans space out", () => {
  assert.equal(paceSkip(3800, now, 8, 10, 10 * M, into(12)), "slowed to stay under eBay's daily limit");
  assert.equal(paceSkip(3800, now, 8, 10, 120 * M, into(12)), "", "runs once enough time has passed");
});
t("automatic scans stop at 90% of the day (the last 10% is kept for your phone)", () => {
  assert.equal(paceSkip(4480, now, 8, 10, 999 * M, into(20)), "eBay daily limit reached");
  assert.equal(paceSkip(4300, now, 8, 10, 999 * M, into(20)), "", "below 90%: still scanning");
});
t("eBay's day follows US Pacific time, including daylight saving", () => {
  assert.equal(minsToEbayReset(Date.parse("2026-11-07T05:00:00Z")), 180, "winter: eBay resets at 08:00 UTC (08:00 UK)");
  assert.equal(minsToEbayReset(Date.parse("2026-07-01T05:00:00Z")), 120, "summer: eBay resets at 07:00 UTC (08:00 UK)");
  assert.equal(minsToEbayReset(Date.parse("2026-10-28T05:00:00Z")), 120, "late October: US still on summer time, 07:00 UK");
  assert.equal(ebayDay(Date.parse("2026-11-07T07:59:00Z")), "2026-11-06"); assert.equal(ebayDay(Date.parse("2026-11-07T08:00:00Z")), "2026-11-07");
  assert.equal(minsToEbayReset(Date.parse("2026-11-07T05:00:00Z"), { reset: Date.parse("2026-11-07T08:30:00Z") }), 210, "eBay's own reset time wins when known");
});
t("automatic timing: 5 minutes for 1–2 categories, 10 otherwise", () => {
  assert.equal(autoInterval(1), 5); assert.equal(autoInterval(2), 5); assert.equal(autoInterval(3), 10); assert.equal(autoInterval(9), 10);
  assert.equal(cleanConfig({}).interval, 0, "automatic is the default");
  assert.equal(cleanConfig({ interval: 15 }).interval, 15, "a chosen time is kept");
});
console.log(`\n${n} checks passed`);
