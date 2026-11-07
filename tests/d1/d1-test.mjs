// D1 QUERY TEST for the asking-price lookup fix (status='live' → +status='live').
// Runs ONLY against the disposable test database "flipscout-phonetest-db". Every SQL statement passes a whitelist before it
// is sent, every inserted row's id starts with "d1t-" (and its model key with "d1test:"), and cleanup deletes only those rows.
//
//   node tests/d1/d1-test.mjs selftest                     safety rules checked against bad set-ups (no database needed)
//   node tests/d1/d1-test.mjs local [rows]                 the whole test on a local SQLite copy (no Cloudflare)
//   node tests/d1/d1-test.mjs remote <old.js> <new.js> [rows]   on Cloudflare (needs the workflow + approval)
//   node tests/d1/d1-test.mjs cleanup                      Cloudflare: remove "d1t-" rows only
import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const TEST_DB_NAME = "flipscout-phonetest-db";
export const LIVE_NAMES = ["flipscout-db", "flipscout-search", "flipscout-backup"];
export const ID_PREFIX = "d1t-", KEY_PREFIX = "d1test:";
export const MAX_OTHER_ROWS = 20000; // the live database holds hundreds of thousands of listings; a bigger table is refused
const DAY = 864e5;
const out = (...a) => { try { fs.writeSync(1, a.join(" ") + "\n"); } catch (e) {} };

// ---------- safety rule 1: pick the test database from Cloudflare's list, refuse anything doubtful ----------
export function guardList(list, name = TEST_DB_NAME) {
  const nm = (x) => x.name || x.title || "";
  if (!/phonetest/.test(name) || LIVE_NAMES.includes(name)) return { ok: false, why: `"${name}" is not a test database name` };
  const t = list.filter((x) => nm(x) === name), l = list.filter((x) => nm(x) === "flipscout-db");
  if (t.length !== 1) return { ok: false, why: t.length ? "more than one database has the test name" : "test database not found (it will NOT be created)" };
  if (l.length !== 1) return { ok: false, why: "live database not found in the list, so it can't be proved different" };
  const tid = t[0].uuid || t[0].id, lid = l[0].uuid || l[0].id;
  if (!tid || !lid || tid === lid) return { ok: false, why: "test database id missing or equal to the live one" };
  return { ok: true, id: tid, liveId: lid };
}

