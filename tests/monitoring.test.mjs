// Stage 4: the problem log (crash and error monitoring) in the Scan service and the app.
// Uses an in-memory database and harmless made-up errors only. Run: node tests/monitoring.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
src = src.replace("async function push(env, title, body, data) {", "async function push(env, title, body, data) { globalThis.PUSHED.push({ title, body }); return { sent: 1 };\n}\nasync function pushReal(env, title, body, data) {");
const W = new Function(src + "\nreturn { cleanMsg, logProblem, ERR_KEEP, bodyJson };")();
const app = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
globalThis.PUSHED = [];
const mkdb = () => { const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
  return { db, env: { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } } } }; };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("private details are removed before anything is recorded", async () => {
  const m = W.cleanMsg("fetch https://svc.example.workers.dev/?deals=1&key=abcdef1234567890abcdef12 failed for me@example.com, Bearer eyJhbGciOiJIUzI1NiJ9.x.y token=zzz9 password: hunter2 {'secret':'s3cr'} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  for (const bad of ["abcdef1234567890abcdef12", "me@example.com", "eyJhbGciOiJIUzI1NiJ9", "zzz9", "hunter2", "s3cr", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "deals=1"]) assert.ok(!m.includes(bad), `"${bad}" removed: ${m}`);
  assert.match(m, /\[email\]/); assert.match(m, /Bearer \[hidden\]/); assert.match(m, /svc\.example\.workers\.dev\//);
  assert.ok(W.cleanMsg("x".repeat(2000)).length <= 300, "kept short");
  assert.equal(W.cleanMsg("Cannot read properties of undefined (reading 'price')"), "Cannot read properties of undefined (reading 'price')", "ordinary errors stay readable");
  assert.equal(W.cleanMsg(null), ""); assert.equal(W.cleanMsg({ toString: () => "obj" }), "obj");
});
await t("the app removes the same private details, with the same rules", async () => {
  const appClean = new Function(app.match(/const cleanMsg=s=>[\s\S]*?\.slice\(0,300\);/)[0] + "\nreturn cleanMsg;")();
  const samples = ["GET https://a.b/?key=abcdef1234567890abcdef12&x=1 failed", "token=abc password: p4ss {'secret':'s'} me@x.co.uk", "Bearer abc.def.ghi", "TypeError: d.price is undefined", "x".repeat(900), "a\n\n b"];
  for (const x of samples) assert.equal(appClean(x), W.cleanMsg(x), x.slice(0, 40));
});
await t("the same problem repeating is one record with a count, not hundreds of records", async () => {
  const { env, db } = mkdb();
  for (let i = 0; i < 7; i++) await W.logProblem(env, "service", "exception", `deal 12345${i} broke at line ${i}`, { where: "deals" });
  const rows = db.prepare("SELECT * FROM errlog").all(); assert.equal(rows.length, 1); assert.equal(rows[0].n, 7); assert.equal(rows[0].place, "deals");
});
await t("serious repeated failures send one alert (3 for the service, 5 for the app), then stay quiet for 6 hours", async () => {
  const { env } = mkdb(); PUSHED.length = 0;
  for (let i = 0; i < 2; i++) await W.logProblem(env, "database", "exception", "D1_ERROR: disk I/O error");
  assert.equal(PUSHED.length, 0, "no alert for 1 or 2");
  await W.logProblem(env, "database", "exception", "D1_ERROR: disk I/O error"); assert.equal(PUSHED.length, 1, "alert on the 3rd");
  for (let i = 0; i < 10; i++) await W.logProblem(env, "database", "exception", "D1_ERROR: disk I/O error"); assert.equal(PUSHED.length, 1, "no repeat alerts");
  assert.match(PUSHED[0].title, /FlipScout problem/); assert.match(PUSHED[0].body, /3 times/);
  for (let i = 0; i < 4; i++) await W.logProblem(env, "app", "crash", "x is not a function"); assert.equal(PUSHED.length, 1, "app: not yet at 4");
  await W.logProblem(env, "app", "crash", "x is not a function"); assert.equal(PUSHED.length, 2, "app: alert on the 5th");
});
await t(`the log keeps the newest ${W.ERR_KEEP} different problems (it can't grow forever)`, async () => {
  const { env, db } = mkdb();
  for (let i = 0; i < W.ERR_KEEP + 40; i++) await W.logProblem(env, "service", "exception", `different problem ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM errlog").get().n, W.ERR_KEEP);
});
await t("recording a problem never causes another one (a broken database is ignored quietly)", async () => {
  await W.logProblem({ DB: { prepare: () => { throw new Error("database gone"); } } }, "service", "exception", "x");
  await W.logProblem({}, "service", "exception", "x");
});
await t("garbled request data is marked as a bad request (400), not a server fault", async () => {
  await assert.rejects(W.bodyJson({ text: async () => "{nope" }), (e) => e.bad === true);
  assert.deepEqual(await W.bodyJson({ text: async () => '{"a":1}' }), { a: 1 });
  assert.equal((src.match(/JSON\.parse\(await request\.text\(\)\)/g) || []).length, 0, "every request body goes through bodyJson");
});
await t("the app reports crashes, repeated deal and sales load failures, and unclean exits, and queues them while offline", async () => {
  for (const re of [/addEventListener\("error"/, /addEventListener\("unhandledrejection"/, /report\("deals-load-failed"/, /report\("sales-load-failed"/, /report\("unclean-exit"/,
    /localStorage\.setItem\(PRB/, /if\(prbN\+\+>=20\)return/, /ver:VER/]) assert.match(app, re);
  assert.doesNotMatch(app.match(/function report\(kind[\s\S]*?\n/)[0], /S\.set\.key|title|price/, "no key or listing details in a report");
});
console.log(`\n${n} checks passed`);
