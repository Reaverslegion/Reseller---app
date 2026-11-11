// Scan time limits (9 Nov 2026), unit level (no network, throwaway in-memory database):
//  - every outside network call gives up after 20 seconds and says so
//  - inside a scan: no new network call starts after the 8-minute budget; after the 10-minute hard stop no database
//    query or network call runs at all, so a scan always ends well inside its 15-minute lock
//  - the limits can be made shorter for tests (kv "scanLimits"), never longer
// Run: node tests/scan-budget.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { xfetch, scanScope, scanLimits, SCAN_SOFT, SCAN_HARD, NET_TIMEOUT, SCAN_LEASE };")();
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null, _sql: sql, _args: args });
const env0 = { DB: { prepare: (q) => stmt(q), batch: async (l) => { const o = []; for (const s of l) { assert.ok(s._sql, "batch got the real statement"); o.push(await s.run()); } return o; } }, APP_KEY: "k" };
const realFetch = globalThis.fetch;

await t("the limits: 20 s per network call, 8-minute budget, 10-minute hard stop, 15-minute lock", () => {
  assert.equal(W.NET_TIMEOUT, 20000); assert.equal(W.SCAN_SOFT, 8 * 60000); assert.equal(W.SCAN_HARD, 10 * 60000); assert.equal(W.SCAN_LEASE, 15 * 60000);
});
await t("worst case fits inside the lock with room for clock differences: hard stop + one database query (30 s, Cloudflare's limit) + processing (30 s) ≤ lock − 3 min", () => {
  assert.ok(W.SCAN_HARD + Math.max(30000, W.NET_TIMEOUT) + 30000 <= W.SCAN_LEASE - 3 * 60000);
});
await t("limits can be made shorter for tests, never longer, and the budget never comes after the hard stop", () => {
  assert.deepEqual(W.scanLimits(null), { soft: W.SCAN_SOFT, hard: W.SCAN_HARD, net: W.NET_TIMEOUT });
  assert.deepEqual(W.scanLimits({ soft: 1000, hard: 2000, net: 500 }), { soft: 1000, hard: 2000, net: 500 });
  assert.deepEqual(W.scanLimits({ soft: 9e12, hard: 9e12, net: 9e12 }), { soft: W.SCAN_SOFT, hard: W.SCAN_HARD, net: W.NET_TIMEOUT });
  assert.deepEqual(W.scanLimits({ soft: 5000, hard: 1000 }), { soft: 1000, hard: 1000, net: W.NET_TIMEOUT });
  assert.deepEqual(W.scanLimits({ soft: -1, hard: "x", net: 0 }), { soft: W.SCAN_SOFT, hard: W.SCAN_HARD, net: W.NET_TIMEOUT });
});
await t("a network call that never answers gives up after the timeout with a clear message", async () => {
  globalThis.fetch = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(o.signal.reason)));
  const keepAlive = setTimeout(() => {}, 10000); // Node doesn't wait for a timeout signal on its own (Cloudflare does)
  try { const e = W.scanScope(env0, Date.now(), { soft: 60000, hard: 60000, net: 300 }), t0 = Date.now();
    await assert.rejects(W.xfetch(e, "https://api.ebay.com/x"), /no answer within/); assert.ok(Date.now() - t0 < 2000);
    // outside a scan: the default 20 s applies (checked without waiting: the signal is set)
    let seen; globalThis.fetch = (u, o) => { seen = o.signal; return Promise.resolve(new Response("{}")); };
    await W.xfetch(env0, "https://api.ebay.com/y", { headers: { a: "b" } }); assert.ok(seen && typeof seen.aborted === "boolean", "a timeout signal is always attached");
  } finally { globalThis.fetch = realFetch; clearTimeout(keepAlive); }
});
await t("after the 8-minute budget no new network call starts (and the scan is marked incomplete); the database still works", async () => {
  let calls = 0; globalThis.fetch = () => { calls++; return Promise.resolve(new Response("{}")); };
  try { const e = W.scanScope(env0, Date.now() - 1000, { soft: 500, hard: 60000, net: 1000 });
    await assert.rejects(W.xfetch(e, "https://api.ebay.com/x"), (x) => x.scanBudget && /time budget/.test(x.message)); assert.equal(calls, 0);
    assert.equal(e.__scan.budget, true);
    await e.DB.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").bind("a", "1").run(); assert.equal((await e.DB.prepare("SELECT v FROM kv WHERE k=?").bind("a").first()).v, "1");
  } finally { globalThis.fetch = realFetch; }
});
await t("after the hard stop nothing runs: database queries, batches and network calls all refuse at once", async () => {
  let calls = 0; globalThis.fetch = () => { calls++; return Promise.resolve(new Response("{}")); };
  try { const e = W.scanScope(env0, Date.now() - 2000, { soft: 500, hard: 1000, net: 1000 });
    for (const p of [() => e.DB.prepare("SELECT 1").all(), () => e.DB.prepare("SELECT 1").first(), () => e.DB.prepare("UPDATE kv SET v='9'").run(),
      () => e.DB.batch([e.DB.prepare("UPDATE kv SET v='9'")]), () => W.xfetch(e, "https://api.ebay.com/x")]) await assert.rejects(p(), (x) => x.scanStop);
    assert.equal(calls, 0); assert.equal(db.prepare("SELECT v FROM kv WHERE k='a'").get().v, "1", "nothing was written after the hard stop");
  } finally { globalThis.fetch = realFetch; }
});
await t("inside the time limits the scoped database behaves exactly like the real one (bind, run, all, first, batch)", async () => {
  const e = W.scanScope(env0, Date.now(), { soft: 60000, hard: 60000, net: 1000 });
  await e.DB.batch([e.DB.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").bind("b", "2"), e.DB.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").bind("c", "3")]);
  assert.deepEqual((await e.DB.prepare("SELECT k FROM kv WHERE k IN ('b','c') ORDER BY k").all()).results.map((r) => r.k), ["b", "c"]);
  assert.equal((await e.DB.prepare("UPDATE kv SET v='4' WHERE k=?").bind("b").run()).meta.changes, 1);
  assert.equal(e.APP_KEY, "k", "other bindings are passed through"); assert.equal(env0.__scan, undefined, "the real env is not changed");
});
console.log(`\n${n} checks passed`);