// ---------- safety rule 2: only these statements may ever be sent ----------
export function lintSql(sql) {
  const s = sql.trim().replace(/;\s*$/, "");
  if (/;/.test(s.replace(/'[^']*'/g, ""))) return "more than one statement";
  if (/^(EXPLAIN QUERY PLAN )?SELECT /i.test(s)) return /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA|VACUUM)\b/i.test(s.replace(/'[^']*'/g, "")) ? "read query contains a write word" : "";
  if (/^INSERT INTO listings \(id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status\) VALUES /.test(s)) {
    const rows = s.slice(s.indexOf("VALUES ") + 7).split(/\),\s*\(/);
    return rows.every((r) => r.replace(/^\(/, "").startsWith(`'${ID_PREFIX}`)) && !/ON CONFLICT|REPLACE|SELECT/i.test(s) ? "" : "insert row without the d1t- id";
  }
  if (s === `DELETE FROM listings WHERE id LIKE '${ID_PREFIX}%'`) return "";
  return "statement not on the allowed list";
}

// ---------- safety rule 3: the table must look like the small test database, not the live one ----------
export function guardContent(c) {
  if (!c.hasListings) return "listings table missing (the test will NOT create it)";
  if (c.other > MAX_OTHER_ROWS) return `listings holds ${c.other} non-test rows — this looks like a real database`;
  for (const [ix, want] of Object.entries(INDEXES)) if (norm(c.indexes[ix]) !== norm(want)) return `index ${ix} differs from the code (${c.indexes[ix] || "missing"})`;
  return "";
}
const INDEXES = { li_key2: "CREATE INDEX li_key2 ON listings(pkey, first_seen)", li_status: "CREATE INDEX li_status ON listings(status, end_at)", li_cat: "CREATE INDEX li_cat ON listings(cat, first_seen)" };
const norm = (s) => String(s || "").replace(/IF NOT EXISTS /i, "").replace(/\s+/g, " ").trim();

// ---------- the query, taken from the code itself ----------
export function querySql(workerJs) {
  const m = workerJs.match(/D\.prepare\(`(SELECT pkey, id, price\+ship AS t FROM listings WHERE pkey IN \(\$\{q\}\)[^`]*)`\)/);
  if (!m) throw new Error("asking-price query not found in worker.js");
  return m[1];
}
const lit = (v) => (typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
export function fill(sqlTpl, keys, now) { // values written in, as wrangler's --command can't take bound values
  return sqlTpl.replace("${q}", keys.map(lit).join(",")).replace("first_seen>?", `first_seen>${now - 7 * DAY}`).replace("last_seen>?", `last_seen>${now - 2 * DAY}`);
}

// ---------- realistic test data (fixed random seed, so every run is the same) ----------
export function makeData(n, now) {
  let x = 7; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (ws) => { let r = rnd() * ws.reduce((a, [, w]) => a + w, 0); for (const [v, w] of ws) if ((r -= w) < 0) return v; return ws[0][0]; };
  const rows = [];
  for (let i = 0; i < n; i++) {
    const fs_ = Math.round(now - rnd() * 40 * DAY), ls = Math.round(Math.min(now, fs_ + rnd() * 10 * DAY));
    const model = Math.floor(1 / Math.pow(1 - rnd() * 0.9999, 1 / 1.2)) % 2000; // a few very popular models, many rare ones
    rows.push([`${ID_PREFIX}${i}`, pick([["27386", 3], ["9355", 3], ["139971", 2], ["177", 1], ["164", 1]]), rnd() < 0.1 ? null : `${KEY_PREFIX}m${model}|used`, "test listing", "used",
      rnd() < 0.85 ? "BIN" : "AUC", Math.round((20 + rnd() * 880) * 100) / 100, 4.99, 0, fs_ + 7 * DAY, fs_, ls, pick([["live", 65], ["gone", 25], ["sold", 5], ["ended", 5]])]);
  }
  // awkward statuses that must match in neither version
  for (const [i, st] of [["e1", "Live"], ["e2", null], ["e3", "live "]]) rows.push([`${ID_PREFIX}${i}`, "1", `${KEY_PREFIX}m1|used`, "edge", "used", "BIN", 50, 0, 0, now, now - DAY, now, st]);
  return rows;
}
export function insertStatements(rows, per = 150) {
  const st = [];
  for (let i = 0; i < rows.length; i += per)
    st.push("INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status) VALUES " + rows.slice(i, i + per).map((r) => "(" + r.map((v) => (v === null ? "NULL" : lit(v))).join(",") + ")").join(","));
  return st;
}
export function testKeys() { const k = []; for (let m = 1; k.length < 45; m += 7) k.push(`${KEY_PREFIX}m${m}|used`); return k; }

// ---------- two ways to run SQL: local SQLite, or Cloudflare through wrangler ----------
export function localExec(db) {
  return (sql) => { const why = lintSql(sql); if (why) throw new Error("BLOCKED: " + why + " — " + sql.slice(0, 80));
    const s = db.prepare(sql); return /^(EXPLAIN|SELECT)/i.test(sql.trim()) ? { rows: s.all(), meta: {} } : (s.run(), { rows: [], meta: {} }); };
}
export function remoteExec(cfg, wrangler = "wrangler") {
  return (sql) => { const why = lintSql(sql); if (why) throw new Error("BLOCKED: " + why + " — " + sql.slice(0, 80));
    const r = spawnSync(wrangler, ["d1", "execute", TEST_DB_NAME, "--remote", "--json", "--config", cfg, "--command", sql], { encoding: "utf8", maxBuffer: 64e6 });
    const s = r.stdout || "", i = s.search(/^\[/m); if (r.status !== 0 || i < 0) throw new Error("wrangler failed: " + (r.stderr || s).slice(0, 300));
    const j = JSON.parse(s.slice(i)); const last = j[j.length - 1] || {}; return { rows: last.results || [], meta: last.meta || {} }; };
}
const contentOf = (ex) => {
  const t = ex("SELECT name, sql FROM sqlite_master WHERE tbl_name='listings' OR name='sqlite_stat1'").rows;
  const has = t.some((r) => r.name === "listings"); const ix = Object.fromEntries(t.filter((r) => r.name.startsWith("li_")).map((r) => [r.name, r.sql]));
  const other = has ? ex(`SELECT COUNT(*) n FROM listings WHERE id NOT LIKE '${ID_PREFIX}%'`).rows[0].n : 0;
  return { hasListings: has, other, indexes: ix, stats: t.some((r) => r.name === "sqlite_stat1") };
};

// ---------- the test itself (same code for local and Cloudflare) ----------
export function runTest(ex, oldTpl, newTpl, n, now = 1793900000000) {
  const R = { checks: [] }, add = (name, ok, detail = "") => { R.checks.push({ name, status: ok ? "PASS" : "FAIL", detail }); out((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : "")); };
  if (oldTpl.replace("+status='live'", "status='live'") !== oldTpl || newTpl.replace("+status='live'", "status='live'") !== oldTpl) add("old and new queries differ only by the '+'", false, "unexpected difference"); else add("old and new queries differ only by the '+'", true);
  const c = contentOf(ex), bad = guardContent(c);
  add("test database checked before writing (small, same indexes as the code)", !bad, bad || `${c.other} non-test listings; database statistics ${c.stats ? "PRESENT" : "absent (like production appears to be)"}`);
  if (bad) return R;
  R.stats = c.stats;
  const left = ex(`SELECT COUNT(*) n FROM listings WHERE id LIKE '${ID_PREFIX}%'`).rows[0].n;
  if (left) { ex(`DELETE FROM listings WHERE id LIKE '${ID_PREFIX}%'`); out(`removed ${left} rows left by an earlier run`); }
  try {
    const rows = makeData(n, now), st = insertStatements(rows); for (const s of st) ex(s);
    const got = ex(`SELECT COUNT(*) n FROM listings WHERE id LIKE '${ID_PREFIX}%'`).rows[0].n;
    add(`${rows.length} test rows inserted`, got === rows.length, `${got} rows, ${rows.filter((r) => r[12] === "live").length} live`);
    const keys = testKeys(), plans = {};
    for (const [nm, tpl] of [["old", oldTpl], ["new", newTpl]]) {
      for (let k = 1; k <= 45; k++) { const p = ex("EXPLAIN QUERY PLAN " + fill(tpl, keys.slice(0, k), now)).rows.map((r) => r.detail).join(" | "); (plans[nm] ||= {})[p] = (plans[nm][p] || []).concat(k); }
    }
    R.plans = plans; for (const [nm, v] of Object.entries(plans)) for (const [p, ks] of Object.entries(v)) out(`plan ${nm}: ${p}  (batch sizes ${ks[0]}..${ks[ks.length - 1]})`);
    add("new query uses the per-model index (li_key2) for every batch size 1–45", Object.keys(plans.new).length === 1 && /li_key2/.test(Object.keys(plans.new)[0]), Object.keys(plans.new).join("; "));
    add("old query reproduces the slow choice (li_status) for batches of 3+ models", Object.entries(plans.old).some(([p, ks]) => /li_status/.test(p) && ks.includes(45)), Object.keys(plans.old).join("; "));
    const run = (tpl) => { const r = []; for (let i = 0; i < 3; i++) r.push(ex(fill(tpl, keys, now))); return r; };
    const a = run(oldTpl), b = run(newTpl), sig = (r) => JSON.stringify(r.rows.map((x) => [x.pkey, x.id, x.t]).sort());
    add("both queries return identical results (3 runs each)", a.every((r) => sig(r) === sig(a[0])) && b.every((r) => sig(r) === sig(a[0])) && a[0].rows.length > 0, `${a[0].rows.length} rows each`);
    const rr = (x) => x.map((r) => r.meta.rows_read).filter((v) => v != null), ms = (x) => x.map((r) => r.meta.duration).filter((v) => v != null);
    R.rowsRead = { old: rr(a), new: rr(b) }; R.durationMs = { old: ms(a), new: ms(b) };
    if (rr(a).length) add("new query reads fewer rows", Math.max(...rr(b)) < Math.min(...rr(a)), `rows read old ${rr(a).join("/")} vs new ${rr(b).join("/")}; ms old ${ms(a).map(Math.round).join("/")} vs new ${ms(b).map(Math.round).join("/")}`);
  } finally {
    ex(`DELETE FROM listings WHERE id LIKE '${ID_PREFIX}%'`);
    const left2 = ex(`SELECT COUNT(*) n FROM listings WHERE id LIKE '${ID_PREFIX}%'`).rows[0].n, other2 = ex(`SELECT COUNT(*) n FROM listings WHERE id NOT LIKE '${ID_PREFIX}%'`).rows[0].n;
    add("cleanup: all test rows removed, other rows untouched", left2 === 0 && other2 === c.other, `${left2} test rows left; other rows ${c.other} → ${other2}`);
  }
  return R;
}

// ---------- local copy of the database for validation (no Cloudflare) ----------
export async function localDb(workerJs) {
  const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(":memory:");
  const pick = (re) => [...new Set(workerJs.match(re) || [])];
  for (const s of pick(/CREATE TABLE IF NOT EXISTS listings \([^)]*\)/g).concat(pick(/CREATE INDEX IF NOT EXISTS li_(key2|status|cat) ON listings\([^)]*\)/g), pick(/ALTER TABLE listings ADD COLUMN [a-z_]+ [A-Z]+/g))) db.exec(s);
  db.exec("CREATE TABLE deals (id TEXT PRIMARY KEY, data TEXT)"); // stands in for the phone-test fake deals, which must stay untouched
  db.exec("INSERT INTO listings (id,pkey,type,status,first_seen,last_seen) VALUES ('111','gpu:other|used','BIN','live',1,1),('112','gpu:other|used','BIN','gone',1,1)");
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  const wj = (f) => fs.readFileSync(f, "utf8");
  if (cmd === "selftest") {
    const L = (t, l) => [{ name: TEST_DB_NAME, uuid: t }, { name: "flipscout-db", uuid: l }];
    const cases = [["normal set-up is accepted", guardList(L("aaa", "bbb")).ok === true],
      ["same id as live is refused", !guardList(L("aaa", "aaa")).ok], ["missing test database is refused (not created)", !guardList([{ name: "flipscout-db", uuid: "b" }]).ok],
      ["missing live database is refused", !guardList([{ name: TEST_DB_NAME, uuid: "a" }]).ok], ["live name configured as the test name is refused", !guardList(L("a", "b"), "flipscout-db").ok],
      ["name without 'phonetest' is refused", !guardList([{ name: "other-db", uuid: "a" }, { name: "flipscout-db", uuid: "b" }], "other-db").ok],
      ["two databases with the test name is refused", !guardList([...L("a", "b"), { name: TEST_DB_NAME, uuid: "c" }]).ok],
      ["a big (live-sized) table is refused", !!guardContent({ hasListings: true, other: 400000, indexes: INDEXES })],
      ["missing listings table is refused (not created)", !!guardContent({ hasListings: false })], ["different index definition is refused", !!guardContent({ hasListings: true, other: 0, indexes: { ...INDEXES, li_key2: "CREATE INDEX li_key2 ON listings(pkey)" } })],
      ["DROP is blocked", !!lintSql("DROP TABLE listings")], ["UPDATE is blocked", !!lintSql("UPDATE listings SET status='x'")],
      ["DELETE of anything but test rows is blocked", !!lintSql("DELETE FROM listings WHERE id LIKE '%'")], ["DELETE without condition is blocked", !!lintSql("DELETE FROM listings")],
      ["insert of a non-test id is blocked", !!lintSql("INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status) VALUES ('d1t-1','1',NULL,'t','u','BIN',1,1,0,1,1,1,'live'),('123','1',NULL,'t','u','BIN',1,1,0,1,1,1,'live')")],
      ["two statements in one are blocked", !!lintSql("SELECT 1; DROP TABLE listings")], ["PRAGMA/ANALYZE-type changes are blocked", !!lintSql("PRAGMA optimize") && !!lintSql("ANALYZE")],
      ["the test's own statements are allowed", !lintSql(insertStatements(makeData(5, 1e12))[0]) && !lintSql(`DELETE FROM listings WHERE id LIKE '${ID_PREFIX}%'`) && !lintSql("EXPLAIN QUERY PLAN SELECT 1")]];
    for (const [n, ok] of cases) out((ok ? "PASS " : "FAIL ") + n);
    process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
  }
  if (cmd === "local") {
    const nw = wj("worker.js"), oldTpl = querySql(nw).replace("+status='live'", "status='live'");
    const db = await localDb(nw); const R = runTest(localExec(db), oldTpl, querySql(nw), +(a1 || 15000));
    const deals = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='deals'").get().n; out((deals ? "PASS" : "FAIL") + " other tables untouched (stand-in for phone-test deals)");
    process.exit(R.checks.every((c) => c.status === "PASS") && deals ? 0 : 1);
  }
  if (cmd === "remote" || cmd === "cleanup") {
    const wr = process.env.WRANGLER || "wrangler";
    const l = spawnSync(wr, ["d1", "list", "--json"], { encoding: "utf8" }); const s = l.stdout || "", i = s.search(/^\[/m);
    const g = guardList(i < 0 ? [] : JSON.parse(s.slice(i))); if (!g.ok) { out("REFUSED: " + g.why); process.exit(1); }
    const cfg = "d1-test.wrangler.toml";
    fs.writeFileSync("none.js", "// placeholder: this config is only used to reach the test database, never deployed\n");
    fs.writeFileSync(cfg, `name = "d1-query-test-not-deployed"\nmain = "none.js"\ncompatibility_date = "2024-09-23"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${TEST_DB_NAME}"\ndatabase_id = "${g.id}"\n`);
    out(`test database ${TEST_DB_NAME} found and proved different from the live database (ids checked)`);
    if (LIVE_NAMES.some((n) => fs.readFileSync(cfg, "utf8").includes(`"${n}"`)) || fs.readFileSync(cfg, "utf8").includes(g.liveId)) { out("REFUSED: live name or id in the test config"); process.exit(1); }
    const ex = remoteExec(cfg, wr);
    if (cmd === "cleanup") { const c = contentOf(ex), bad = guardContent(c); if (bad) { out("REFUSED: " + bad); process.exit(1); }
      ex(`DELETE FROM listings WHERE id LIKE '${ID_PREFIX}%'`); const n = ex(`SELECT COUNT(*) n FROM listings WHERE id LIKE '${ID_PREFIX}%'`).rows[0].n; out(`cleanup: ${n} test rows left`); process.exit(n ? 1 : 0); }
    const R = runTest(ex, querySql(wj(a1)), querySql(wj(a2)), +(a3 || 15000), Date.now());
    fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/d1-query-test.json", JSON.stringify(R, null, 1));
    process.exit(R.checks.every((c) => c.status === "PASS") ? 0 : 1);
  }
  out("usage: selftest | local [rows] | remote <old worker.js> <new worker.js> [rows] | cleanup"); process.exit(2);
}
