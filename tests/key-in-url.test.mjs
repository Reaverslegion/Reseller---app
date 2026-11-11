// The key in the web address (old app versions before 25 Oct 2026): still accepted by default and noted in the Problems
// list (no alert); refused when KEY_IN_URL is "off"; the header always works. Run: node tests/key-in-url.test.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const worker = (await import(new URL("../worker.js", import.meta.url))).default;
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const DB = { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } };
const KEY = "test-key-for-url-check-0123456789";
const call = async (env, url, headers = {}) => { const w = []; const r = await worker.fetch(new Request("https://svc.test/" + url, { headers }), env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); return r.status; };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const on = { APP_KEY: KEY, DB }, off = { APP_KEY: KEY, DB, KEY_IN_URL: "off" };

await t("the hidden header works whether or not the old way is switched off", async () => {
  assert.equal(await call(on, "?config=1", { "X-FlipScout-Key": KEY }), 200);
  assert.equal(await call(off, "?config=1", { "X-FlipScout-Key": KEY }), 200);
});
await t("by default a key in the web address still works (old app versions aren't locked out)", async () => {
  assert.equal(await call(on, `?key=${KEY}&config=1`), 200);
});
await t("each use of the old way is noted in the Problems list, without the key, and never sends an alert", async () => {
  for (let i = 0; i < 4; i++) await call(on, `?key=${KEY}&deals=1`);
  const r = db.prepare("SELECT * FROM errlog WHERE kind LIKE 'notice:%' ORDER BY place").all();
  assert.deepEqual(r.map((x) => [x.place, x.n]), [["config", 1], ["deals", 4]], "one line per kind of request, with a count");
  assert.ok(r.every((x) => x.alerted === 0), "no alert");
  assert.ok(!JSON.stringify(r).includes(KEY), "key not recorded");
});
await t("switched off: a key in the web address is refused, even the right one", async () => {
  assert.equal(await call(off, `?key=${KEY}&config=1`), 401);
});
await t("wrong keys are refused either way", async () => {
  assert.equal(await call(on, "?key=nope&config=1"), 401);
  assert.equal(await call(on, "?config=1", { "X-FlipScout-Key": "nope" }), 401);
});
console.log(`\n${n} checks passed`);
