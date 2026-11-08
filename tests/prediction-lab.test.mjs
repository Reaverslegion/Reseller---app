// Prediction Lab (8 Nov 2026): fixed-rule selection, permanent snapshots, outcome classification, later-sales validation,
// dashboard figures, missing data, and "off means nothing happens". Whole scans run in memory against a fake eBay:
// no real eBay calls. Run: node tests/prediction-lab.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
// eBay's GetItem and the user token are replaced by fakes the test controls
src = src.replace("async function getItemTrading(env, tok, id) {", "async function getItemTrading(env, tok, id) { globalThis.GI_CALLS.push(id); return globalThis.FAKE_GI(id);\n}\nasync function getItemTradingReal(env, tok, id) {");
src = src.replace(/(async )?function ebayUserToken\(/, (m) => `async function ebayUserToken() { return globalThis.FAKE_TOKEN; }\n${m.replace("ebayUserToken", "ebayUserTokenReal")}`);
const W = new Function(src + "\nreturn { schema, sweep, kvSet, kvGet, groupOf, bpf, sellFee, labPick, labClassify, labSnapshot, labOutcomes, labComps, labSummary, labRows, labCsv, LAB_PER_CAT, LAB_SPREAD, DAY };")();
const app = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
globalThis.GI_CALLS = []; globalThis.FAKE_TOKEN = "tok"; globalThis.FAKE_GI = () => ({ missing: true });

const DB0 = new DatabaseSync(":memory:");
function freshEnv() {
  const db = DB0;
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) db.prepare(`DELETE FROM "${name}"`).run();
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
  return { db, env: { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } } };
}
const CATS = { "9355": "Mobile & Smart Phones", "139971": "Video Game Consoles" };
const L = [
  { id: "2001", cat: "139971", title: "Sony PlayStation 5 Console Disc Edition 825GB", price: 200, ship: 0, book: { avg: 300, post: 8, n: 60 } },
  { id: "2002", cat: "139971", title: "Sony PlayStation 5 Console Digital Edition 825GB", price: 150, ship: 0, book: { avg: 250, post: 8, n: 40 } },
  { id: "2003", cat: "9355", title: "Apple iPhone 11 64GB Black Unlocked", price: 60, ship: 3, book: { avg: 130, post: 4, n: 50 } },
];
const summary = (x, endH) => ({ itemId: "v1|" + x.id + "|0", legacyItemId: x.id, title: x.title, categoryId: x.cat, categories: [{ categoryId: x.cat }], condition: "Used", conditionId: "3000",
  itemWebUrl: "https://www.ebay.co.uk/itm/" + x.id, itemLocation: { country: "GB" }, buyingOptions: ["AUCTION"], currentBidPrice: { value: String(x.price) }, bidCount: 2,
  itemEndDate: new Date(Date.now() + endH * 3600e3).toISOString(), shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: String(x.ship) } }],
  seller: { username: "made-up-seller", feedbackScore: 500, feedbackPercentage: "100.0", sellerAccountType: "INDIVIDUAL" }, itemCreationDate: new Date(Date.now() - 3600e3).toISOString() });
