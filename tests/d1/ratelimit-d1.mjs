// eBay rate-limit protection on Cloudflare D1 (the TEST database "flipscout-phonetest-db" only).
// Runs the REAL worker.js counting / pause / scan code with every database query sent to the test database, and every eBay reply
// SIMULATED (nothing is sent to eBay). All settings rows it uses get a unique prefix ("d1t-<tag>-") and are removed afterwards.
//   node tests/d1/ratelimit-d1.mjs local <tag>     same test on a local SQLite copy (no Cloudflare)
//   node tests/d1/ratelimit-d1.mjs remote <tag>    on the Cloudflare test database (needs CF_TOKEN, CF_ACC)
//   node tests/d1/ratelimit-d1.mjs cleanup <tag>   remove that run's rows only
import fs from "node:fs";
import assert from "node:assert/strict";

export const TEST_DB_NAME = "flipscout-phonetest-db", LIVE_DB_NAME = "flipscout-db", MAX_LISTINGS = 20000;
const out = (...a) => { try { fs.writeSync(1, a.join(" ") + "\n"); } catch (e) {} };
const realFetch = globalThis.fetch;

// ---------- safety: pick the test database, refuse anything doubtful ----------
export function guardList(list) {
  const t = list.filter((x) => x.name === TEST_DB_NAME), l = list.filter((x) => x.name === LIVE_DB_NAME);
  if (t.length !== 1) return { ok: false, why: "test database not found exactly once (it will NOT be created)" };
  if (l.length !== 1) return { ok: false, why: "live database not found, so it can't be proved different" };
  if (!t[0].uuid || t[0].uuid === l[0].uuid) return { ok: false, why: "test database id missing or equal to the live one" };
  return { ok: true, id: t[0].uuid };
}
// ---------- safety: only settings-table (kv) work, on this run's own rows; table set-up is skipped ----------
export function makeGuardedExec(rawExec, prefix, stats) {
  if (!/^d1t-[a-z0-9]{6,24}-$/.test(prefix)) throw new Error("bad run prefix");
  return async (sql, params = []) => {
    const s = sql.trim();
    if (/^(CREATE (TABLE|INDEX) IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN|DROP INDEX IF EXISTS)\b/i.test(s)) return { results: [], meta: { skipped: true } }; // set-up: skipped, the test database already has its tables
    if (!/^(SELECT|EXPLAIN QUERY PLAN SELECT|INSERT INTO kv|UPDATE kv|DELETE FROM kv)\b/i.test(s)) throw new Error("BLOCKED (statement type): " + s.slice(0, 60));
    if (/\b(listings|deals|follows|fillseen|sales|prices|flags|deal_out)\b/i.test(s.replace(/'[^']*'/g, "")) && !/^EXPLAIN|^SELECT COUNT\(\*\) n FROM listings$/i.test(s)) throw new Error("BLOCKED (not the settings table): " + s.slice(0, 60));
    if (!/\bkv\b/.test(s) && !/^EXPLAIN|^SELECT COUNT\(\*\) n FROM listings$/i.test(s)) throw new Error("BLOCKED: " + s.slice(0, 60));
    let q = s.replace(/'quota'/g, `'${prefix}quota'`), p = [...params];
    if (/\bkv\b/.test(q) && /\bk\s*=\s*\?|VALUES\s*\(\?,\s*\?\)/i.test(q) && typeof p[0] === "string") p[0] = prefix + p[0]; // this run's own rows
    if (/^DELETE\b/i.test(q) && !q.includes(`'${prefix}`) && !(typeof p[0] === "string" && p[0].startsWith(prefix))) throw new Error("BLOCKED delete outside this run");
    if (/^(INSERT|UPDATE|DELETE)\b/i.test(q) && !(q.includes(`'${prefix}`) || (typeof p[0] === "string" && p[0].startsWith(prefix)))) throw new Error("BLOCKED write outside this run: " + q.slice(0, 60));
    const r = await rawExec(q, p);
    if (stats) { const key = q.replace(/'d1t-[^']*'/g, "'…'").replace(/\s+/g, " ").slice(0, 70); const e = (stats[key] ||= { n: 0, read: 0, written: 0, ms: 0 });
      e.n++; e.read += r.meta.rows_read || 0; e.written += r.meta.rows_written || 0; e.ms += r.meta.duration || 0; }
    return r;
  };
}
// D1 binding stand-in on top of an exec function (what the worker code calls)
export const d1From = (exec) => {
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => { const r = await exec(sql, args); return { meta: { changes: r.meta.changes || 0, ...r.meta } }; },
    all: async () => ({ results: (await exec(sql, args)).results }), first: async () => (await exec(sql, args)).results[0] || null });
  return { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } };
};
export const remoteExec = (acc, token, id) => async (sql, params) => {
  const r = await realFetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/d1/database/${id}/query`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sql, params }) });
  const j = await r.json(); if (!j.success) throw new Error("D1: " + JSON.stringify(j.errors).slice(0, 200));
  const x = j.result[0]; return { results: x.results || [], meta: x.meta || {} };
};
export async function localExec() {
  const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT); CREATE TABLE listings (id TEXT PRIMARY KEY); INSERT INTO kv VALUES ('config','{\"phone\":\"test data\"}')");
  return { db, exec: async (sql, params) => { await new Promise((r) => setTimeout(r, 2)); const st = db.prepare(sql);
    return /^(SELECT|EXPLAIN)/i.test(sql.trim()) ? { results: st.all(...params), meta: { rows_read: 1 } } : { results: [], meta: { changes: Number(st.run(...params).changes), rows_written: 1 } }; } };
}

// ---------- simulated eBay ----------
let NEXT = {}, EBAY = [];
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function mockEbay() {
  globalThis.fetch = async (url) => { url = String(url); if (!url.includes("api.ebay.com")) throw new Error("unexpected request " + url); EBAY.push(url);
    if (url.includes("/oauth2/token")) return reply(200, { access_token: "T", expires_in: 7200 });
    if (url.includes("/developer/analytics/")) return NEXT.analytics ? NEXT.analytics() : reply(500, {});
    if (url.includes("/buy/browse/")) return NEXT.browse ? NEXT.browse() : reply(200, { itemSummaries: [] });
    return reply(200, {}); };
}
const SRC = fs.readFileSync(new URL("../../worker.js", import.meta.url), "utf8");
const load = () => new Function(SRC.replace(/export default\s*\{[\s\S]*$/, "") + "\nreturn { kvGet, kvSet, ebay, quota, saveQuota, pausedFor, refreshRate, sweep, ebayDay, EbayPaused, addCalls: (n) => { CALLS += n; } };")();

export async function runTest(rawExec, tag) {
  const prefix = `d1t-${tag}-`, stats = {}, exec = makeGuardedExec(rawExec, prefix, stats), env = { DB: d1From(exec), EBAY_ID: "id", EBAY_SECRET: "s" };
  const R = [], add = (name, ok, detail = "") => { R.push({ name, status: ok ? "PASS" : "FAIL", detail }); out((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : "")); };
  mockEbay();
  const n0 = (await rawExec("SELECT COUNT(*) n FROM listings", [])).results[0].n;
  add("test database checked before writing (small: not the live database)", n0 < MAX_LISTINGS, `${n0} listings`); if (n0 >= MAX_LISTINGS) return R;
  const mine = (await rawExec("SELECT COUNT(*) n FROM kv WHERE substr(k,1,?)=?", [prefix.length, prefix])).results[0].n;
  add(`run tag "${tag}" is new`, mine === 0, `${mine} rows already use ${prefix}`); if (mine) return R;
  if (process.env.RL_MARK) fs.writeFileSync(process.env.RL_MARK, tag); // from here on, rows with this prefix were created by THIS run
  const others = (await rawExec("SELECT COUNT(*) n FROM kv WHERE NOT substr(k,1,?)=?", [prefix.length, prefix])).results[0].n;
  try {
    // 1. counting: 12 separate Worker copies save at the same moment
    const copies = Array.from({ length: 12 }, load);
    for (const c of copies) c.addCalls(17);
    await Promise.all(copies.map((c) => c.saveQuota(env)));
    const q = await copies[0].kvGet(env, "quota", null);
    add("12 copies saving at the same moment: every call counted (new one-step method)", q && q.n === 204 && q.d === copies[0].ebayDay(), `${q && q.n} of 204, day ${q && q.d}`);
    // the OLD method (read, add, write back) for comparison
    await exec("DELETE FROM kv WHERE k=?", ["quota"]);
    const oldSave = async (c) => { const v = await c.kvGet(env, "quota", { n: 0 }); await c.kvSet(env, "quota", { d: "old", n: v.n + 17 }); };
    await Promise.all(copies.map(oldSave));
    const old = await copies[0].kvGet(env, "quota", { n: 0 });
    add("for comparison, the OLD method loses counts when copies overlap", old.n < 204, `old method kept ${old.n} of 204`);
    await exec("DELETE FROM kv WHERE k=?", ["quota"]);
    await copies[0].kvSet(env, "quota", { d: "2026-01-01", n: 4999 }); copies[1].addCalls(3); await copies[1].saveQuota(env);
    add("a new eBay day starts from zero on D1", (await copies[1].kvGet(env, "quota")).n === 3);
    const plan = (await rawExec(`EXPLAIN QUERY PLAN SELECT v FROM kv WHERE k='${prefix}quota'`, [])).results.map((r) => r.detail).join("; ");
    add("counting reads/writes one row by its key (no table scan)", /USING INDEX sqlite_autoindex_kv_1|PRIMARY KEY/.test(plan), plan);

    // 2. pause shared between separate copies (as separate Worker instances)
    const A = load(), B = load(), C = load(); NEXT = { browse: () => reply(429, { errors: [{ errorId: 2001, message: "Too many requests" }] }, { "retry-after": "600" }) }; EBAY = [];
    await assert.rejects(A.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), A.EbayPaused);
    const before = EBAY.filter((u) => u.includes("/buy/browse/")).length;
    let pausedB = false; try { await B.ebay(env, "/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=1"); } catch (e) { pausedB = e instanceof B.EbayPaused; }
    add("a pause written by one copy stops another copy: nothing sent to eBay", pausedB && EBAY.filter((u) => u.includes("/buy/browse/")).length === before, `copy B paused: ${pausedB}`);
    add("the pause covers only Browse: Taxonomy and Trading not paused", !(await C.pausedFor(env, "taxonomy", true)) && !(await C.pausedFor(env, "trading", true)));
    const g = await C.pausedFor(env, "browse", true);
    add("pause length from eBay's Retry-After (10 minutes)", g && Math.abs(g.until - (Date.now() + 600e3)) < 30e3 && g.src === "retry-after", g && `${Math.round((g.until - Date.now()) / 60000)} min, ${g.src}`);
    await exec("DELETE FROM kv WHERE k=?", ["ebayGate"]);

    // 3. eBay's figures (simulated): all Browse used up → pause before any refused call; Trading at 0 doesn't matter for Browse
    const reset = Date.now() + 2 * 3600e3, rl = (b1, b2) => () => reply(200, { rateLimits: [
      { apiContext: "buy", apiName: "browse", resources: [{ name: "buy.browse", rates: [{ limit: 5000, remaining: b1, reset: new Date(reset).toISOString(), timeWindow: 86400 }] }, { name: "buy.browse.item.bulk", rates: [{ limit: 5000, remaining: b2, reset: new Date(reset).toISOString(), timeWindow: 86400 }] }] },
      { apiContext: "TradingAPI", apiName: "TradingAPI", resources: [{ name: "GetItem", rates: [{ limit: 5000, remaining: 0, reset: new Date(reset).toISOString(), timeWindow: 86400 }] }] }] });
    const D = load(); NEXT = { analytics: rl(800, 900) }; await D.refreshRate(env);
    add("eBay's figures: Trading at 0 never pauses Browse", !(await D.pausedFor(env, "browse", true)));
    await exec("DELETE FROM kv WHERE k=?", ["ebayRate"]);
    const E = load(); NEXT = { analytics: rl(0, 0) }; await E.refreshRate(env);
    const F = load(), gf = await F.pausedFor(env, "browse", true);
    add("eBay's figures: all Browse used up → paused until eBay's reset, seen by another copy", gf && Math.abs(gf.until - reset) < 2000 && gf.why === "limit");

    // 4. scan while paused, on D1: no eBay calls, message stored once for the app
    await E.kvSet(env, "config", { cats: [{ id: "27386", name: "Graphics Cards" }], types: { bin: true } }); await E.kvSet(env, "lastRun", 0);
    EBAY = []; const S1 = load(), r1 = await S1.sweep(env, false); const rep1 = await S1.kvGet(env, "lastReport", null);
    add("scan while paused: no eBay calls, clear message stored", r1.skipped === "eBay paused" && EBAY.length === 0 && /daily limit is reached: eBay searches and checks paused until \d\d:\d\d \(UK time\)/.test(rep1.errors[0]), rep1.errors[0]);
    const w0 = Object.values(stats).reduce((a, s) => a + s.written, 0); const S2 = load(); await S2.sweep(env, false);
    const w1 = Object.values(stats).reduce((a, s) => a + s.written, 0);
    add("the next minute while paused writes nothing to the database", w1 === w0, `${w1 - w0} rows written`);
  } finally {
    await rawExec("DELETE FROM kv WHERE substr(k,1,?)=?", [prefix.length, prefix]);
    const left = (await rawExec("SELECT COUNT(*) n FROM kv WHERE substr(k,1,?)=?", [prefix.length, prefix])).results[0].n;
    const others2 = (await rawExec("SELECT COUNT(*) n FROM kv WHERE NOT substr(k,1,?)=?", [prefix.length, prefix])).results[0].n;
    add("cleanup: this run's rows removed, every other settings row untouched", left === 0 && others2 === others, `${left} left; other rows ${others} → ${others2}`);
    globalThis.fetch = realFetch;
  }
  out("\nDATABASE COST PER OPERATION (rows read / rows written / ms, averaged):");
  for (const [k, s] of Object.entries(stats)) out(`  ${String(s.n).padStart(3)}× ${(s.read / s.n).toFixed(1).padStart(5)} read ${(s.written / s.n).toFixed(1).padStart(4)} written ${(s.ms / s.n).toFixed(2).padStart(6)} ms | ${k}`);
  return R;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, tag] = process.argv.slice(2);
  if (!/^[a-z0-9]{6,24}$/.test(tag || "")) { out("REFUSED: run tag must be 6-24 lowercase letters/digits"); process.exit(1); }
  if (cmd === "local") { const L = await localExec(); const R = await runTest(L.exec, tag); out("other row kept:", JSON.stringify(L.db.prepare("SELECT * FROM kv").all())); process.exit(R.every((r) => r.status === "PASS") ? 0 : 1); }
  if (cmd === "remote" || cmd === "cleanup") {
    const ACC = process.env.CF_ACC, TOK = process.env.CF_TOKEN;
    const l = await (await realFetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database?per_page=100`, { headers: { Authorization: `Bearer ${TOK}` } })).json();
    const g = guardList((l.result || []).map((d) => ({ name: d.name, uuid: d.uuid })));
    if (!g.ok) { out("REFUSED: " + g.why); process.exit(1); }
    out(`test database ${TEST_DB_NAME} found and proved different from the live database (ids checked)`);
    const raw = remoteExec(ACC, TOK, g.id), prefix = `d1t-${tag}-`;
    if (cmd === "cleanup") { await raw("DELETE FROM kv WHERE substr(k,1,?)=?", [prefix.length, prefix]); out("cleanup: " + (await raw("SELECT COUNT(*) n FROM kv WHERE substr(k,1,?)=?", [prefix.length, prefix])).results[0].n + " rows of this run left"); process.exit(0); }
    const R = await runTest(raw, tag); fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/ratelimit-d1.json", JSON.stringify(R, null, 1));
    process.exit(R.every((r) => r.status === "PASS") ? 0 : 1);
  }
  out("usage: local|remote|cleanup <tag>"); process.exit(2);
}
