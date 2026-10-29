// Auction deals with a Buy It Now option aren't deleted as "too dear"; every deal that leaves the list records why.
// Run: node tests/dealout.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
const W = new Function(src + "\nreturn { schema, checkLive, descFaults, MIN_SALES };")();
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
await W.schema(env);
const addDeal = (id, d) => db.prepare("INSERT OR REPLACE INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)").run(id, JSON.stringify({ id, kind: "deal", title: "RTX 3070 " + id, ...d }), 80, Date.now(), Date.now() + 864e5);
const why = (id) => (db.prepare("SELECT why FROM deal_out WHERE id=?").get(id) || {}).why;
const has = (id) => !!db.prepare("SELECT id FROM deals WHERE id=?").get(id);

await t("an auction with a Buy It Now option is judged on its current bid, not the Buy It Now price", async () => {
  addDeal("1", { type: "AUC", price: 120, ship: 5, maxBid: 200 });
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["AUCTION", "FIXED_PRICE"], currentBidPrice: { value: "130" }, price: { value: "320" }, bidCount: 3, itemEndDate: new Date(Date.now() + 3600e3).toISOString() });
  const r = await W.checkLive(env, "1");
  assert.ok(r.live && !r.tooDear); assert.equal(r.price, 130); assert.ok(has("1"));
});
await t("a bid past the max bid removes the deal and says why", async () => {
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["AUCTION"], currentBidPrice: { value: "210" }, bidCount: 9, itemEndDate: new Date(Date.now() + 3600e3).toISOString() });
  const r = await W.checkLive(env, "1");
  assert.ok(r.tooDear); assert.ok(!has("1")); assert.equal(why("1"), "bid passed max bid");
});
await t("sold out and ended deals record why", async () => {
  addDeal("2", { type: "BIN", price: 100, ship: 5, maxPay: 150 });
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["FIXED_PRICE"], price: { value: "100" }, estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK" }] });
  assert.equal((await W.checkLive(env, "2")).live, false); assert.equal(why("2"), "sold out");
  addDeal("3", { type: "BIN", price: 100, ship: 5, maxPay: 150 });
  globalThis.FAKE_EBAY = () => ({ notFound: true });
  await W.checkLive(env, "3"); assert.equal(why("3"), "listing removed");
});
await t("rejected listings keep a reason (rules code records it)", async () => {
  assert.match(src, /whyId\[s\.id\] = "over"/); assert.match(src, /"rules: " \+ \(whyId\[id\]/);
  assert.match(src, /INSERT OR REPLACE INTO deal_out \(id, at, why, price, title\) SELECT id, \$\{now\}, 'expired'/);
});
await t("faults written only in the description are found; denied ones aren't (live laptop deal, 29 Oct)", async () => {
  assert.deepEqual(W.descFaults("Battery does not hold the charge, tested , factory reset done.\nPlease note , requires a new battery - No charger included"),
    ["battery does not hold the charge", "requires a new battery", "no charger"]);
  assert.deepEqual(W.descFaults("Great condition, not cracked, no water damage, comes with charger"), []);
  assert.deepEqual(W.descFaults("iCloud locked, sold for parts"), ["icloud locked"]);
});
await t("a deal whose description shows a fault is tagged, scored 49 at most, and reported (so no alert)", async () => {
  addDeal("4", { type: "BIN", price: 59.99, ship: 0, maxPay: 120, score: 78, tags: [] });
  globalThis.FAKE_EBAY = () => ({ buyingOptions: ["FIXED_PRICE"], price: { value: "59.99" }, description: "<p>Battery does not hold the charge</p><p>No charger included</p>" });
  const r = await W.checkLive(env, "4");
  assert.ok(r.live && r.fault.length === 2);
  const d = JSON.parse(db.prepare("SELECT data FROM deals WHERE id='4'").get().data);
  assert.equal(d.score, 49); assert.ok(d.tags.includes("Fault in description"));
});
await t("deals need 8+ sales behind the price", async () => { assert.equal(W.MIN_SALES, 8); assert.match(src, /< MIN_SALES\) \{ why\.noData\+\+/); });
console.log(`\n${n} checks passed`);
