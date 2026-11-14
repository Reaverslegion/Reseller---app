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
const OPT = ["splitBundle", "retApply", "woApply", "taxYear", "expSums", "EXCAT", "CSV_MAX", "r2c", "ITEM_COLS", "csvKey", "CSV_ALIAS", "csvHeaderMap", "unq", "itemKey", "expKey", "csvSafe", "itemsToCsv", "expensesToCsv", "csvImportPlan", "csvDate", "csvNum"];
const have = (n) => html.includes(`function ${n}(`) || new RegExp(`(?:const|let) ${n}\\s*=`).test(html);
const consts = html.match(/const PRE=\[[^\n]*\n/)[0];
function load(rules = {}, items = [], expenses = []) {
  const S = { rules: { cheap: true, maxPrice: 0, minProfit: 20, minRoi: 0, budget: 200, maxStock: 150, minSales: 5, feePct: 12.8, feeFixed: 0.4, staleDays: 30, seller: "private", ...rules }, items, expenses };
  const names = [...NAMES, ...OPT.filter(have)];
  const src = consts + names.map((n) => grab(html, n)).join("\n") + `\nreturn {${names.join(",")}};`;
  const Papa = have("itemsToCsv") ? loadPapa() : undefined;
  return new Function("S", "money", "MON", "Papa", "gbp", "today", src)(S, () => ({ cash: 1e9, committed: 0 }), { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }, Papa, (x) => "£" + (+x).toFixed(2), () => "2026-11-13");
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

if (have("csvImportPlan")) {
  const crypto = await import("node:crypto");
  const m = html.match(/<script id="papaparse">([\s\S]*?)<\/script>/)[1];
  assert.match(m, /Permission is hereby granted, free of charge/); assert.match(m, /Copyright \(c\) 2015 Matthew Holt/);
  const lib = m.slice(m.indexOf("*/\n") + 3).replace(/\n$/, "");
  assert.equal(crypto.createHash("sha256").update(lib).digest("hex"), "4d5d2d6e3282b66aafaa5e6de8ca3ae06f8d3440111ae99c6a30f6c00cfac33e", "same bytes as the release file");
  assert.equal(loadPapa().unparse([[1, 2]]), "1,2"); n++; console.log("✓ CSV: Papa Parse is the verified 5.7.0 file (same SHA-256), bundled unchanged with its MIT licence");
  t("CSV: numbers and dates are read strictly", () => {
    const A = load();
    assert.equal(A.csvNum("£1,234.50"), 1234.5); assert.equal(A.csvNum(""), null); assert.ok(Number.isNaN(A.csvNum("-5"))); assert.ok(Number.isNaN(A.csvNum("12abc"))); assert.ok(Number.isNaN(A.csvNum("1e5")));
    assert.equal(A.csvDate("2026-11-13"), "2026-11-13"); assert.equal(A.csvDate("13/11/2026"), "2026-11-13"); assert.equal(A.csvDate("1/2/2026"), "2026-02-01");
    assert.equal(A.csvDate(""), ""); assert.equal(A.csvDate("31/02/2026"), null); assert.equal(A.csvDate("2026-13-01"), null); assert.equal(A.csvDate("yesterday"), null);
  });
  t("CSV export: spreadsheet formulas can't run; estimated and actual profit in separate columns; watchlist left out", () => {
    const items = [{ id: 1, name: "=HYPERLINK(\"x\")", status: "Bought", buy: 10, pack: 1, exp: 30, outPost: 3, boughtOn: "2026-11-01" },
      { id: 2, name: "@SUM(A1)", status: "Sold", buy: 10, pack: 1, soldPrice: 40, fees: 0, outPost: 3 }, { id: 3, name: "Kindle", status: "Considered", buy: 5 }];
    const A = load({ seller: "private" }, items), P = loadPapa(), rows = P.parse(A.itemsToCsv(items), { header: true }).data;
    assert.equal(rows.length, 2); assert.equal(rows[0].Name, "'=HYPERLINK(\"x\")"); assert.equal(rows[1].Name, "'@SUM(A1)");
    assert.equal(rows[0]["Estimated profit"], "16"); assert.equal(rows[0]["Actual profit"], ""); assert.equal(rows[1]["Actual profit"], "26"); assert.equal(rows[1]["Estimated profit"], "");
    const e = P.parse(A.expensesToCsv([{ id: 9, date: "2026-11-01", desc: "+tape", cat: "Packaging", amount: 3.5 }]), { header: true }).data[0];
    assert.equal(e.Description, "'+tape"); assert.equal(e.Amount, "3.5");
  });
  t("CSV round trip: export then import into the same app adds nothing; into an empty app gives the same items and profit", () => {
    const items = [{ id: 1, name: "GPU, \"boxed\"", status: "Listed", buy: 100, pack: 1, exp: 150, outPost: 5, other: 7, boughtOn: "2026-10-01" },
      { id: 2, name: "Phone", status: "Done", buy: 80, pack: 1, soldPrice: 120, fees: 15.76, outPost: 5, refund: 10, feesBack: 1.2, boughtOn: "2026-09-01", soldOn: "2026-09-20" },
      { id: 3, name: "Lost thing", status: "Written off", buy: 20, pack: 0, recovered: 5 }];
    const A = load({ seller: "business" }, items), csv = A.itemsToCsv(items);
    const same = A.csvImportPlan(csv, "items", items, 1000); assert.equal(same.add.length, 0); assert.equal(same.dups.length, 3); assert.equal(same.errors.length, 0);
    const fresh = A.csvImportPlan(csv, "items", [], 1000); assert.equal(fresh.add.length, 3, JSON.stringify(fresh.errors));
    for (const [k, it] of items.entries()) { const b = fresh.add[k];
      for (const f of ["name", "status", "buy", "pack", "exp", "outPost", "other", "soldPrice", "fees", "refund", "feesBack", "recovered", "boughtOn", "soldOn"]) if (it[f] != null) assert.equal(b[f], it[f], `${it.name} ${f}`);
      close(A.itemProfit(b), A.itemProfit(it), "same profit"); assert.ok(b.id >= 1000); }
    assert.equal(fresh.add[1].profit, A.itemProfit(items[1]));
  });
  t("CSV import: malformed or wrong files are refused safely, bad rows skipped with the line number, nothing overwritten", () => {
    const existing = [{ id: 5, name: "Switch", status: "Bought", buy: 190, boughtOn: "2026-11-01" }], A = load({}, existing);
    const before = JSON.stringify(existing);
    assert.match(A.csvImportPlan("", "items", existing, 1).fatal, /empty/);
    assert.match(A.csvImportPlan("x".repeat(2e6 + 1), "items", existing, 1).fatal, /too big/);
    assert.match(A.csvImportPlan("Paid,Status\n10,Bought", "items", existing, 1).fatal, /Name/);
    assert.match(A.csvImportPlan("\u0000\u0001binary\u0002", "items", existing, 1).fatal, /Name/);
    assert.match(A.csvImportPlan("Name\n" + "a\n".repeat(5001), "items", [], 1).fatal, /5000/);
    const p = A.csvImportPlan([
      "﻿Item,Paid,Status,Bought on,Sale total,Profit,Colour",
      "Switch,190,Bought,01/11/2026,,999,red",          // duplicate of what's already there (name+date+price)
      "New lens,£45.00,listed,2026-11-02,,,",            // ok (status any case, £ sign)
      "Bad price,abc,Bought,,,,",                        // not a number
      "Bad date,10,Bought,32/13/2026,,,",                // not a date
      "Odd status,10,Shipped,,,,",                       // unknown status
      "Sold no price,10,Sold,,,,",                       // sold needs a sale total
      ",10,Bought,,,,",                                  // no name
      "New lens,45,Listed,2026-11-02,,,",                // duplicate inside the file
      "=cmd|' /C calc'!A0,5,Bought,,,,",
      "\"Broken quote,10,Bought"].join("\n"), "items", existing, 100);   // malformed: an unclosed quote (reported, not added)
    assert.equal(p.add.length, 2, JSON.stringify(p));
    assert.equal(p.add[0].name, "New lens"); assert.equal(p.add[0].status, "Listed"); assert.equal(p.add[0].buy, 45); assert.equal(p.add[0].profit, undefined, "profit not read from the file");
    assert.equal(p.add[1].name, "=cmd|' /C calc'!A0", "kept as plain text (never run)");
    assert.equal(p.dups.length, 2); assert.equal(p.errors.length, 6, JSON.stringify(p.errors)); assert.deepEqual(p.errors.filter((e) => /laid out/.test(e.msg)).map((e) => e.line), [11], "broken row reported once, on its own line"); assert.ok(p.errors.every((e) => e.line >= 2));
    assert.deepEqual(p.unknown, ["Colour"]); assert.equal(JSON.stringify(existing), before, "existing data untouched");
  });
  t("CSV import: expenses need a real date and an amount above £0; types are matched or set to Other; duplicates skipped", () => {
    const A = load(), ex = [{ id: 1, date: "2026-11-01", desc: "Tape", cat: "Packaging", amount: 3.5 }];
    const p = A.csvImportPlan("Date,Description,Category,Amount\n01/11/2026,tape,packaging,3.50\n2026-11-02,Fuel,travel,12\n2026-11-03,Hat,Clothes,5\n2026-11-04,Zero,,0\n,No date,,4\n2026-11-05,Neg,,-2", "expenses", ex, 50);
    assert.deepEqual(p.add.map((e) => [e.date, e.cat, e.amount]), [["2026-11-02", "Travel", 12], ["2026-11-03", "Other", 5]]);
    assert.equal(p.dups.length, 1); assert.equal(p.errors.length, 3);
  });
}

t("phone Back: one press = exactly one onBack(), whether the App plugin, the page event or both arrive, in any order", () => {
  const src = grab(html, "HWB") + grab(html, "hwBack") + "\nreturn {HWB, hwBack};";
  const make = (back = () => true) => { const st = { calls: 0, exits: 0 }; const win = { Capacitor: { Plugins: { App: { exitApp: () => st.exits++ } } } };
    const A = new Function("onBack", "window", src)(() => { st.calls++; return back(); }, win); return { ...A, st }; };
  const press = (A, order) => { for (const s of order) A.hwBack(s); };
  for (const order of [["p", "d"], ["d", "p"], ["p"], ["d"]]) { const A = make(); for (let k = 0; k < 7; k++) press(A, order); assert.equal(A.st.calls, 7, `order ${order}`); }
  // plugin stops after 3 presses (page event still arrives), later resumes: still one action per press
  const B = make(); for (let k = 0; k < 3; k++) press(B, ["p", "d"]); for (let k = 0; k < 5; k++) press(B, ["d"]); for (let k = 0; k < 4; k++) press(B, ["p", "d"]); assert.equal(B.st.calls, 12, "stop and resume");
  // the page event stops instead
  const C = make(); for (let k = 0; k < 2; k++) press(C, ["d", "p"]); for (let k = 0; k < 6; k++) press(C, ["p"]); assert.equal(C.st.calls, 8, "page event stops");
  // nothing left to go back to: Android's normal exit, once per press, never twice
  const D = make(() => false); press(D, ["p", "d"]); assert.equal(D.st.exits, 1, "one exit"); assert.equal(D.st.calls, 1);
  // the same behaviour as before when only the plugin listener exists (old code: if(!onBack())exitApp())
  const E = make(() => false); press(E, ["p"]); assert.equal(E.st.exits, 1);
});
t("200% text: the tab-label shrink never reads the current text size (Android's large text is applied on top)", () => {
  const f = grab(html, "fitNav"); assert.ok(!/getComputedStyle|fontSize/.test(f), "fitNav reads or sets fontSize directly");
  assert.match(f, /--navk/); assert.match(html, /#nav button\{font-size:calc\(12px \* var\(--navk,1\)\)\}/);
  assert.match(html, /nav button\{flex:1;[^}]*font-size:12px/, "normal label size is still 12px");
});
console.log(`\n${n} checks passed`);
