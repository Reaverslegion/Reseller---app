// End-to-end check on the isolated TEST Scan service "flipscout-phonetest" (no schedule, NO eBay keys: it cannot reach eBay)
// and the TEST database "flipscout-phonetest-db". A simulated eBay pause is placed in the test database; the settings are
// snapshotted first and restored exactly afterwards. Nothing here touches the live service, database or eBay.
//   node tests/d1/worker-e2e.mjs guard | snapshot | seed | resetManual | check | restore
import fs from "node:fs";
const ACC = process.env.CF_ACC, TOK = process.env.CF_TOKEN, API = `https://api.cloudflare.com/client/v4/accounts/${ACC}`;
const H = { Authorization: `Bearer ${TOK}`, "content-type": "application/json" };
export const NAMES = { worker: "flipscout-phonetest", db: "flipscout-phonetest-db", kv: "flipscout-phonetest-kv" }, LIVE = { worker: "flipscout-search", db: "flipscout-db", kv: "flipscout-backup" };
const out = (...a) => { try { fs.writeSync(1, a.join(" ") + "\n"); } catch (e) {} };
const cf = async (path, opt = {}) => { const r = await fetch(API + path, { headers: H, ...opt }); const j = await r.json(); if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors).slice(0, 200)}`); return j.result; };
const q = async (id, sql, params = []) => (await cf(`/d1/database/${id}/query`, { method: "POST", body: JSON.stringify({ sql, params }) }))[0];
const fail = (m) => { out("REFUSED: " + m); process.exit(1); };
const MSG_RE = /^eBay's daily limit is reached: eBay searches and checks paused until \d\d:\d\d \(UK time\), when eBay resets it$/;

async function ids() {
  for (const k of Object.keys(NAMES)) if (!/phonetest/.test(NAMES[k]) || NAMES[k] === LIVE[k]) fail("not a test name: " + NAMES[k]);
  const dbs = await cf("/d1/database?per_page=100"), kvs = await cf("/storage/kv/namespaces?per_page=100");
  const one = (list, name, key) => { const m = list.filter((x) => (x.name || x.title) === name); return m.length === 1 ? m[0][key] : null; };
  // the live backup store is found the way the live deploy job finds it: the store whose name ENDS with "flipscout-backup"
  const liveKvs = kvs.filter((x) => String(x.title || "").endsWith(LIVE.kv)).map((x) => x.id);
  const t = { db: one(dbs, NAMES.db, "uuid"), kv: one(kvs, NAMES.kv, "id") }, l = { db: one(dbs, LIVE.db, "uuid"), kv: liveKvs.length === 1 ? liveKvs[0] : null };
  if (!t.db || !t.kv || !l.db || !l.kv) fail(`not found exactly once (nothing is created): test database ${!!t.db}, test backup store ${!!t.kv}, live database ${!!l.db}, live backup store ${!!l.kv}; backup stores listed: ${kvs.length}, databases listed: ${dbs.length}`);
  if (t.db === l.db || t.kv === l.kv || liveKvs.includes(t.kv)) fail("test ids equal the live ones");
  const n = (await q(t.db, "SELECT COUNT(*) n FROM listings")).results[0].n;
  if (n > 20000) fail(`test database holds ${n} listings — looks like a real database`);
  return t;
}
const cmd = process.argv[2];
const t = await ids();
if (cmd === "guard") {
  out(`test database and backup store found and proved different from the live ones; test database holds ${(await q(t.db, "SELECT COUNT(*) n FROM listings")).results[0].n} listings`);
  fs.appendFileSync(process.env.GITHUB_ENV || "/dev/null", `TEST_DB_ID=${t.db}\nTEST_KV_ID=${t.kv}\n`);
} else if (cmd === "snapshot") {
  const rows = (await q(t.db, "SELECT k, v FROM kv")).results; fs.writeFileSync("kv-snapshot.json", JSON.stringify(rows)); out(`settings snapshot: ${rows.length} rows (${rows.map((r) => r.k).join(", ")})`);
} else if (cmd === "seed") {
  const now = Date.now(), set = (k, v) => q(t.db, "INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [k, JSON.stringify(v)]);
  await set("ebayGate", { browse: { until: now + 2 * 3600e3, why: "limit", src: "simulated for this test", tries: 0 } });
  await set("lastReport", { at: now - 3 * 3600e3, checked: 17, newDeals: 2, hidden: 0, why: { judged: 900, fair: 800, noData: 50, risky: 10 }, errors: [] });
  await set("lastManual", 0);
  const cfg = (await q(t.db, "SELECT v FROM kv WHERE k='config'")).results[0];
  if (!cfg || !(JSON.parse(cfg.v).cats || []).length) await set("config", { cats: [{ id: "27386", name: "Graphics Cards" }], types: { bin: true } });
  out("simulated eBay pause placed in the TEST database (2 hours), plus a 'last real scan' 3 hours ago");
} else if (cmd === "resetManual") {
  await q(t.db, "INSERT INTO kv(k,v) VALUES('lastManual','0') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
} else if (cmd === "check") {
  const url = process.env.TEST_SVC_URL, key = process.env.TEST_SVC_KEY, rows = [], add = (n, ok, d = "") => { rows.push({ n, ok }); out((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); };
  const get = async (p) => { const r = await fetch(`${url}/?${p}`, { headers: { "X-FlipScout-Key": key } }); let j = {}; try { j = await r.json(); } catch (e) {} return { s: r.status, j, txt: JSON.stringify(j) }; };
  const sched = await cf(`/workers/scripts/${NAMES.worker}/schedules`), secrets = (await cf(`/workers/scripts/${NAMES.worker}/secrets`)).map((x) => x.name).sort();
  add("test Scan service has no schedule (never scans by itself)", !(sched.schedules || []).length, JSON.stringify(sched.schedules || []));
  add("test Scan service has no eBay keys (it cannot reach eBay at all)", secrets.join(",") === "APP_KEY", `saved keys: ${secrets.join(", ")}`);
  const run = await get("run=1");
  add("Scan now while paused: an ordinary reply (not an error)", run.s === 200 && run.j.error === undefined, `HTTP ${run.s}`);
  add("Scan now while paused: the pause message", MSG_RE.test((run.j.errors || [])[0] || ""), (run.j.errors || [])[0]);
  const d = await get("deals=1"), rep = d.j.report || {};
  add("deals reply carries the pause message in the scan report", MSG_RE.test((rep.errors || [])[0] || ""), (rep.errors || [])[0]);
  add("'Scanned … ago' still shows the last real scan (3 hours ago)", Math.abs(Date.now() - 3 * 3600e3 - rep.at) < 15 * 60000 && rep.checked === 17, new Date(rep.at).toISOString());
  add("deals still load while paused", Array.isArray(d.j.deals), `${(d.j.deals || []).length} deals`);
  const s = await get("q=rtx%203070&max=300");
  add("phone price search while paused: ordinary reply with the message", s.s === 200 && MSG_RE.test(s.j.error || "") && s.j.paused === true, `HTTP ${s.s}`);
  add("no attempt to reach eBay (would show 'eBay login failed')", ![run.txt, d.txt, s.txt].some((x) => /login failed/i.test(x)));
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
} else if (cmd === "restore") {
  const snap = JSON.parse(fs.readFileSync("kv-snapshot.json", "utf8")), keep = new Set(snap.map((r) => r.k));
  const now = (await q(t.db, "SELECT k FROM kv")).results.map((r) => r.k);
  for (const k of now) if (!keep.has(k)) await q(t.db, "DELETE FROM kv WHERE k=?", [k]);
  for (const r of snap) await q(t.db, "INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [r.k, r.v]);
  const after = (await q(t.db, "SELECT k, v FROM kv ORDER BY k")).results, same = JSON.stringify(after) === JSON.stringify([...snap].sort((a, b) => (a.k < b.k ? -1 : 1)));
  out(`settings restored exactly: ${same ? "yes" : "NO"} (${after.length} rows)`); process.exit(same ? 0 : 1);
} else fail("unknown command");