const RULES = { seller: "private", minProfit: 1, post: 5, pack: 1, bpf: true, cheap: false, feePct: 12.8, feeFixed: 0.4, minScore: 0 };
async function setup(labOn, endH = 3) {
  const { db, env } = freshEnv();
  await W.schema(env);
  for (const k of ["keyver"]) await W.kvSet(env, k, 3);
  for (const k of ["fix1", "fix2", "fix3"]) await W.kvSet(env, k, true);
  await W.kvSet(env, "config", { cats: Object.entries(CATS).map(([id, name]) => ({ id, name })), rules: RULES, types: { bin: false, auction: true, misspelt: false, spares: false } });
  if (labOn) await W.kvSet(env, "lab", { on: true, since: Date.now() });
  const keys = {};
  for (const x of L) { const g = W.groupOf({ title: x.title }, x.cat, CATS[x.cat], "used"); keys[x.id] = g.key;
    db.prepare("INSERT OR REPLACE INTO prices (pkey,label,q,avg,st,post,trend,at,src,n,lo,hi) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(g.key, g.label, "", x.book.avg, 60, x.book.post, "steady", Date.now() - 86400e3, "fill", x.book.n, x.book.avg * 0.95, x.book.avg * 1.1); }
  globalThis.FAKE_EBAY = (path) => { if (path.includes("item_summary/search")) { const cat = (path.match(/category_ids=(\d+)/) || [])[1], auc = /AUCTION/.test(decodeURIComponent(path));
    const it = auc ? L.filter((x) => x.cat === cat).map((x) => summary(x, endH)) : []; return { total: it.length, itemSummaries: it }; } return {}; };
  return { db, env, keys };
}
const snaps = (db) => db.prepare("SELECT * FROM lab_snap ORDER BY item_id").all();

await t("off by default: a scan saves no predictions and makes no outcome lookups", async () => {
  const { db, env } = await setup(false); globalThis.GI_CALLS = [];
  await W.sweep(env, true);
  assert.equal(snaps(db).length, 0); assert.equal(globalThis.GI_CALLS.length, 0);
});

await t("switched on: one auction per category per scan is saved, with the scan's own figures (max bid, profit at max)", async () => {
  const { db, env } = await setup(true);
  await W.sweep(env, true);
  const S = snaps(db); assert.equal(S.length, 2, "one per category: " + S.map((r) => r.item_id));
  assert.deepEqual([...new Set(S.map((r) => r.cat))].sort(), ["139971", "9355"]);
  const deals = Object.fromEntries(db.prepare("SELECT data FROM deals").all().map((r) => JSON.parse(r.data)).map((d) => [d.id, d]));
  for (const r of S) {
    const s = JSON.parse(r.snap); assert.equal(s.calc, "profit-2026-11-07"); assert.equal(s.exp, "lab1");
    for (const k of ["price", "ship", "end_at", "max_bid", "med", "low", "fee_at_med", "post_out", "pack", "profit_at_max", "rules", "src", "book_n", "base_n"]) assert.ok(k in s, "snapshot has " + k);
    const atMax = s.max_bid + s.ship + (s.bpf_on ? W.bpf(s.max_bid) : 0);
    assert.ok(Math.abs(s.profit_at_max - (s.med - W.sellFee(s.med, s.rules) - s.post_out - s.pack - atMax)) < 0.011, "profit at max adds up");
    const d = deals[r.item_id];
    if (d) { assert.equal(s.shown_as_deal, true); assert.equal(s.max_bid, d.maxBid, "same max bid as the deal"); assert.ok(Math.abs(s.profit_at_max - d.profitAtMax) < 0.011, "same profit at max as the deal"); assert.equal(s.score, d.score); }
  }
});

await t("snapshots are permanent: the database refuses edits, and later scans never overwrite or duplicate them", async () => {
  const { db, env } = await setup(true);
  await W.sweep(env, true);
  const before = snaps(db);
  assert.throws(() => db.prepare("UPDATE lab_snap SET snap='{}' WHERE item_id=?").run(before[0].item_id), /permanent/);
  L[0].price = 260; L[2].price = 99; // prices move; the saved prediction must not
  try { await W.kvSet(env, "lastManual", 0); await W.sweep(env, true); } finally { L[0].price = 200; L[2].price = 60; }
  assert.deepEqual(snaps(db), before, "no change and no new rows (one per category every 4 days)");
});

await t("selection rules: time window, per-category cap, 4-day spread, fixed order that ignores how profitable an auction looks", async () => {
  const now = Date.parse("2026-11-08T10:00:00Z"), H = 3600e3;
  const mk = (id, cat, leftH, profit) => ({ item_id: id, cat, end_at: now + leftH * H, profit_at_max: profit });
  const c = [mk("a1", "1", 3, 50), mk("a2", "1", 3, 1), mk("a3", "1", 3, 20), mk("b1", "2", 0.5, 9), mk("b2", "2", 30, 9), mk("c1", "3", 5, 2)];
  const p = W.labPick(c, {}, now).map((x) => x.item_id).sort();
  assert.ok(!p.includes("b1") && !p.includes("b2"), "under 1 h or over 12 h left: skipped");
  assert.equal(p.filter((x) => x[0] === "a").length, 1, "one per category"); assert.ok(p.includes("c1"));
  const flipped = c.map((x) => ({ ...x, profit_at_max: -x.profit_at_max }));
  assert.deepEqual(W.labPick(flipped, {}, now).map((x) => x.item_id).sort(), p, "profit doesn't change the choice");
  assert.equal(W.labPick(c, { 1: { n: W.LAB_PER_CAT, last: 0 } }, now).some((x) => x.cat === "1"), false, "category full");
  assert.equal(W.labPick(c, { 1: { n: 1, last: now - W.DAY } }, now).some((x) => x.cat === "1"), false, "too soon after the last one");
  assert.equal(W.labPick(c, { 1: { n: 1, last: now - W.LAB_SPREAD } }, now).some((x) => x.cat === "1"), true, "allowed after 4 days");
});

await t("outcome classification: win, loss, never assumes a sale, missing data stays pending or unknown", async () => {
  const s = { max_bid: 150 }, C = (g) => W.labClassify(s, g);
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: 1, price: 150, cur: "GBP" }).status, "win", "equal to max = win");
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: 1, price: 150.01, cur: "GBP" }).status, "loss");
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: 0, price: 99, cur: "GBP" }).status, "unknown", "ended unsold is not a sale");
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: null, price: 99 }).status, "unknown", "sale not confirmed");
  assert.equal(C({ listStatus: "Active", fmt: "Chinese" }).status, "pending");
  assert.equal(C({ missing: true, err: "17" }).status, "pending");
  assert.equal(C({ listStatus: "Completed", fmt: "FixedPriceItem", sold: 1, price: 90 }).status, "unknown");
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: 1, price: 90, cur: "USD" }).status, "unknown");
  assert.equal(C({ listStatus: "Completed", fmt: "Chinese", sold: 1, price: 0 }).status, "unknown");
  assert.equal(W.labClassify({}, { listStatus: "Completed", fmt: "Chinese", sold: 1, price: 90 }).status, "unknown", "no saved max bid");
});

