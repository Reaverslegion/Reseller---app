// Sell-speed checks for the scan service. Run: node tests/speed.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { coverAdd, coverDays, coverOf, salesRate, speedOf, rateCheck, DAY } = new Function(src + "\nreturn { coverAdd, coverDays, coverOf, salesRate, speedOf, rateCheck, DAY };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const now = Date.parse("2026-10-25T18:00:00Z"), day0 = Date.parse("2026-10-25T00:00:00Z");
const dayAgo = (k) => day0 - k * DAY;
const sale = (k, i) => ["id" + k + "_" + i, 100, 3, dayAgo(k)];

t("covered ranges merge and old ones drop off", () => {
  let c = coverAdd([], dayAgo(10), dayAgo(5), now);
  c = coverAdd(c, dayAgo(6), now, now);
  assert.deepEqual(c, [[dayAgo(10), now]]);
  c = coverAdd(c, dayAgo(200), dayAgo(150), now);
  assert.equal(c.length, 1, "ranges older than 90 days are dropped");
  assert.ok(Math.abs(coverDays(c, dayAgo(30), now) - (10 + 18 / 24)) < 1e-9);
});
t("a fill only counts days read in full (the oldest, partly read day is left out)", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ d: dayAgo(i % 8) }));
  const r = coverOf(rows, now);
  assert.equal(r[0], dayAgo(7) + DAY, "starts the day after the oldest sale");
  assert.equal(r[1], now);
  assert.equal(coverOf(rows.slice(0, 10), now), null, "too few rows proves nothing");
});
t("sales per day only counts sales on covered days", () => {
  const cover = [[dayAgo(7), now]]; // 7.75 days read in full
  const list = [...Array.from({ length: 20 }, (_, i) => sale(i % 7, i)), ...Array.from({ length: 30 }, (_, i) => sale(20, i))];
  const r = salesRate(list, cover, now);
  assert.equal(r.sn, 20, "the 30 sales 20 days ago are on days that weren't read in full");
  assert.ok(Math.abs(r.spd - 20 / 7.75) < 1e-9);
});
t("not enough data under 10 sales or 3 days", () => {
  assert.equal(speedOf({ spd: 2, sdays: 5, sn: 9, act: 10, act_at: now }, now).band, "none");
  assert.equal(speedOf({ spd: 5, sdays: 2, sn: 10, act: 10, act_at: now }, now).band, "none");
  assert.equal(speedOf(null, now), null);
});
t("no for-sale count yet: shows sales a week only, no band", () => {
  const s = speedOf({ spd: 2, sdays: 10, sn: 20 }, now);
  assert.equal(s.band, null); assert.equal(s.perWeek, 14);
});
t("bands: fast up to a week, normal up to 4 weeks, slow after", () => {
  assert.equal(speedOf({ spd: 2, sdays: 10, sn: 20, act: 10, act_at: now }, now).band, "fast"); // 5 days
  assert.equal(speedOf({ spd: 1, sdays: 10, sn: 10, act: 20, act_at: now }, now).band, "normal"); // 20 days
  const s = speedOf({ spd: 0.5, sdays: 30, sn: 15, act: 30, act_at: now }, now); // 60 days
  assert.equal(s.band, "slow"); assert.equal(s.lo, 36); assert.equal(s.hi, 96);
});
t("an old for-sale count (over 7 days) isn't used", () => {
  assert.equal(speedOf({ spd: 2, sdays: 10, sn: 20, act: 10, act_at: now - 8 * DAY }, now).band, null);
});
t("self-check: the rate held up within ±50%, or didn't", () => {
  const cover = [[dayAgo(20), now]], prev = { spd: 2, sn: 20, sdays: 10, at: dayAgo(6) };
  const ok = Array.from({ length: 10 }, (_, i) => sale(i % 5, i)); // 10 sales over ~6 days ≈ 1.6/day
  assert.equal(rateCheck(prev, ok, cover, now).hit, true);
  const bad = Array.from({ length: 2 }, (_, i) => sale(1, i));
  assert.equal(rateCheck(prev, bad, cover, now).hit, false);
  assert.equal(rateCheck({ ...prev, sn: 5 }, ok, cover, now), null, "no check when the first estimate was thin");
  assert.equal(rateCheck({ ...prev, at: dayAgo(1) }, ok, cover, now), null, "no check with under 3 new days");
});
console.log(`\n${n} checks passed`);
