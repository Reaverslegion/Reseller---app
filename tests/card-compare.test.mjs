// Reopen check (9 Nov 2026): after closing and reopening the app, every deal card must be the same — but the time labels
// ("5 min ago", "2h 3m left", "just now"…) change every minute, so ONLY those are ignored. Prices, titles, badges, order
// and everything else are still compared, and a real difference reports the actual before/after text.
// Uses the app's own time formatters (ago/left from index.html), so a future change of wording is caught here.
// Run: node tests/card-compare.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { compareCards, describeDiffs } from "./integrity/card-compare.mjs";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = (name) => { const m = html.match(new RegExp("const " + name + "=ts=>\\{[^\\n]*?\\};")); assert.ok(m, name + " found in index.html"); return m[0]; };
let NOW = Date.parse("2026-11-09T10:00:20Z");
const { ago, left } = new Function("Date", src("ago") + src("left") + "return { ago, left };")({ now: () => NOW });
// a card as the emulator reads it (aria = title, text = the card's visible text), laid out like the Fliptimize card
const card = (d) => ({ aria: d.title, text: ["No photo", (d.isNew ? "NEW " : "") + d.title, `Used · Auction${d.end ? "⏱ " + left(d.end) : ""}`,
  `Most you'd pay £${d.max.toFixed(2)}`, `Profit £${d.profit.toFixed(2)}`, `Sold prices · ${ago(d.created)} · Score ${d.score} · Good`].join("\n") });
const deals = Array.from({ length: 20 }, (_, i) => ({ title: `RTX 3060 deal ${i}`, end: i % 2 ? NOW + (i * 37 + 5) * 60000 + 20000 : 0, created: NOW - (i * 13 + 2) * 60000 - 25000, max: 100 + i, profit: 10 + i, score: 60 + i }));
const at = (t, list = deals) => { NOW = t; return list.map(card); };
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("reproduction: reopening a minute later, nothing else changed → the cards are the same", () => {
  const before = at(NOW), after = at(NOW + 61000), r = compareCards(before, after);
  assert.ok(r.same, `${r.diffs.length} cards reported different, e.g. ${JSON.stringify(r.diffs[0] || {}).slice(0, 200)}`);
});
t("every wording the app's time labels can produce is ignored (minutes, hours, days; ago and left)", () => {
  const base = NOW;
  for (const m of [0, 1, 2, 30, 59, 60, 61, 119, 125, 1439, 1440, 2880, 2879, 6000]) {
    const one = { ...deals[1], end: base + (m + 2) * 60000 + 1000, created: base - m * 60000 - 1000 }; // ends after the reopen
    const r = compareCards(at(base, [one]), at(base + 61000, [one])); assert.ok(r.same, `${m} min: ${JSON.stringify(r.diffs[0])}`);
  }
});
t("a changed price is still a difference, and the actual before/after text is reported", () => {
  const before = at(NOW), changed = deals.map((d, i) => (i === 3 ? { ...d, max: d.max + 5 } : d)), r = compareCards(before, at(NOW + 61000, changed));
  assert.equal(r.same, false); assert.equal(r.diffs.length, 1); assert.equal(r.diffs[0].i, 3);
  assert.match(r.diffs[0].before, /Most you'd pay £103\.00/); assert.match(r.diffs[0].after, /Most you'd pay £108\.00/);
  assert.equal(describeDiffs(r), `card 4: "Most you'd pay £103.00" → "Most you'd pay £108.00"`, "the report names exactly the line that changed");
});
t("a changed profit, title, score or badge is still a difference", () => {
  for (const ch of [{ profit: 99 }, { title: "Renamed" }, { score: 1 }, { isNew: true }]) {
    const r = compareCards(at(NOW), at(NOW + 61000, deals.map((d, i) => (i === 5 ? { ...d, ...ch } : d))));
    assert.equal(r.same, false, JSON.stringify(ch)); }
});
t("a changed order, a missing card or an extra card is still a difference", () => {
  const before = at(NOW);
  assert.equal(compareCards(before, at(NOW, [deals[1], deals[0], ...deals.slice(2)])).same, false);
  assert.equal(compareCards(before, at(NOW, deals.slice(1))).same, false);
  assert.equal(compareCards(before, at(NOW, [...deals, { ...deals[0], title: "extra" }])).same, false);
});
t("an auction that ended in between is a real difference (\"ended\" is not ignored)", () => {
  const one = { ...deals[1], end: NOW + 30000 }, r = compareCards(at(NOW, [one]), at(NOW + 61000, [one]));
  assert.equal(r.same, false); assert.match(r.diffs[0].after, /ended/);
});
console.log(`\n${n} checks passed`);