await t("outcome checks: only ended auctions, one GetItem each, results kept apart from predictions; no account = pending, then unknown", async () => {
  const { db, env } = await setup(true);
  await W.sweep(env, true);
  const S = snaps(db), sn = Object.fromEntries(S.map((r) => [r.item_id, JSON.parse(r.snap)]));
  const later = Date.now() + 4 * 3600e3, R = {};
  globalThis.GI_CALLS = []; await W.labOutcomes(env, R, Date.now()); assert.equal(globalThis.GI_CALLS.length, 0, "nothing looked up before the end");
  globalThis.FAKE_GI = (id) => ({ listStatus: "Completed", fmt: "Chinese", sold: 1, cur: "GBP", bids: 9, price: id === S[0].item_id ? sn[id].max_bid - 1 : sn[id].max_bid + 5 });
  await W.labOutcomes(env, R, later);
  assert.equal(globalThis.GI_CALLS.length, S.length);
  const O = Object.fromEntries(db.prepare("SELECT * FROM lab_out").all().map((o) => [o.item_id, o]));
  assert.equal(O[S[0].item_id].status, "win"); assert.equal(O[S[1].item_id].status, "loss");
  assert.deepEqual(snaps(db), S, "predictions untouched");
  globalThis.GI_CALLS = []; await W.labOutcomes(env, R, later + 3600e3); assert.equal(globalThis.GI_CALLS.length, 0, "decided results aren't looked up again");
  // no eBay account connected: pending with a reason, retried at most 5 times, then unknown
  db.prepare("DELETE FROM lab_out").run(); globalThis.FAKE_TOKEN = null;
  try { for (let i = 0; i < 6; i++) await W.labOutcomes(env, R, later + i * 7 * 3600e3); } finally { globalThis.FAKE_TOKEN = "tok"; }
  const o = db.prepare("SELECT * FROM lab_out").all();
  assert.ok(o.every((x) => x.status === "unknown" && x.tries === 5 && /not connected/.test(x.detail)), JSON.stringify(o[0]));
});

