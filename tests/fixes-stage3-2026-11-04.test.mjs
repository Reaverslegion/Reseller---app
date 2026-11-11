// Stage 3 fixes (4 Nov 2026): postage kinds, money worked out again when a live check finds a new bid or postage,
// spend-limit maths in the app, and missing figures said plainly. Run: node tests/fixes-stage3-2026-11-04.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
const W = new Function(src + "\nreturn { schema, checkLive, postageOf, toListing, reprice, bpf, kvSet, POST_ALLOW };")();
const app = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const r2 = (x) => Math.round(x * 100) / 100;
await W.schema(env);
await W.kvSet(env, "config", { rules: { seller: "private", post: 5, pack: 1, bpf: true, minProfit: 20 } });

await t("postage kinds: free, fixed, eBay estimate, calculated with no figure, not stated, collection only", async () => {
  const P = (o) => W.postageOf(o);
  assert.deepEqual(P({ shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "0.00" } }] }), { ship: 0, post: "free" });
  assert.deepEqual(P({ shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "4.99" } }] }), { ship: 4.99, post: "fixed" });
  assert.deepEqual(P({ shippingOptions: [{ shippingCostType: "CALCULATED", shippingCost: { value: "6.50" } }] }), { ship: 6.5, post: "est" });
  assert.deepEqual(P({ shippingOptions: [{ shippingCostType: "CALCULATED" }] }), { ship: 0, post: "calc" });
  assert.deepEqual(P({ shippingOptions: [{ shippingServiceCode: "Other" }] }), { ship: 0, post: "unknown" });
  assert.deepEqual(P({}), { ship: 0, post: "collect" });
  assert.deepEqual(P({ shippingOptions: [{ shippingServiceCode: "Other" }], pickupOptions: [{}] }), { ship: 0, post: "collect" });
  assert.equal(W.toListing({ legacyItemId: "1", price: { value: "10" }, shippingOptions: [{ shippingCostType: "CALCULATED" }] }, { id: "27386", name: "x" }, "BIN").post, "calc");
});
await t("postage not known is never counted as £0 when judging (a careful allowance, said on the card)", async () => {
  assert.match(src, /if \(postUnknown\(s\)\) \{ s\.ship = POST_ALLOW; s\.shipAllow = true; \}/);
  assert.match(src, /if \(s\.shipAllow && m\.post > s\.ship\) s\.ship/);
  assert.ok(W.POST_ALLOW >= 5);
  assert.match(app, /postage calculated by eBay · \$\{gbp\(d\.ship\)\} allowed/); assert.match(app, /postage not stated · \$\{gbp\(d\.ship\)\} allowed/);
  assert.match(app, /postage allowed for, not known/);
  // the help text must not promise the allowance is enough (heavier parcels often cost more than £5)
  assert.doesNotMatch(app, /so the profit isn't overstated/); assert.match(app, /the real profit can be lower than shown/);
});
// an auction deal as the Scan service stores it (bid £120, postage £6.50, private seller, buyer fee on)
const auction = () => { const fee = W.bpf, med = 256.99, out = 5.99, price = 120, ship = 6.5, maxBid = 214.56;
  return { id: "555", kind: "deal", type: "AUC", title: "RTX 3070 auction", price, ship, bids: 3, end: Date.now() + 3 * 3600e3, med, low: 236.99, out, sellFee: 0, bpfOn: true, maxPay: 230.99,
    maxBid, maxItem: maxBid, cost: r2(price + ship + fee(price)), profit: r2(med - out - (price + ship + fee(price))), profitAtMax: r2(med - out - (maxBid + ship + fee(maxBid))), score: 60, tags: [] }; };
const right = (d) => ({ cost: r2(d.price + d.ship + W.bpf(d.price)), profit: r2(d.med - d.out - (d.price + d.ship + W.bpf(d.price))), atMax: r2(d.med - d.out - (d.maxBid + d.ship + W.bpf(d.maxBid))) });
await t("bid goes up, down and up again; then postage changes: every stored figure and the app's copy follow", async () => {
  const d0 = auction(); db.prepare("INSERT OR REPLACE INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)").run(d0.id, JSON.stringify(d0), 60, Date.now(), Date.now() + 864e5);
  for (const [bid, ship] of [[150, 6.5], [135, 6.5], [170, 6.5], [170, 9]]) {
    globalThis.FAKE_EBAY = () => ({ buyingOptions: ["AUCTION"], currentBidPrice: { value: String(bid) }, bidCount: 5, itemEndDate: new Date(Date.now() + 3600e3).toISOString(),
      shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: String(ship) } }] });
    const r = await W.checkLive(env, "555"), d = JSON.parse(db.prepare("SELECT data FROM deals WHERE id='555'").get().data), w = right(d);
    assert.equal(d.price, bid); assert.equal(d.ship, ship);
    assert.equal(d.cost, w.cost, `cost at bid ${bid}`); assert.equal(d.profit, w.profit, `profit at bid ${bid}`); assert.equal(d.profitAtMax, w.atMax, `profit at max at bid ${bid}`);
    assert.equal(d.maxBid, ship === 9 ? 212.06 : 214.56, "max bid drops by the extra postage");
    assert.deepEqual({ profit: r.deal.profit, maxBid: r.deal.maxBid, profitAtMax: r.deal.profitAtMax }, { profit: d.profit, maxBid: d.maxBid, profitAtMax: d.profitAtMax }, "the app is sent the same figures");
  }
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["AUCTION"], currentBidPrice: { value: "215" }, bidCount: 9, itemEndDate: new Date(Date.now() + 3600e3).toISOString(), shippingOptions: [{ shippingCost: { value: "9" } }] });
  const r = await W.checkLive(env, "555"); assert.ok(r.tooDear); assert.equal(db.prepare("SELECT COUNT(*) n FROM deals WHERE id='555'").get().n, 0, "past the max bid: removed");
});
await t("a Buy It Now whose postage becomes 'not stated' keeps a careful allowance, never £0", async () => {
  const fee = W.bpf, d0 = { id: "556", kind: "deal", type: "BIN", title: "x", price: 140, ship: 4.99, med: 256.99, low: 236.99, out: 5.99, sellFee: 0, bpfOn: true, maxPay: 231, score: 60, tags: [] };
  Object.assign(d0, { cost: r2(140 + 4.99 + fee(140)), profit: r2(256.99 - 5.99 - (140 + 4.99 + fee(140))) });
  db.prepare("INSERT OR REPLACE INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)").run(d0.id, JSON.stringify(d0), 60, Date.now(), Date.now() + 864e5);
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["FIXED_PRICE"], price: { value: "140" }, shippingOptions: [{ shippingServiceCode: "Other" }] });
  await W.checkLive(env, "556"); const d = JSON.parse(db.prepare("SELECT data FROM deals WHERE id='556'").get().data);
  assert.equal(d.post, "unknown"); assert.ok(d.ship >= 5, "allowance, not £0"); assert.equal(d.profit, r2(256.99 - 5.99 - (140 + d.ship + fee(140))));
});
await t("app: the spend limit always starts from the Scan service's figures and re-works profit at your max", async () => {
  assert.match(app, /if\(!d\._srv\)d\._srv=\{maxBid:d\.maxBid,maxItem:d\.maxItem,profitAtMax:d\.profitAtMax\}/);
  assert.match(app, /S\.rules\[k\]=n;if\(k==="maxPrice"\)reLimit\(\)/); assert.match(app, /S\.rules\.maxPrice=n;reLimit\(\)/);
  assert.match(app, /d\.profitAtMax=Math\.round\(\(d\.med-\(d\.sellFee\|\|0\)-out-\(it\+ship\+fee\(it\)\)\)\*100\)\/100/);
  assert.match(app, /if\(r\.deal\)\{Object\.assign\(d,r\.deal\);d\._srv=/);
});
await t("app: missing figures are said plainly (Unknown, Not available, Not calculated, Not scored, No title)", async () => {
  for (const re of [/gbpK=\(n,w="Unknown"\)/, /gbp0K=\(n,w="Not available"\)/, /"Not calculated"/, /"Not scored"/, /\(No title\)/, /"postage unknown"/]) assert.match(app, re);
  assert.doesNotMatch(app, /gbp\(d\.price\)|gbp0\(d\.med\)/);
});
console.log(`\n${n} checks passed`);
