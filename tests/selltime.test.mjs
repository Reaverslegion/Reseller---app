// Fill "already saved" check and how long listings take to sell, run against a real SQLite database
// shaped like the live one. Run: node tests/selltime.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { schema, seenAdd, markSold, sellStats, kvGet, kvSet, DAY };")();
// a tiny stand-in for Cloudflare D1 (prepare/bind/run/all/first/batch)
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => { db.prepare(sql).run(...args); return {}; },
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const DAY = W.DAY, now = Date.now();
await W.schema(env);
const add = (id, first, status = "live", type = "BIN", extra = {}) => db.prepare("INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status,ended_at,ended_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, "27386", "gpu:rtx 3060|used", "RTX 3060", "used", type, 150, 5, 0, null, first, extra.last_seen ?? first, status, extra.ended_at ?? null, extra.ended_from ?? null);

await t("sales read by a fill are remembered, and reading them again adds nothing", async () => {
  await W.seenAdd(env, [["111", "27386", 160, now - 2 * DAY], ["222", "27386", 170, now - DAY]]);
  await W.seenAdd(env, [["111", "27386", 160, now - 2 * DAY]]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM fillseen").get().c, 2);
});
await t("Buy It Now listings seen for sale are marked sold with the sold date and price; auctions are left alone", async () => {
  add("111", now - 9 * DAY); add("222", now - 3 * DAY); add("333", now - 5 * DAY, "live", "AUC"); add("444", now - 5 * DAY);
  const got = await W.markSold(env, [["111", "27386", 160, now - 2 * DAY], ["222", "27386", 170, now - DAY], ["333", "27386", 99, now], ["999", "27386", 1, now]]);
  assert.equal(got, 2);
  const r = db.prepare("SELECT status, sold_at, sold_price FROM listings WHERE id='111'").get();
  assert.deepEqual([r.status, r.sold_at, r.sold_price], ["sold", now - 2 * DAY, 160]);
  assert.equal(db.prepare("SELECT status FROM listings WHERE id='333'").get().status, "live");
  assert.equal(await W.markSold(env, [["111", "27386", 160, now - 2 * DAY]]), 0); // already counted
});
await t("days to sell per model; ended-unsold only counted when that day's sold list was read", async () => {
  add("555", now - 20 * DAY, "gone", "BIN", { ended_from: now - 12 * DAY, ended_at: now - 10 * DAY }); // that time was read: probably withdrawn
  add("666", now - 40 * DAY, "gone", "BIN", { ended_from: now - 36 * DAY, ended_at: now - 35 * DAY }); // not read: unknown, not counted
  add("777", now - 20 * DAY, "gone", "BIN", { ended_from: now - 18 * DAY, ended_at: now - 10 * DAY }); // only partly read: not counted
  await W.kvSet(env, "fillCover", { "27386": [[now - 15 * DAY, now]] });
  const m = await W.sellStats(env), x = m["gpu:rtx 3060|used"];
  assert.equal(x.n, 2); assert.equal(x.wd, 1);
  assert.ok(x.lo >= 2 && x.hi <= 7, JSON.stringify(x)); // sold after 2 and 7 days
});
await t("a sold listing seen again by a scan stays sold", async () => {
  assert.match(src, /status=CASE WHEN listings\.status IN \('gone','sold'\) THEN listings\.status ELSE 'live' END/);
});
console.log(`\n${n} checks passed`);
