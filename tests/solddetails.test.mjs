// Sold details from eBay's Trading API: GetItem reply parsing, the per-scan batch, and time-to-sell from upload time.
// Run: node tests/solddetails.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { schema, soldDetails, sellStats, kvSet, kvGet, getItemTrading, DAY };")();
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } }, EBAY_ID: "id", EBAY_SECRET: "s" };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const DAY = W.DAY, now = Date.now();
await W.schema(env);
const xml = (id) => id === "3" ? "<GetItemResponse><Ack>Failure</Ack><Errors><ErrorCode>17</ErrorCode></Errors></GetItemResponse>"
  : `<GetItemResponse><Ack>Success</Ack><Item><ListingDetails><StartTime>${new Date(now - (id === "1" ? 10 : 400) * DAY).toISOString()}</StartTime></ListingDetails><ListingType>${id === "2" ? "FixedPriceItem" : "Chinese"}</ListingType><Quantity>${id === "2" ? 50 : 1}</Quantity><SellingStatus><QuantitySold>${id === "2" ? 30 : 1}</QuantitySold></SellingStatus><Seller><UserID>bob_${id}</UserID></Seller></Item></GetItemResponse>`;
globalThis.fetch = async (url, o) => url.includes("oauth2/token")
  ? { ok: true, json: async () => ({ access_token: "A", expires_in: 7200 }) }
  : { ok: true, text: async () => xml(String(o.body).match(/<ItemID>(\d+)/)[1]) };
await t("GetItem reply: upload time, seller, format, quantities", async () => {
  const g = await W.getItemTrading(env, "A", "2");
  assert.equal(g.fmt, "FixedPriceItem"); assert.equal(g.seller, "bob_2"); assert.equal(g.qty, 50); assert.equal(g.sold, 30); assert.ok(g.start < now);
});
await t("a batch fills in sold details; items eBay no longer has are marked so they aren't asked again", async () => {
  await W.kvSet(env, "ebayUser", { refresh: "R", refreshExp: now + 100 * DAY });
  db.prepare("INSERT INTO fillseen (id,cat,price,at,pkey) VALUES ('1','27386',150,?,'gpu:x|used'),('2','27386',150,?,'gpu:x|used'),('3','27386',150,?,'gpu:x|used')").run(now - 2 * DAY, now - DAY, now - DAY);
  const rep = { errors: [] };
  await W.soldDetails(env, rep);
  assert.deepEqual([rep.soldDetails.found, rep.soldDetails.missing], [2, 1]);
  const r = db.prepare("SELECT seller, fmt, start_at FROM fillseen WHERE id='1'").get();
  assert.equal(r.seller, "bob_1"); assert.equal(r.fmt, "Chinese");
  assert.equal(db.prepare("SELECT gi_at FROM fillseen WHERE id='3'").get().gi_at, 0);
  const again = { errors: [] }; await W.soldDetails(env, again); assert.equal(again.soldDetails, undefined); // nothing left to ask
});
await t("time to sell uses single-item listings only (a 50-unit listing says how old the listing is)", async () => {
  const m = await W.sellStats(env);
  assert.equal(m["gpu:x|used"].n, 1); assert.ok(Math.abs(m["gpu:x|used"].med - 8) < 0.2);
});
await t("no token connected: nothing is looked up", async () => {
  await W.kvSet(env, "ebayUser", null); db.prepare("INSERT INTO fillseen (id,cat,price,at) VALUES ('9','1',1,?)").run(now);
  const rep = { errors: [] }; await W.soldDetails(env, rep); assert.equal(rep.soldDetails, undefined);
});
console.log(`\n${n} checks passed`);
