// Fill "already saved" check and how long listings take to sell, run against a real SQLite database
// shaped like the live one. Run: node tests/selltime.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { schema, seenAdd, markSold, sellStats, kvGet, kvSet, DAY, coverRuns, coverOf, rebuildCover };")();
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
await t("days read in full ignore stray old sales (one March sale made months look read)", async () => {
  const day = (k) => Math.floor(now / DAY) * DAY - k * DAY + 3600e3, ds = [];
  for (let k = 0; k <= 5; k++) for (let i = 0; i < 100; i++) ds.push(day(k));   // 6 busy days read today
  ds.push(day(20), day(21), day(45), day(200));                                  // strays from multi-unit listings
  const r = W.coverOf(ds.map((d) => ({ d })), now);
  assert.ok(r[0] >= day(5), "range must start within the busy days, not at a stray: " + new Date(r[0]).toISOString());
  // two separate fills with unread days between them are two ranges, not one
  const two = [...ds]; for (let k = 10; k <= 13; k++) for (let i = 0; i < 100; i++) two.push(day(k));
  assert.equal(W.coverRuns(two, now).length, 2);
});
await t("one-off rebuild: coverage from saved sale dates, then each model's sales rate; raw sales untouched", async () => {
  const day = (k) => Math.floor(now / DAY) * DAY - k * DAY + 3600e3, sales = [];
  for (let k = 0; k <= 6; k++) for (let i = 0; i < 30; i++) sales.push([String(5000 + k * 100 + i), 150 + i, 5, day(k)]);
  sales.push(["9999", 150, 5, day(150)]); // a stray
  await W.seenAdd(env, sales.map((x) => [x[0], "27386", x[1] + x[2], x[3]]));
  db.prepare("INSERT INTO fillsales (pkey,data,at) VALUES (?,?,?)").run("gpu:rtx 4060|used", JSON.stringify(sales.slice(0, 70).concat([sales[sales.length - 1]])), now);
  db.prepare("INSERT INTO prices (pkey,label,q,avg,st,post,trend,at) VALUES (?,?,?,?,?,?,?,?)").run("gpu:rtx 4060|used", "RTX 4060", "", 160, null, 5, "steady", now);
  for (const c of ["src TEXT", "n INTEGER", "lo REAL", "hi REAL", "spd REAL", "sdays REAL", "sn INTEGER", "act INTEGER", "act_at INTEGER"]) try { db.exec("ALTER TABLE prices ADD COLUMN " + c); } catch (e) {}
  db.prepare("UPDATE prices SET src='fill' WHERE pkey='gpu:rtx 4060|used'").run();
  await W.kvSet(env, "fillCats", { "27386": { name: "GPUs", k: { "gpu:rtx 4060|used": [71, 1] } } });
  await W.kvSet(env, "spdCheck", { n: 27, hit: 1 });
  const before = db.prepare("SELECT COUNT(*) c FROM fillseen").get().c;
  const r = await W.rebuildCover(env, now);
  const cov = (await W.kvGet(env, "fillCover", {}))["27386"];
  assert.ok(cov.length === 1 && cov[0][0] >= day(6), JSON.stringify(cov));
  const p = db.prepare("SELECT spd, sn, sdays FROM prices WHERE pkey='gpu:rtx 4060|used'").get();
  assert.ok(p.sn > 0 && p.sdays <= 7, JSON.stringify(p));
  assert.equal((await W.kvGet(env, "spdCheck", {})).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM fillseen").get().c, before);
  assert.equal(r.models, 1);
});
console.log(`\n${n} checks passed`);
