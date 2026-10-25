// Money-maths checks for the scan service. Run: node tests/finance.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const { bpf, sellFee, maxPay } = new Function(src + "\nreturn { bpf, sellFee, maxPay };")();
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg}: got ${a}, expected ${b}`);
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };

const biz = { seller: "business", feePct: 12.8, feeFixed: 0.4, minProfit: 15, minRoi: 30, post: 5, pack: 1 };
const priv = { ...biz, seller: "private" };

t("buyer protection fee: £0.10 + 7% to £20, 4% to £300, 2% to £4,000", () => {
  near(bpf(0), 0.1, "£0"); near(bpf(20), 1.5, "£20"); near(bpf(73.5), 3.64, "£73.50");
  near(bpf(300), 12.7, "£300"); near(bpf(4000), 86.7, "£4,000"); near(bpf(5000), 86.7, "capped at £4,000");
});
t("selling fees: private sellers pay none; business pays % + fixed", () => {
  near(sellFee(100, priv), 0, "private"); near(sellFee(100, biz), 13.2, "business £100"); near(sellFee(8, biz), 1.324, "small orders capped fixed fee");
});
t("max pay leaves at least the minimum profit and return", () => {
  for (const med of [40, 80, 135, 400]) {
    const r = priv, low = med * 0.85, mp = maxPay(med, low, r);
    if (mp <= 0) continue;
    const profit = med - sellFee(med, r) - (r.post + r.pack) - mp;
    assert.ok(profit >= r.minProfit - 0.01, `profit at max for £${med} was ${profit}`);
    assert.ok(profit / (mp + r.pack) * 100 >= r.minRoi - 0.01, `return at max for £${med}`);
  }
});
t("max pay is never positive when there is no margin", () => {
  assert.ok(maxPay(10, 8.5, priv) <= 0);
});
t("worked example from the deal page sums adds up", () => {
  const item = 90.43, ship = 3.89, fee = Math.round(bpf(item) * 100) / 100, pay = item + ship + fee;
  near(fee, 4.32, "fee"); near(pay, 98.64, "total you pay");
  const back = 134.98 - 0 - 6; near(back, 128.98, "you receive"); near(back - pay, 30.34, "profit");
});
t("auction max bid: never lose money if it sells at the cheap end (RTX 5090 preview example)", () => {
  const r = { ...priv, minProfit: 5, minRoi: 0, cheap: true }, med = 4305, low = 3900, ship = 0;
  const mp = maxPay(med, low, r); near(mp, 3893.99, "most to pay in total (cheap end minus postage & packing)");
  const maxBid = Math.floor((mp - ship - bpf(mp)) * 100) / 100; near(maxBid, 3809.41, "max bid after buyer protection fee");
  const total = maxBid + ship + bpf(maxBid); assert.ok(total <= mp, "paying the max bid stays within the most to pay");
  const cheapEnd = low - sellFee(low, r) - (r.post + r.pack) - total; assert.ok(cheapEnd > 0, "still no loss at the cheap end"); near(cheapEnd, 1.7, "profit if it sells at the cheap end");
  near(med - sellFee(med, r) - (r.post + r.pack) - total, 406.7, "profit at the typical price, at your max bid");
});
t("business sellers: the max bid also covers eBay's selling fee", () => {
  const r = { ...biz, minProfit: 5, minRoi: 0, cheap: true }, med = 4305, low = 3900;
  const mp = maxPay(med, low, r); near(mp, low - sellFee(low, r) - 6 - 0.01, "cheap end after selling fee");
  assert.ok(mp < maxPay(med, low, { ...r, seller: "private" }), "less than a private seller can pay");
});
console.log(`\n${n} checks passed`);