await t("later sales only: sales before the prediction, and the auction's own sale, are never used as validation", async () => {
  const { db, env, keys } = await setup(true);
  await W.sweep(env, true);
  const s = snaps(db).find((r) => r.cat === "9355"), k = keys["2003"];
  const ins = db.prepare("INSERT INTO sales (id,pkey,cat,price,kind,at) VALUES (?,?,?,?,?,?)");
  ins.run("old1", k, "9355", 120, "fill", s.created - 1000); ins.run(s.item_id, k, "9355", 110, "auction", s.created + 5000);
  ins.run("new1", k, "9355", 131, "fill", s.created + 9000); ins.run("new2", k, "9355", 139, "auction", s.created + 19000); ins.run("other", "zz", "9355", 50, "fill", s.created + 9000);
  await W.kvSet(env, "labCompsAt", 0); await W.labComps(env, Date.now());
  assert.deepEqual(db.prepare("SELECT sale_id FROM lab_comp ORDER BY sale_id").all().map((r) => r.sale_id), ["new1", "new2"]);
});

await t("dashboard figures: sample sizes, win rate only from decided auctions, resale error vs a median baseline, hypothetical profit", async () => {
  const now = Date.now(), rules = { seller: "private", feePct: 12.8, feeFixed: 0.4, minProfit: 1, post: 5, pack: 1, bpf: true };
  const row = (id, cat, status, final, med, base, comps, score) => ({ item_id: id, cat, created: now - 9e6, end_at: now - 1e6, status, final, why: null,
    snap: { cat_name: cat, title: "x", med, base_med: base, max_bid: 100, price: 60, ship: 0, bpf_on: true, post_out: 5, pack: 1, rules, score }, comps: comps.map((p) => ({ price: p })) });
  const S = W.labSummary([row("1", "Phones", "win", 90, 200, 220, [190, 210], 80), row("2", "Phones", "loss", 120, 150, null, [], 55), row("3", "Consoles", "unknown", null, 300, 300, [330], null), row("4", "Consoles", null, null, 100, null, [], 40)], now);
  assert.equal(S.tracked, 4); assert.equal(S.win, 1); assert.equal(S.loss, 1); assert.equal(S.unknown, 1); assert.equal(S.pending, 1); assert.equal(S.decided, 2); assert.equal(S.winPct, 50);
  assert.equal(S.resale.n, 2); assert.equal(S.resale.baseN, 2); assert.equal(S.resale.beatBase, 1, "item 1 beat its baseline (200 vs 220 against 200), item 3 tied");
  const i1 = S.items.find((i) => i.id === "1"); assert.equal(i1.later, 200); assert.equal(i1.err, 0);
  assert.equal(i1.hyp, Math.round((200 - W.sellFee(200, rules) - 5 - 1 - (90 + W.bpf(90))) * 100) / 100, "hypothetical profit uses the saved costs");
  assert.equal(S.items.find((i) => i.id === "2").later, null, "no later sales: no accuracy figure invented");
  const ph = S.byCat.find((g) => g.name === "Phones"); assert.equal(ph.winPct, 50); assert.equal(ph.decided, 2);
  assert.ok(S.byScore.find((g) => g.name === "Not a deal (no score)"));
  assert.ok(S.limits.some((l) => /simulated/.test(l)) && S.limits.some((l) => /never counted as sold/.test(l)));
  const csv = W.labCsv(S); assert.match(csv.split("\n")[0], /^id,cat,title,created,end_at,status,final,max_bid/); assert.equal(csv.split("\n").length, 5);
  assert.deepEqual(W.labSummary([], now).winPct, null, "empty experiment: no percentages");
});

await t("app: Prediction Lab screen is owner-only (Settings, owner tools), shows sample sizes and an export", async () => {
  assert.match(app, /function vLab\(\)/); assert.match(app, /Prediction Lab/); assert.match(app, /lab=1&csv=1|"lab=1&csv=1"/);
  assert.match(app, /simulated/i); assert.match(app, /n=\$\{|\(n=|of \$\{/, "sample sizes beside percentages");
});
console.log(`\n${n} checks passed`);
