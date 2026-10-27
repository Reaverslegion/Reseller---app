// Deal diary checks: one row per deal, matching the table's columns. Run: node tests/diary.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { diaryRow, DIARY_COLS } = new Function(src + "\nreturn { diaryRow, DIARY_COLS };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const deal = { id: "123456789012", cat: "9355", pkey: "phone:iphone 13|128|used", type: "BIN", bucket: "used", title: "Apple iPhone 13 128GB",
  price: 250, ship: 4.5, cost: 254.5, med: 320, low: 290, rangeLo: 295, rangeHi: 340, src: "book", n: 2, bookN: 42,
  profit: 30.1, lowProfit: 6.2, maxPay: 260, maxBid: null, score: 74, end: null, seller: { biz: true } };
t("one value per column, id first", () => {
  const r = diaryRow(deal, 1000);
  assert.equal(r.length, DIARY_COLS.cols.length);
  assert.equal(r[0], "123456789012"); assert.equal(r[1], 1000);
});
t("values land in the right columns", () => {
  const r = diaryRow(deal, 1000), get = (c) => r[DIARY_COLS.cols.indexOf(c)];
  assert.equal(get("med"), 320); assert.equal(get("lo"), 295); assert.equal(get("hi"), 340); assert.equal(get("book_n"), 42);
  assert.equal(get("profit"), 30.1); assert.equal(get("max_bid"), null); assert.equal(get("biz"), 1); assert.equal(get("cond"), "used");
});
t("missing or broken numbers are stored as empty, never as made-up values", () => {
  const r = diaryRow({ id: 5, price: "abc", med: undefined, seller: null }, 1), get = (c) => r[DIARY_COLS.cols.indexOf(c)];
  assert.equal(get("price"), null); assert.equal(get("med"), null); assert.equal(get("biz"), 0); assert.equal(r[0], "5");
});
console.log(`\n${n} checks passed`);
