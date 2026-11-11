// Fixes for the independent back-end review (4 Nov 2026), each checked by running the real Scan service code against an
// in-memory database and a fake eBay. Run: node tests/review-fixes-2026-11-04.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
src = src.replace("async function push(env, title, body, data) {", "async function push(env, title, body, data) { globalThis.PUSHED.push({ title, body }); return { sent: 1 };\n}\nasync function pushReal(env, title, body, data) {");
const W = new Function(src + "\nreturn { schema, checkLive, bpf, kvSet, kvGet, toListing, sweep, VERIFIED_CATS, cleanConfig, checkFollows, cleanMsg };")();
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } }, FCM_SA: "test" };
globalThis.PUSHED = [];
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const r2 = (x) => Math.round(x * 100) / 100;
await W.schema(env);
await W.kvSet(env, "config", { rules: { seller: "private", post: 5, pack: 1, bpf: true, minProfit: 20 } });
const put = (d) => db.prepare("INSERT OR REPLACE INTO deals (id,data,score,created,expires,notified) VALUES (?,?,?,?,?,0)").run(d.id, JSON.stringify(d), d.score || 60, Date.now(), Date.now() + 864e5);
const get = (id) => { const r = db.prepare("SELECT data FROM deals WHERE id=?").get(id); return r ? JSON.parse(r.data) : null; };
const bin = (id, over = {}) => ({ id, kind: "deal", type: "BIN", title: "RTX 3080", price: 250, ship: 5, med: 360, low: 340, out: 6, sellFee: 0, bpfOn: true, maxPay: 307.51, score: 80, tags: [], cat: "27386", ...over });
const item = (price, ship, extra = {}) => ({ buyingOptions: ["FIXED_PRICE"], price: { value: String(price), currency: "GBP" }, shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: String(ship) } }], ...extra });

