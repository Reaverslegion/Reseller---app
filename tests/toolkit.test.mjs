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
  return new Function("S", "money", "MON", "Papa", "gbp", src)(S, () => ({ cash: 1e9, committed: 0 }), { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }, Papa, (x) => "£" + (+x).toFixed(2));
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

const pennies = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 100);
if (have("splitBundle")) t("bundles: the split adds up to the total to the penny, evenly or by expected price", () => {
  const A = load();
  assert.deepEqual(A.splitBundle(10, [1, 1, 1]), [3.34, 3.33, 3.33]);
  assert.deepEqual(A.splitBundle(100, [150, 50]), [75, 25]);
  for (let k = 0; k < 500; k++) {
    const total = Math.round(Math.random() * 100000) / 100, w = Array.from({ length: 2 + Math.floor(Math.random() * 12) }, () => Math.random() < 0.2 ? 0 : Math.round(Math.random() * 300));
    const sh = A.splitBundle(total, w); assert.equal(sh.length, w.length); assert.equal(pennies(sh), Math.round(total * 100), `total ${total}`);
    assert.ok(sh.every((x) => x >= 0 && Math.round(x * 100) === x * 100 || Math.abs(Math.round(x * 100) - x * 100) < 1e-6), "whole pennies");
  }
});
if (have("retApply")) t("returns: item back → the loss stays in actual profit once, and the item can be sold again", () => {
  const it = { id: 1, status: "Sold", buy: 40, pack: 1, soldPrice: 100, fees: 13.2, outPost: 5 }, A = load({}, [it]);
  const before = A.stockSums().actual; close(before, 100 - 13.2 - 5 - 41, "before");
  assert.equal(A.retApply(it, "back", { refund: 100, feesBack: 12.8, retPost: 4 }, "2026-11-13"), null);
  assert.equal(it.status, "Returned"); assert.equal(it.soldPrice, undefined); assert.equal(it.profit, undefined);
  close(it.sunk, 9.4, "lost on the return (13.20 - 12.80 fees + 5 + 4 postage)"); assert.equal(it.rets.length, 1);
  let m = A.stockSums(); close(m.actual, -9.4, "actual while unsold"); close(m.invested, 41, "back in unsold stock");
  Object.assign(it, { status: "Sold", soldPrice: 90, fees: 11.92, outPost: 5 });
  m = A.stockSums(); close(m.actual, 90 - 11.92 - 5 - 41 - 9.4, "actual after resale (loss counted once)");
});
if (have("retApply")) t("refunds: part refund keeps it sold; full refund kept by buyer → Written off; too much or unsold refused", () => {
  const a = { id: 1, status: "Done", buy: 40, pack: 1, soldPrice: 100, fees: 13.2, outPost: 5 }, A = load({ seller: "business" }, [a]);
  assert.equal(A.retApply(a, "partial", { refund: 20, feesBack: 2.56 }, "d"), null); assert.equal(a.status, "Done");
  close(a.profit, 100 - 20 - 13.2 + 2.56 - 5 - 41, "after part refund"); close(A.itemProfit(a), a.profit, "stored = sum");
  assert.match(A.retApply(a, "kept", { refund: 80.01 }, "d"), /more than/);
  assert.equal(A.retApply(a, "kept", { refund: 80, feesBack: 0 }, "d"), null); assert.equal(a.status, "Written off");
  close(a.profit, 100 - 100 - 13.2 + 2.56 - 5 - 41, "after full refund"); assert.equal(a.rets.length, 2);
  assert.match(A.retApply({ status: "Listed", buy: 5 }, "partial", { refund: 1 }, "d"), /sold item/);
  assert.match(A.retApply({ status: "Sold", soldPrice: 10, fees: 0 }, "partial", { refund: -1 }, "d"), /negative/);
});
if (have("woApply")) t("write off: an unsold item's costs become a loss, less anything recovered; not counted as stock any more", () => {
  const it = { id: 1, status: "Listed", buy: 50, pack: 1, other: 10, exp: 120 }, A = load({}, [it]);
  close(A.stockSums().invested, 61, "in stock before");
  assert.equal(A.woApply(it, { recovered: 15, note: "lost" }, "2026-11-13"), null); assert.equal(it.status, "Written off");
  const m = A.stockSums(); close(m.invested, 0, "no longer in stock"); close(m.actual, -46, "loss"); close(it.profit, -46, "stored");
  assert.match(A.woApply(it, {}, "d"), /unsold/);
});
if (have("taxYear")) t("expenses: UK tax years run 6 April to 5 April and totals add up", () => {
  const A = load();
  assert.equal(A.taxYear("2026-04-05"), "2025/26"); assert.equal(A.taxYear("2026-04-06"), "2026/27"); assert.equal(A.taxYear("2099-12-31"), "2099/00");
  const m = A.expSums([{ date: "2026-04-05", amount: 10, cat: "Travel" }, { date: "2026-04-06", amount: 2.5 }, { date: "2026-11-13", amount: "7.25", cat: "Packaging" }]);
  close(m.total, 19.75, "total"); assert.equal(m.years[0].year, "2026/27"); close(m.years[0].total, 9.75, "this year"); assert.equal(m.years[0].count, 2);
  close(m.years[0].cats.Other, 2.5, "no type = Other");
  const S2 = load({}, [{ id: 1, status: "Done", buy: 10, pack: 0, soldPrice: 30, fees: 0, outPost: 0 }], [{ amount: 5 }]).stockSums();
  close(S2.actual, 20, "item profit before expenses"); close(S2.expenses, 5, "expenses kept separate");
});
t("stored data: opening the app keeps items, settings and expenses exactly; older saves get an empty expenses list", () => {
  const src = ["DEF", "OLDMAP", "load"].map((n) => grab(html, n)).join("\n").replace(/^const DEF=/, "const DEF=") + "\nreturn load;";
  const run = (stored) => new Function("localStorage", "KEY", "window", "PRE", src)({ getItem: () => stored }, "k", {}, ["Considered"])();
  const items = [{ id: 1, status: "Sold", buy: 1, soldPrice: 5, profit: 4, f: { n: "x" } }, { id: 2, status: "Written off", buy: 3, recovered: 1 }];
  const exp = [{ id: 7, date: "2026-11-01", desc: "tape", cat: "Packaging", amount: 3.5 }];
  const rules = { cheap: true, maxPrice: 0, minProfit: 25, minRoi: 0, budget: 200, maxStock: 150, minSales: 5, feePct: 12.8, feeFixed: 0.4, staleDays: 30, minPct: 35, seller: "private", v2: 1 };
  const a = run(JSON.stringify({ rules, items, gate: ["g"], base: [], hunt: { post: 3 }, set: { url: "u", key: "k", theme: "dark" }, expenses: exp }));
  assert.deepEqual(a.items, items); assert.deepEqual(a.expenses, exp); assert.equal(a.rules.seller, "private"); assert.equal(a.rules.minProfit, 25); assert.equal(a.set.theme, "dark");
  assert.deepEqual(run(JSON.stringify({ rules, items })).expenses, []);
  assert.deepEqual(run(JSON.stringify({ rules, items, expenses: "bad" })).expenses, []);
});
console.log(`\n${n} checks passed`);
