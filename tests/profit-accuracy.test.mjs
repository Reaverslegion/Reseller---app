// Profit accuracy (7 Nov 2026): postage out is never £0, big items cost more to post, auctions show both bids,
// zero/few-sales prices are flagged, and the optional risk allowance is shown only (never a fee).
// Runs a whole scan in memory against made-up eBay listings and a made-up price book: no real eBay calls.
// Run: node tests/profit-accuracy.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
const W = new Function(src + "\nreturn { schema, sweep, kvSet, kvGet, groupOf, bpf, sellFee, maxPay, postOutFor, cleanConfig, MIN_SALES };")();
const app = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const r2 = (x) => Math.round(x * 100) / 100;

// one in-memory database (the Scan service sets its tables up once), emptied before each scan
const DB0 = new DatabaseSync(":memory:");
function freshEnv() {
  const db = DB0;
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) db.prepare(`DELETE FROM "${name}"`).run();
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
  return { db, env: { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } } };
}
const CATS = { "80053": "Monitors", "177": "PC Laptops & Netbooks", "9355": "Mobile & Smart Phones", "139971": "Video Game Consoles" };
// made-up listings for sale, and what similar ones sold for (avg = item price, post = what buyers paid for postage)
const L = [
  { id: "1001", cat: "80053", title: "Dell P2419H 24 inch IPS Monitor", price: 40, ship: 0, book: { avg: 75, post: 0, n: 40 } },
  { id: "1002", cat: "177", title: "Lenovo ThinkPad T480 Intel Core i5-8350U 8GB 256GB SSD Laptop", price: 80, ship: 0, book: { avg: 120, post: 0, n: 30 } },
  { id: "1003", cat: "9355", title: "Apple iPhone 11 64GB Black Unlocked", price: 90, ship: 3, book: { avg: 130, post: 4, n: 50 } },
  { id: "1004", cat: "139971", title: "Sony PlayStation 5 Console Disc Edition 825GB", price: 200, ship: 0, auc: true, book: { avg: 300, post: 8, n: 60 } },
];
function summary(x) {
  return { itemId: "v1|" + x.id + "|0", legacyItemId: x.id, title: x.title, categoryId: x.cat, categories: [{ categoryId: x.cat }],
    condition: "Used", conditionId: "3000", itemWebUrl: "https://www.ebay.co.uk/itm/" + x.id, itemLocation: { country: "GB" },
    buyingOptions: [x.auc ? "AUCTION" : "FIXED_PRICE"], ...(x.auc ? { currentBidPrice: { value: String(x.price) }, bidCount: 2, itemEndDate: new Date(Date.now() + 3 * 3600e3).toISOString() } : { price: { value: String(x.price) } }),
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: String(x.ship) } }],
    seller: { username: "made-up-seller", feedbackScore: 500, feedbackPercentage: "100.0", sellerAccountType: "INDIVIDUAL" }, itemCreationDate: new Date(Date.now() - 3600e3).toISOString() };
}
async function scan(rules) {
  const { db, env } = freshEnv();
  await W.schema(env);
  await W.kvSet(env, "keyver", 3); await W.kvSet(env, "fix1", true); await W.kvSet(env, "fix2", true); await W.kvSet(env, "fix3", true);
  await W.kvSet(env, "config", { cats: Object.entries(CATS).map(([id, name]) => ({ id, name })), rules: { minScore: 0, ...rules }, types: { bin: true, auction: true, misspelt: false, spares: false } });
  const keys = {};
  for (const x of L) {
    const g = W.groupOf({ title: x.title }, x.cat, CATS[x.cat], "used"); assert.ok(g, "made-up title matches a model: " + x.title); keys[x.id] = g.key;
    db.prepare("INSERT OR REPLACE INTO prices (pkey,label,q,avg,st,post,trend,at,src,n,lo,hi) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(g.key, g.label, "", x.book.avg, 60, x.book.post, "steady", Date.now(), "fill", x.book.n, x.book.avg * 0.95, x.book.avg * 1.1);
  }
  const calls = [];
  globalThis.FAKE_EBAY = (path) => {
    calls.push(path);
    if (path.includes("item_summary/search")) {
      const cat = (path.match(/category_ids=(\d+)/) || [])[1], auc = /AUCTION/.test(decodeURIComponent(path));
      const it = L.filter((x) => x.cat === cat && !!x.auc === auc).map(summary);
      return { total: it.length, itemSummaries: it };
    }
    return {};
  };
  const rep = await W.sweep(env, true);
  const deals = db.prepare("SELECT data FROM deals").all().map((r) => JSON.parse(r.data));
  return { rep, deals, by: Object.fromEntries(deals.map((d) => [d.id, d])), calls };
}
const PRIV = { seller: "private", minProfit: 1, post: 5, pack: 1, bpf: true, cheap: false, feePct: 12.8, feeFixed: 0.4 };
const BIZ = { ...PRIV, seller: "business" };

await t("postage out: buyers' postage when they paid some; your setting when similar ones sold with free or unknown postage; never £0", async () => {
  const r = { post: 5 };
  assert.deepEqual(W.postOutFor(4, r, "Mobile & Smart Phones"), { post: 4, src: "sold" });
  assert.deepEqual(W.postOutFor(0, r, "PC Laptops & Netbooks"), { post: 5, src: "setting" }, "free postage comps: your £5, not £0");
  assert.deepEqual(W.postOutFor(null, r, "PC Laptops & Netbooks"), { post: 5, src: "setting" }, "postage not known: your £5");
  assert.deepEqual(W.postOutFor(0, r, "Monitors"), { post: 12, src: "size" }, "monitors: at least £12");
  assert.deepEqual(W.postOutFor(8, r, "Monitors"), { post: 12, src: "size" }, "buyers paid £8 but it costs about £12 to send");
  assert.deepEqual(W.postOutFor(20, r, "Monitors"), { post: 20, src: "sold" }, "never lowered below what buyers paid");
  assert.deepEqual(W.postOutFor(0, { post: 25 }, "Monitors"), { post: 25, src: "setting" }, "never lowered below your setting");
  assert.deepEqual(W.postOutFor(0, r, "PC Desktops & All-In-Ones"), { post: 15, src: "size" });
});

for (const [label, rules] of [["Private", PRIV], ["Business", BIZ]]) {
  await t(`${label} seller: a full scan of made-up listings gives the right money for every deal (no real eBay calls)`, async () => {
    const { deals, by, calls } = await scan(rules);
    assert.ok(calls.every((p) => !/^https?:\/\//.test(p) || !/ebay\.com/.test(p)), "only the fake eBay was asked");
    assert.equal(deals.length, 4, `all 4 made-up listings are deals (got ${deals.map((d) => d.id)})`);
    for (const x of L) {
      const d = by[x.id], g = W.cleanConfig({ rules }).rules;
      const med = x.book.avg + x.book.post, out = Math.max(x.book.post > 0 ? x.book.post : 5, x.cat === "80053" ? 12 : 0) + 1;
      const fee = W.sellFee(med, g), cost = x.price + x.ship + W.bpf(x.price);
      assert.equal(d.med, r2(med), x.title + " sells for (incl. buyers' postage, counted once)");
      assert.equal(d.out, r2(out), x.title + " postage + packing out");
      assert.equal(d.sellFee, r2(fee), x.title + ` selling fee (${label})`);
      if (label === "Private") assert.equal(d.sellFee, 0, "private sellers: no selling fee");
      else assert.ok(d.sellFee > 0, "business sellers pay a selling fee");
      assert.equal(d.cost, r2(cost), x.title + " cost to buy (price + postage in + buyer protection fee)");
      assert.equal(d.profit, r2(med - fee - out - cost), x.title + " profit");
      assert.equal(d.sales, x.book.n, "comparable sales count is sent to the app");
    }
    assert.equal(by["1001"].postSrc, "size"); assert.ok(by["1001"].tags.includes("Large item to post"));
    assert.equal(by["1002"].postSrc, "setting", "laptop comps sold with free postage: your £5 setting"); assert.equal(by["1003"].postSrc, "sold");
    // the £0 problem: before this fix the laptop's postage out was packing only (£1)
    assert.ok(by["1002"].out >= 6, "never £0 postage out");
  });
}

await t("auctions: profit at the current bid and at your max safe bid are both worked out, and match the sums (both seller modes)", async () => {
  for (const rules of [PRIV, BIZ]) {
    const { by } = await scan(rules), d = by["1004"], g = W.cleanConfig({ rules }).rules;
    assert.equal(d.type, "AUC"); assert.ok(d.maxBid > d.price, "max bid is above the current bid");
    const back = d.med - d.sellFee - d.out;
    assert.equal(d.profit, r2(back - (d.price + d.ship + W.bpf(d.price))), "profit at current bid");
    assert.equal(d.profitAtMax, r2(back - (d.maxBid + d.ship + W.bpf(d.maxBid))), "profit at max bid");
    assert.ok(d.profitAtMax >= g.minProfit - 0.01, `paying your max bid still leaves your £${g.minProfit} minimum (${rules.seller})`);
    assert.ok(d.profit > d.profitAtMax, "today's bid shows more profit than the max bid");
  }
});

await t("the £1 minimum profit filter still works: a listing under £1 profit is not a deal", async () => {
  const keep = L[2].price; L[2].price = 129; // iPhone: sells for £134, minus £5 out and buyer fee → under £1
  try { const { by } = await scan(PRIV); assert.equal(by["1003"], undefined, "under £1 profit is not shown"); } finally { L[2].price = keep; }
});

await t("under 8 comparable sales is still not a deal; spares (no minimum) are flagged; asking-price guesses say 0 sales", async () => {
  const keep = L[1].book.n; L[1].book.n = 5;
  try { const { by } = await scan(PRIV); assert.equal(by["1002"], undefined, "5 sales: not a deal (unchanged rule)"); } finally { L[1].book.n = keep; }
  assert.match(src, /sales === 0 \? \["Price not confirmed by sales"\] : sales < MIN_SALES \? \["Few sales behind the price"\] : \[\]/, "spares flagged");
  assert.match(src, /sales: m\.src === "asking" \? 0 :/, "asking-price guesses count as 0 sales");
  assert.equal(W.MIN_SALES, 8);
});

await t("risk allowance: a setting (0 = off by default) checked by the Scan service, shown only, never a fee", async () => {
  assert.equal(W.cleanConfig({}).rules.riskPct, 0, "off unless you set it");
  assert.equal(W.cleanConfig({ rules: { riskPct: 3 } }).rules.riskPct, 3);
  assert.equal(W.cleanConfig({ rules: { riskPct: 99 } }).rules.riskPct, 0, "silly values fall back to off");
  const a = await scan({ ...PRIV, riskPct: 0 }), b = await scan({ ...PRIV, riskPct: 10 });
  const money = (x) => x.deals.map((d) => [d.id, d.profit, d.lowProfit, d.profitAtMax, d.maxBid, d.out, d.sellFee, d.cost]).sort();
  assert.deepEqual(money(b), money(a), "profit, max bid, fees and which deals show are unchanged");
  // the score moves a little between any two scans (listing age), so instead: the Scan service never uses riskPct in a sum
  assert.deepEqual(src.match(/riskPct/g).length, 3, "riskPct only appears in the default and the settings check");
  assert.doesNotMatch(src, /r\.riskPct|rules\.riskPct/, "never used when judging deals");
  assert.match(app, /riskPct:0,paused/, "app default is off"); assert.match(app, /riskPct:\+h\.riskPct\|\|0/, "sent to the Scan service");
  assert.match(app, /optional cushion you set, not a fee/); assert.match(app, /risk allowance \(not a fee\)/);
  assert.match(app, /const riskAmt=d=>\{const p=\+H\(\)\.riskPct\|\|0;return p>0&&known\(d\.med\)\?Math\.round\(d\.med\*p\)\/100:0\}/);
});

await t("app: auction card says which profit is at the max bid and which at the current bid; postage source explained", async () => {
  assert.match(app, /first figure if you pay your max bid, second at the current bid/);
  assert.match(app, /at the current bid \$\{sgn\(d\.profit\)\}/, "ending-later list shows both");
  assert.match(app, /"Large item to post":\["Large item – postage estimated"/); assert.match(app, /not real shipping prices/);
  assert.match(app, /estimate for a large item, not a quote/); assert.match(src, /PROVISIONAL ESTIMATES/);
  assert.match(app, /your postage setting \(similar ones sold with free or unknown postage\)/);
  assert.equal((app.match(/"Few sales behind the price":/g) || []).length, 1, "one explanation per tag");
});
console.log(`\n${n} checks passed`);
