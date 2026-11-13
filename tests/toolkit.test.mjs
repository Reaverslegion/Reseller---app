// Reseller toolkit (13 Nov 2026): runs the app's own My Stock, calculator, returns, bundles, expenses and CSV code from
// index.html (no browser needed) and checks the money sums against the existing formulas and the Scan service's own code.
// Run: node tests/toolkit.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");

// pull named functions / consts out of the app's script, exactly as written
function grab(src, name) {
  let i = src.indexOf(`function ${name}(`);
  if (i < 0) { const m = src.match(new RegExp(`(?:const|let) ${name}\\s*=`)); assert.ok(m, `${name} found`); i = m.index; }
  // a top-level declaration ends at the next top-level "\nfunction " / "\nconst " / "\nlet " / "\n/*"
  const ends = ["\nfunction ", "\nasync function ", "\nconst ", "\nlet ", "\n/*"].map((e) => src.indexOf(e, i + 5)).filter((x) => x > 0);
  return src.slice(i, Math.min(...ends));
}
const NAMES = ["num", "isNum", "median", "pct", "parse", "fee", "maxPay", "isSold", "itemProfit", "itemEst", "stockSums", "bpfFee", "calcResult"];
const OPT = ["splitBundle", "retApply", "woApply", "taxYear", "expSums", "csvSafe", "itemsToCsv", "expensesToCsv", "csvImportPlan", "csvDate", "csvNum"];
const have = (n) => html.includes(`function ${n}(`) || new RegExp(`(?:const|let) ${n}\\s*=`).test(html);
const consts = html.match(/const PRE=\[[^\n]*\n/)[0];
function load(rules = {}, items = [], expenses = []) {
  const S = { rules: { cheap: true, maxPrice: 0, minProfit: 20, minRoi: 0, budget: 200, maxStock: 150, minSales: 5, feePct: 12.8, feeFixed: 0.4, staleDays: 30, seller: "private", ...rules }, items, expenses };
  const names = [...NAMES, ...OPT.filter(have)];
  const src = consts + names.map((n) => grab(html, n)).join("\n") + `\nreturn {${names.join(",")}};`;
  const Papa = have("itemsToCsv") ? loadPapa() : undefined;
  return new Function("S", "money", "MON", "Papa", src)(S, () => ({ cash: 1e9, committed: 0 }), { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }, Papa);
}
function loadPapa() { // the copy bundled inside index.html
  const m = html.match(/<script id="papaparse">([\s\S]*?)<\/script>/); assert.ok(m, "Papa Parse is bundled in index.html");
  const mod = { exports: {} }; new Function("module", "exports", "define", "self", m[1])(mod, mod.exports, undefined, globalThis); return mod.exports;
}
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

t("existing items: profit is exactly the old sale sum (sale - fees - postage out - paid - packaging)", () => {
  const A = load();
  for (let k = 0; k < 200; k++) {
    const i = { soldPrice: Math.random() * 500, fees: Math.random() * 40, outPost: Math.random() * 10, buy: Math.random() * 300, pack: Math.random() * 3 };
    close(A.itemProfit(i), i.soldPrice - i.fees - i.outPost - i.buy - i.pack, "profit");
  }
});
t("buyer protection fee is identical to the Scan service's formula", () => {
  const A = load(), W = new Function(worker.match(/function bpf\(p\)[^\n]*/)[0] + "\nreturn bpf;")();
  for (const p of [0, 1, 10, 20, 20.01, 55, 299.99, 300, 1000, 3999, 4000, 9000]) close(A.bpfFee(p), W(p), `bpf(${p})`);
});
t("selling fee: Private = 0; Business = 12.8% + £0.40 (same as the Scan service)", () => {
  assert.equal(load({ seller: "private" }).fee(100), 0);
  const B = load({ seller: "business" }); close(B.fee(100), 13.2, "£100"); close(B.fee(8), 8 * 0.128 + 0.3, "£8 (small-order fixed fee)");
  const W = new Function(worker.match(/function sellFee\(x, r\)[^\n]*/)[0] + "\nreturn sellFee;")();
  for (const x of [5, 10, 10.5, 99, 450]) close(B.fee(x), W(x, { seller: "business", feePct: 12.8, feeFixed: 0.4 }), `sellFee(${x})`);
});
t("calculator: profit, return and low-end profit use the deal sums", () => {
  const A = load({ seller: "business", minProfit: 20 });
  const c = A.calcResult({ sell: "120", low: "100", post: "5", pack: "1", buy: "60", ship: "", bpf: false, sp: "" });
  close(c.fee, 120 * 0.128 + 0.4, "fee"); close(c.profit, 120 - c.fee - 5 - 1 - 60, "profit");
  close(c.lowProfit, 100 - (100 * 0.128 + 0.4) - 6 - 60, "low-end profit"); close(c.roi, c.profit / 61 * 100, "return");
});
t("calculator: most you'd pay = the app's maxPay; highest item price/bid = the Scan service's formula", () => {
  for (const seller of ["private", "business"]) for (const cheap of [true, false]) {
    const A = load({ seller, cheap, minProfit: 15, minRoi: 0 });
    const c = A.calcResult({ sell: "200", low: "150", post: "6", pack: "1", buy: "", ship: "4.99", bpf: true, sp: "" });
    close(c.maxTotal, A.maxPay(200, 150, 6, 1, false), "maxTotal");
    close(c.maxItem, Math.floor((c.maxTotal - 4.99 - A.bpfFee(c.maxTotal)) * 100) / 100, "maxItem");
    // buying at the most you'd pay leaves the minimum profit (or the cheap-end rule, whichever is lower)
    const left = 200 - A.fee(200) - 7 - c.maxTotal; assert.ok(left >= 15 - 0.011, `leaves minimum profit (${left})`);
  }
});
t("calculator: pasted sold prices give the middle price and the lower quarter", () => {
  const A = load(), c = A.calcResult({ sp: "100\n110\n120\n130\n140", sell: "", low: "", post: "0", pack: "0", buy: "", ship: "", bpf: false });
  assert.equal(c.fromList, true); assert.equal(c.n, 5); close(c.sell, A.median([100, 110, 120, 130, 140]), "typical"); close(c.low, A.pct([100, 110, 120, 130, 140], 0.25), "low");
});
t("calculator: nothing to sell for → no result; too expensive → no 'most you'd pay'", () => {
  const A = load({ minProfit: 50 });
  assert.equal(A.calcResult({ sell: "", sp: "", low: "", post: "", pack: "", buy: "", ship: "", bpf: false }), null);
  const c = A.calcResult({ sell: "40", low: "", post: "5", pack: "1", buy: "", ship: "", bpf: false, sp: "" }); assert.equal(c.maxTotal, null);
});
t("My Stock sums: money in stock, estimate and actual profit are kept separate", () => {
  const items = [
    { id: 1, status: "Bought", buy: 100, pack: 1, exp: 150, outPost: 5 },
    { id: 2, status: "Listed", buy: 50, pack: 1 },                               // no expected price
    { id: 3, status: "Sold", buy: 80, pack: 1, soldPrice: 120, fees: 0, outPost: 5 },
    { id: 4, status: "Done", buy: 30, pack: 0, soldPrice: 20, fees: 0, outPost: 3 }, // a loss
    { id: 5, status: "Considered", buy: 999 }];                                     // old watchlist: ignored
  const A = load({}, items), m = A.stockSums();
  close(m.invested, 101 + 51, "invested"); close(m.est, 150 - 5 - 101, "estimate"); assert.equal(m.noEst, 1);
  close(m.actual, (120 - 5 - 81) + (20 - 3 - 30), "actual");
});
console.log(`\n${n} checks passed`);