await t("Buy It Now: the buyer fee counts when deciding a deal has become too dear (was ignored)", async () => {
  // £302.50 + £5 postage is under £307.51, but with eBay's buyer fee (£12.75) the real cost is £320.25: too dear
  put(bin("901")); globalThis.FAKE_EBAY = () => item(302.5, 5);
  const r = await W.checkLive(env, "901");
  assert.equal(r.tooDear, true); assert.equal(get("901"), null, "removed");
  // £290 + £5 + fee £12.35 = £307.35 ≤ £307.51: still fine, kept, with the fee in its cost
  put(bin("902")); globalThis.FAKE_EBAY = () => item(290, 5);
  const k = await W.checkLive(env, "902"), d = get("902");
  assert.ok(!k.tooDear && d, "kept"); assert.equal(d.cost, r2(290 + 5 + W.bpf(290))); assert.ok(d.cost <= 307.51);
});
await t("auction: extra postage lowers the max bid BEFORE the bid is compared (no kept deal with bid ≥ max bid)", async () => {
  put({ id: "903", kind: "deal", type: "AUC", title: "RTX 3070 auction", price: 150, ship: 5, bids: 3, end: Date.now() + 3600e3, med: 256.99, low: 236.99, out: 5.99,
    sellFee: 0, bpfOn: true, maxPay: 230.99, maxBid: 214.56, maxItem: 214.56, score: 60, tags: [], cat: "27386" });
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["AUCTION"], currentBidPrice: { value: "213", currency: "GBP" }, bidCount: 5, itemEndDate: new Date(Date.now() + 3600e3).toISOString(),
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "9" } }] });
  const r = await W.checkLive(env, "903");
  assert.equal(r.tooDear, true, "max bid 214.56 - £4 extra postage = 210.56 < bid 213"); assert.equal(get("903"), null);
});
await t("a Buy It Now deal on a listing that is also an auction keeps its Buy It Now price (not the current bid)", async () => {
  put(bin("904", { price: 250, maxPay: 330 }));
  globalThis.FAKE_EBAY = () => item(250, 5, { buyingOptions: ["AUCTION", "FIXED_PRICE"], currentBidPrice: { value: "99", currency: "GBP" } });
  await W.checkLive(env, "904"); const d = get("904");
  assert.equal(d.price, 250); assert.equal(d.type, "BIN");
});
await t("an unreadable or foreign-currency price is treated as no price (never stored as NaN or as pounds)", async () => {
  put(bin("905", { maxPay: 330 })); globalThis.FAKE_EBAY = () => item("abc", 5);
  await W.checkLive(env, "905"); assert.equal(get("905").price, 250, "kept the last good price");
  globalThis.FAKE_EBAY = () => ({ ...item(200, 5), price: { value: "200", currency: "USD" } });
  await W.checkLive(env, "905"); assert.equal(get("905").price, 250);
  assert.equal(W.toListing({ legacyItemId: "906", price: { value: "80", currency: "USD" } }, { id: "27386", name: "x" }, "BIN"), null, "a scan skips it too");
});
await t("no phone alert for a deal the alert check itself has just found too dear (and removed)", async () => {
  db.prepare("DELETE FROM deals").run(); PUSHED.length = 0;
  const cat = Object.keys(W.VERIFIED_CATS)[0];
  await W.kvSet(env, "config", { cats: [{ id: cat, name: "x" }], alerts: true, rules: { seller: "private", post: 5, pack: 1, bpf: true, minProfit: 20, alertScore: 70 } });
  await W.kvSet(env, "keyver", 3); await W.kvSet(env, "fix1", true);
  // the scan only reaches its alert step when eBay returned something, so give it one unrelated listing
  const other = { itemId: "v1|990000000001|0", legacyItemId: "990000000001", title: "unrelated thing", categoryId: cat, price: { value: "5", currency: "GBP" }, buyingOptions: ["FIXED_PRICE"] };
  const fake = (bad) => (path) => (/item_summary\/search/.test(path) ? { itemSummaries: [other], total: 1 } : /get_item_by_legacy_id/.test(path) ? (/907/.test(path) ? item(bad ? 302.5 : 250, 5) : item(5, 0)) : {});
  // control: still a good price → exactly one alert (proves the alert step really runs in this test)
  put(bin("907", { cat, score: 92, cost: 272.5, profit: 76.5 })); globalThis.FAKE_EBAY = fake(false);
  await W.kvSet(env, "lastRun", 0); await W.sweep(env, true);
  assert.equal(PUSHED.filter((p) => /RTX 3080/.test(p.title)).length, 1, "control: a good deal is alerted");
  // now too dear at alert time → no alert, removed
  PUSHED.length = 0; db.prepare("DELETE FROM deals").run(); put(bin("907", { cat, score: 92, cost: 272.5, profit: 76.5 })); globalThis.FAKE_EBAY = fake(true);
  await W.kvSet(env, "lastRun", 0); await W.sweep(env, true);
  assert.equal(PUSHED.filter((p) => /RTX 3080/.test(p.title)).length, 0, "no alert"); assert.equal(get("907"), null, "removed");
});
await t("money settings sent to the Scan service are checked there too (text, negative, absurd values fall back)", async () => {
  const r = W.cleanConfig({ rules: { post: "5", pack: -100, feePct: "abc", feeFixed: 999, minProfit: -1, minRoi: "x", seller: "hacker", maxSpend: "150" } }).rules;
  assert.deepEqual({ post: r.post, pack: r.pack, feePct: r.feePct, feeFixed: r.feeFixed, minProfit: r.minProfit, minRoi: r.minRoi, seller: r.seller, maxSpend: r.maxSpend },
    { post: 5, pack: 1, feePct: 12.8, feeFixed: 0.4, minProfit: 20, minRoi: 0, seller: "business", maxSpend: 150 });
  const ok = W.cleanConfig({ rules: { post: 3.5, pack: 0, feePct: 10, seller: "private", minProfit: 15 } }).rules;
  assert.deepEqual([ok.post, ok.pack, ok.feePct, ok.seller, ok.minProfit], [3.5, 0, 10, "private", 15], "good values kept");
});
await t("the live re-check updates the stored listing price (a later scan can't revive a removed deal from its old price)", async () => {
  db.prepare("INSERT OR REPLACE INTO listings (id, price, ship, status) VALUES ('908', 250, 5, 'live')").run();
  put(bin("908")); globalThis.FAKE_EBAY = () => item(302.5, 5);
  await W.checkLive(env, "908");
  assert.equal(db.prepare("SELECT price FROM listings WHERE id='908'").get().price, 302.5);
});
await t("followed listings: every one gets its turn, 10 per run, least recently checked first", async () => {
  db.prepare("DELETE FROM follows").run(); const seen = new Set();
  for (let i = 0; i < 25; i++) db.prepare("INSERT INTO follows (id, data, max, created) VALUES (?,?,?,?)").run(String(800 + i), JSON.stringify({ title: "f" + i, status: "live" }), 100, Date.now() - i * 1000);
  globalThis.FAKE_EBAY = (path) => { seen.add((path.match(/legacy_item_id=(\d+)/) || [])[1]); return item(90, 0); };
  for (let run = 0; run < 3; run++) await W.checkFollows(env, W.cleanConfig({}));
  assert.equal(seen.size, 25, `${seen.size} of 25 followed listings checked in 3 runs`);
});
await t("keys written in other ways are hidden in the problem log too", async () => {
  for (const x of ["X-FlipScout-Key: hunter2pass", "apikey=hunter2", "api_key: zz9"]) assert.ok(!/hunter2|zz9/.test(W.cleanMsg(x)), x);
  assert.equal(W.cleanMsg("Cannot read properties of undefined (reading 'price')"), "Cannot read properties of undefined (reading 'price')");
});
console.log(`\n${n} checks passed`);
