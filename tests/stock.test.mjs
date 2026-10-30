// Full stock check: pages through every listing (price bands when eBay's 10,000 cap is hit), refreshes last_seen,
// and marks Buy It Nows ended only when two passes in a row missed them. Run: node tests/stock.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function ebay(env, path) {", "async function ebay(env, path) { return globalThis.FAKE_EBAY(path);\n}\nasync function ebayReal(env, path) {");
const W = new Function(src + "\nreturn { schema, stockStep, kvGet, kvSet, DAY, STOCK_CALLS };")();
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
await W.schema(env);
// a fake eBay category: 12,000 listings priced £1–£600 (over the 10,000 a search can return, so it must split)
let shop = Array.from({ length: 12000 }, (_, i) => ({ id: String(100000 + i), price: 1 + (i % 600) }));
let calls = 0;
globalThis.FAKE_EBAY = (path) => {
  calls++;
  const u = new URL("https://x" + path), f = decodeURIComponent(u.searchParams.get("filter")), m = f.match(/price:\[(\d+)\.\.(\d+)\]/);
  const lo = +m[1], hi = +m[2], off = +u.searchParams.get("offset"), lim = +u.searchParams.get("limit");
  const all = shop.filter((x) => x.price >= lo && x.price <= hi).sort((a, b) => a.price - b.price), page = off >= 10000 ? [] : all.slice(off, Math.min(off + lim, 10000));
  return { total: 99999, // eBay's total proved unreliable: the code must not depend on it
     itemSummaries: page.map((x) => ({ legacyItemId: x.id, title: "Item " + x.id, price: { value: String(x.price) }, buyingOptions: ["FIXED_PRICE"], itemCreationDate: "2026-01-01T00:00:00Z" })) };
};
const cfg = { cats: [{ id: "27386", name: "Graphics/Video Cards" }], region: "uk" };
const runPass = async () => { let guard = 0, seen = new Set();
  do { const s = []; await W.stockStep(env, cfg, s, {}); s.forEach((x) => seen.add(x.id)); guard++;
    const st = await W.kvGet(env, "stock", {}); if (!st.q.length) break; } while (guard < 500);
  return seen; };

await t("one pass finds every listing, carrying on from the last price past eBay's 10,000 limit, at most a few calls per scan", async () => {
  calls = 0; const s = []; await W.stockStep(env, cfg, s, {}); assert.ok(calls <= W.STOCK_CALLS);
  const seen = await runPass(); s.forEach((x) => seen.add(x.id));
  assert.equal(seen.size, 12000);
});
await t("listings: ended only after two passes miss them; one that reappears is back on sale", async () => {
  const old = Date.now() - 10 * W.DAY;
  const ins = (id, last) => db.prepare("INSERT OR REPLACE INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'live')").run(id, "27386", "gpu:x|used", "x", "used", "BIN", 10, 0, 0, null, old, last);
  ins("900001", Date.now() - 5 * W.DAY);   // gone long ago, never marked
  ins("900002", Date.now());               // seen by a scan after the last pass began, then missed once
  ins("100005", old);                       // still for sale (in the fake shop)
  const st = await W.kvGet(env, "stock", {}); st.cats["27386"].done = 0; await W.kvSet(env, "stock", st); // due again
  await new Promise((r) => setTimeout(r, 20)); // the pass starts after that sighting
  await runPass();
  const s = (id) => db.prepare("SELECT status FROM listings WHERE id=?").get(id).status;
  assert.equal(s("900001"), "gone"); assert.equal(s("900002"), "live"); assert.equal(s("100005"), "live");
  const st2 = await W.kvGet(env, "stock", {}); st2.cats["27386"].done = 0; await W.kvSet(env, "stock", st2);
  await runPass();
  assert.equal(s("900002"), "gone");          // missed by two passes in a row
  shop.push({ id: "900002", price: 50 });     // it turns up again
  const st3 = await W.kvGet(env, "stock", {}); st3.cats["27386"].done = 0; await W.kvSet(env, "stock", st3);
  await runPass();
  assert.equal(s("900002"), "live");
});
await t("a pass with eBay errors never marks anything ended", async () => {
  const keep = globalThis.FAKE_EBAY; let k = 0;
  globalThis.FAKE_EBAY = (p) => { if (++k === 3) throw new Error("eBay request failed (500)"); return keep(p); };
  db.prepare("UPDATE listings SET last_seen=? WHERE id='100006'").run(Date.now() - 9 * 86400e3);
  const st = await W.kvGet(env, "stock", {}); st.cats["27386"].done = 0; await W.kvSet(env, "stock", st);
  await runPass();
  globalThis.FAKE_EBAY = keep;
  assert.notEqual(db.prepare("SELECT status FROM listings WHERE id='100006'").get()?.status, "gone");
});
console.log(`\n${n} checks passed`);
