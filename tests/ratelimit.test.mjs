// eBay rate-limit protection (429 pauses, eBay's own figures, reliable counting, pacing, app status).
// Every eBay reply here is a MOCK: nothing is sent to eBay. Run: node tests/ratelimit.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const SRC = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const NAMES = "schema, kvGet, kvSet, ebay, quota, saveQuota, pausedFor, refreshRate, freshRate, sweep, soldDetails, getItemTrading, ebayDay, EbayPaused, DAY";
const load = () => new Function(SRC.replace(/export default\s*\{[\s\S]*$/, "") + `\nreturn { ${NAMES}, calls: () => CALLS, addCalls: (n) => { CALLS += n; } };`)(); // a fresh copy = a separate Worker instance
const mkEnv = (db) => {
  // database stand-in; every call waits a moment, like a real network database, so overlapping runs really interleave
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => { await new Promise((r) => setTimeout(r, 1)); return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    all: async () => { await new Promise((r) => setTimeout(r, 1)); return { results: db.prepare(sql).all(...args) }; }, first: async () => { await new Promise((r) => setTimeout(r, 1)); return db.prepare(sql).get(...args) || null; } });
  return { DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } }, EBAY_ID: "id", EBAY_SECRET: "s", APP_KEY: "k" };
};
const newDb = () => new DatabaseSync(":memory:");

// ---- mock eBay ----
let LOG = [], NEXT = {};
const reply = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
globalThis.fetch = async (url, o = {}) => {
  url = String(url); LOG.push(url);
  if (url.includes("/identity/v1/oauth2/token")) return reply(200, { access_token: "T", expires_in: 7200 });
  if (url.includes("/developer/analytics/")) return NEXT.analytics ? NEXT.analytics() : reply(500, { errors: [{ errorId: 105000 }] });
  if (url.includes("/ws/api.dll")) return NEXT.trading ? NEXT.trading(o) : reply(200, "<GetItemResponse><Ack>Success</Ack></GetItemResponse>");
  if (url.includes("/commerce/taxonomy/")) return NEXT.taxonomy ? NEXT.taxonomy() : reply(200, { categorySuggestions: [] });
  if (url.includes("/buy/browse/")) return NEXT.browse ? NEXT.browse(url) : reply(200, { itemSummaries: [] });
  return reply(404, {});
};
const browseCalls = () => LOG.filter((u) => u.includes("/buy/browse/")).length;
const too = (headers = {}, body = { errors: [{ errorId: 2001, message: "Too many requests. The request limit has been reached for the resource." }] }) => () => reply(429, body, headers);
// eBay's figures; Trading (exhausted) is included on purpose: it must never affect Browse
const official = (remaining, resetMs, limit = 5000, other = 4999) => () => reply(200, { rateLimits: [
  { apiContext: "buy", apiName: "browse", resources: [
    { name: "buy.browse", rates: [{ limit, remaining, reset: new Date(resetMs).toISOString(), timeWindow: 86400 }] },
    { name: "buy.browse.item.bulk", rates: [{ limit: 5000, remaining: other, reset: new Date(resetMs).toISOString(), timeWindow: 86400 }] }] },
  { apiContext: "TradingAPI", apiName: "TradingAPI", resources: [{ name: "GetItem", rates: [{ limit: 5000, remaining: 0, reset: new Date(resetMs + 7200e3).toISOString(), timeWindow: 86400 }] }] }] });
const uk = (t) => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

let n = 0; const t = async (name, fn) => { LOG = []; NEXT = {}; await fn(); n++; console.log("✓", name); };
const near = (a, b, ms = 5000) => assert.ok(Math.abs(a - b) < ms, `${new Date(a).toISOString()} vs ${new Date(b).toISOString()}`);

await t("429 with Retry-After (seconds): every eBay search pauses for exactly that long; no further requests are sent", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  NEXT.browse = too({ "retry-after": "120" });
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), (e) => e instanceof W.EbayPaused && /slow down/.test(e.message) && e.message.includes(uk(Date.now() + 120e3)));
  const g = await W.pausedFor(env, "browse", true); near(g.until, Date.now() + 120e3); assert.equal(g.src, "retry-after"); assert.equal(g.why, "slow");
  assert.equal(g.info.retryAfter, "120"); assert.match(g.info.error, /2001 Too many requests/); assert.ok(g.info.headers.some((h) => /retry-after: 120/.test(h)), "eBay's reply is recorded for diagnosis");
  const before = browseCalls();
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=1"), W.EbayPaused);
  assert.equal(browseCalls(), before, "paused: the item lookup (same Browse allowance) sent nothing to eBay");
  assert.equal(LOG.filter((u) => u.includes("analytics")).length, 0, "Retry-After given: eBay's figures weren't needed");
});

await t("429 with Retry-After as a date several hours away: treated as the daily limit, paused until then", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  const until = Date.now() + 5 * 3600e3; NEXT.browse = too({ "retry-after": new Date(until).toUTCString() });
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), (e) => /daily limit is reached/.test(e.message));
  const g = await W.pausedFor(env, "browse", true); near(g.until, until, 1500); assert.equal(g.why, "limit");
});

await t("429 without Retry-After, eBay's figures say 0 left: paused until eBay's own reset time (not a guessed time)", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  const reset = Date.now() + 3 * 3600e3 + 17 * 60000; NEXT.browse = too(); NEXT.analytics = official(0, reset);
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), (e) => /daily limit is reached/.test(e.message) && e.message.includes(uk(reset)) && /when eBay resets it/.test(e.message));
  const g = await W.pausedFor(env, "browse", true); near(g.until, reset, 1000);
  assert.equal(g.src, "ebay figures"); assert.equal(g.info.ebay.remaining, 0); assert.equal(g.info.ebay.resource, "buy.browse", "the resource with fewest calls left");
});

await t("a 429 is NOT assumed to be the daily limit: eBay says calls are left → short pauses that grow (2, 5, 15 … min) and reset later", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  NEXT.browse = too(); NEXT.analytics = official(3120, Date.now() + 10 * 3600e3);
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), (e) => /slow down/.test(e.message));
  let g = await W.pausedFor(env, "browse", true); near(g.until, Date.now() + 2 * 60000); assert.equal(g.tries, 1); assert.equal(g.src, "ebay says calls are left");
  // the pause ends, eBay refuses again → 5 minutes
  const all = await W.kvGet(env, "ebayGate", {}); all.browse.until = Date.now() - 1000; await W.kvSet(env, "ebayGate", all); await W.pausedFor(env, "browse", true); // re-read (a copy caches the pause for up to 30 s)
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), W.EbayPaused);
  g = await W.pausedFor(env, "browse", true); near(g.until, Date.now() + 5 * 60000); assert.equal(g.tries, 2);
  // a refusal long after the last pause starts again at 2 minutes
  const all2 = await W.kvGet(env, "ebayGate", {}); all2.browse.until = Date.now() - 3 * 3600e3; await W.kvSet(env, "ebayGate", all2); await W.pausedFor(env, "browse", true);
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), W.EbayPaused);
  g = await W.pausedFor(env, "browse", true); assert.equal(g.tries, 1);
});

await t("eBay's figures unavailable: short growing pauses (still never a fixed daily guess)", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  NEXT.browse = too(); // analytics answers 500 by default
  await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), W.EbayPaused);
  const g = await W.pausedFor(env, "browse", true); assert.equal(g.src, "backoff"); near(g.until, Date.now() + 2 * 60000);
});

await t("a pause is shared by every copy of the Scan service, and Taxonomy has its own (separate eBay allowance)", async () => {
  const db = newDb(), A = load(), B = load(), env = mkEnv(db); await A.schema(env);
  NEXT.browse = too({ "retry-after": "600" });
  await assert.rejects(A.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), A.EbayPaused);
  const before = browseCalls();
  await assert.rejects(B.ebay(env, "/buy/browse/v1/item_summary/search?q=b"), B.EbayPaused);
  assert.equal(browseCalls(), before, "the other copy sent nothing");
  const d = await B.ebay(env, "/commerce/taxonomy/v1/category_tree/3/get_category_suggestions?q=x"); assert.ok(d.categorySuggestions, "Taxonomy still works");
  assert.equal(await B.pausedFor(env, "taxonomy", true), null);
});

await t("counting: overlapping runs and phone requests add up exactly (one statement each, no lost counts), by eBay's day", async () => {
  const db = newDb(), env = mkEnv(db), copies = [load(), load(), load(), load(), load()]; await copies[0].schema(env);
  // the OLD way (read, add, write back) loses counts when runs overlap
  const oldSave = async (n) => { const q = await copies[0].kvGet(env, "quota", { n: 0 }); await copies[0].kvSet(env, "quota", { d: "x", n: q.n + n }); };
  await Promise.all([oldSave(17), oldSave(17), oldSave(17), oldSave(17), oldSave(17)]);
  const lost = (await copies[0].kvGet(env, "quota")).n; assert.ok(lost < 85, `old way kept ${lost} of 85 (counts lost)`);
  db.prepare("DELETE FROM kv WHERE k='quota'").run();
  for (const c of copies) c.addCalls(17);
  await Promise.all(copies.map((c) => c.saveQuota(env)));
  const q = await copies[0].kvGet(env, "quota"); assert.equal(q.n, 85, "new way: all 85 counted"); assert.equal(q.d, copies[0].ebayDay());
  assert.equal(await copies[0].quota(env), 85);
  db.prepare("UPDATE kv SET v=? WHERE k='quota'").run(JSON.stringify({ d: "2026-01-01", n: 4999 }));
  copies[1].addCalls(3); await copies[1].saveQuota(env); assert.equal((await copies[1].kvGet(env, "quota")).n, 3, "a new eBay day starts from zero");
});

await t("per allowance: another API's exhausted figures (Trading) never pause Browse; one used-up Browse part doesn't pause all Browse early", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  NEXT.analytics = official(1200, Date.now() + 3 * 3600e3); await W.refreshRate(env);
  assert.equal(await W.pausedFor(env, "browse", true), null, "Trading at 0 ignored for Browse");
  assert.equal((await W.freshRate(env)).remaining, 1200, "Browse figure, not Trading's");
  const W2 = load(), env2 = mkEnv(newDb()); await W2.schema(env2);
  NEXT.analytics = official(0, Date.now() + 3 * 3600e3, 5000, 4000); await W2.refreshRate(env2);
  assert.equal(await W2.pausedFor(env2, "browse", true), null, "one Browse part used up: no early pause (its first refusal will pause it)");
  NEXT.browse = too(); await assert.rejects(W2.ebay(env2, "/buy/browse/v1/item_summary/search?q=a"), (e) => /daily limit is reached/.test(e.message));
  assert.equal(await W2.pausedFor(env2, "trading", true), null, "Trading not paused by a Browse refusal");
  assert.equal(await W2.pausedFor(env2, "taxonomy", true), null, "Taxonomy not paused by a Browse refusal");
});

await t("eBay's figures are read at most once an hour; 0 left everywhere → paused before even one refused call", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env);
  const reset = Date.now() + 2 * 3600e3; NEXT.analytics = official(0, reset, 5000, 0);
  await W.refreshRate(env); await W.refreshRate(env);
  assert.equal(LOG.filter((u) => u.includes("analytics")).length, 1, "only once an hour");
  const g = await W.pausedFor(env, "browse", true); near(g.until, reset, 1000); assert.equal(g.why, "limit");
  assert.equal((await W.freshRate(env)).remaining, 0);
});

const CFG = { cats: [{ id: "27386", name: "Graphics Cards" }, { id: "9355", name: "Mobile Phones" }], types: { bin: true, auction: true } };

await t("scan while paused: no eBay calls, a clear message for the app (written once, not every minute); Scan now explains why", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env); await W.kvSet(env, "config", CFG);
  const until = Date.now() + 90 * 60000; await W.kvSet(env, "ebayGate", { browse: { until, why: "limit", src: "ebay figures", tries: 0 } });
  const realScan = { at: Date.now() - 3 * 3600e3, checked: 17, newDeals: 2, hidden: 0, tracked: 374739, why: { judged: 900, fair: 800, noData: 50, risky: 10 }, errors: [] };
  await W.kvSet(env, "lastReport", realScan);
  const r = await W.sweep(env, false);
  assert.equal(r.skipped, "eBay paused"); assert.equal(browseCalls(), 0, "nothing sent to eBay");
  const rep = await W.kvGet(env, "lastReport"); assert.equal(rep.at, realScan.at, "'Scanned … ago' still shows the last REAL scan"); assert.equal(rep.tracked, 374739); assert.equal(rep.errors[0], `eBay's daily limit is reached: eBay searches and checks paused until ${uk(until)} (UK time), when eBay resets it`);
  assert.equal(rep.paused.until, until);
  const at = rep.at; await new Promise((r) => setTimeout(r, 5)); await W.kvSet(env, "lastRun", 0); await W.sweep(env, false);
  assert.equal((await W.kvGet(env, "lastReport")).at, at, "same pause: report not rewritten");
  const m = await W.sweep(env, true); assert.equal(m.error, undefined, "not an error reply (the app would show 'no connection')"); assert.match(m.errors[0], /paused until/);
});

await t("refused mid-scan: the scan stops asking eBay straight away and reports it once", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env); await W.kvSet(env, "config", { ...CFG, cats: [...CFG.cats, { id: "177", name: "PC Laptops" }] });
  let k = 0; NEXT.browse = (u) => (/item_summary\/search/.test(u) && ++k === 2 ? reply(429, { errors: [{ errorId: 2001 }] }, { "retry-after": "300" }) : reply(200, { itemSummaries: [] }));
  const r = await W.sweep(env, false).catch((e) => ({ crashed: e.message }));
  assert.ok(!r.crashed, r.crashed); assert.equal(k, 2, "no searches after the refusal");
  const rep = await W.kvGet(env, "lastReport"); assert.ok(rep.errors.some((e) => /paused until/.test(e)));
});

await t("automatic scans stop at 90% of eBay's day and say so; your phone's searches still work", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env); await W.kvSet(env, "config", CFG);
  await W.kvSet(env, "quota", { d: W.ebayDay(), n: 4490 });
  const r = await W.sweep(env, false); assert.equal(r.skipped, "eBay daily limit reached"); assert.equal(browseCalls(), 0);
  const rep = await W.kvGet(env, "lastReport"); assert.match(rep.errors[0], /used today's eBay allowance for automatic scans \(4490 of 5000 calls\); scans start again at \d\d:\d\d \(UK time\)\. Searches from your phone still work\./);
  const d = await W.ebay(env, "/buy/browse/v1/item_summary/search?q=rtx"); assert.ok(d.itemSummaries, "phone search allowed (reserve)");
});

// Release B (11 Nov 2026): the scan lease now lets only ONE of several scans starting together run (the others are skipped as
// "another scan is running"), so they no longer overlap; counting and the daily limit are still checked
await t("five scans starting at the same moment near the 90% line: only one runs (scan lease), every call counted, the total stays inside the day", async () => {
  const db = newDb(), env = mkEnv(db), copies = [load(), load(), load(), load(), load()]; await copies[0].schema(env); await copies[0].kvSet(env, "config", CFG);
  for (const c of copies) await c.schema(env); // each copy already running, as in production
  await copies[0].kvSet(env, "quota", { d: copies[0].ebayDay(), n: 4480 }); await copies[0].kvSet(env, "keyver", 3);
  const rs = await Promise.all(copies.map((c) => c.sweep({ ...env, AUTO: true }, false))); // as the scheduled job runs them
  const ran = rs.filter((r) => !r.skipped).length, q = (await copies[0].kvGet(env, "quota")).n; console.log("   results:", JSON.stringify(rs.map((r) => r.skipped || "scanned")));
  assert.equal(q, 4480 + browseCalls(), `every call counted (${browseCalls()} calls by ${ran} overlapping scans)`);
  assert.ok(q <= 5000, `stays inside eBay's 5,000 (${q})`);
  console.log(`   (${ran} scan ran and made ${browseCalls()} eBay calls: 4480 → ${q})`); assert.equal(ran, 1, "only one scan runs at a time"); assert.ok(rs.filter((r) => r.skipped).every((r) => /another scan is running|not due/.test(r.skipped)), "the others were skipped because a scan was running"); await copies[0].kvSet(env, "lastRun", 0);
  const after = await copies[0].sweep(env, false); assert.equal(after.skipped, "eBay daily limit reached", "the next scan stops at the 90% line");
});

await t("hard ceiling: 3 automatic copies racing to make 200 calls each stop near 4,550; at least 400 calls stay free; phone searches still work", async () => {
  const db = newDb(), env = mkEnv(db), copies = [load(), load(), load()]; await copies[0].schema(env);
  await copies[0].kvSet(env, "quota", { d: copies[0].ebayDay(), n: 4480 });
  const auto = { ...env, AUTO: true };
  const burn = async (c) => { let made = 0; try { for (let i = 0; i < 200; i++) { await c.ebay(auto, "/buy/browse/v1/item_summary/search?q=x" + i); made++; } } catch (e) { if (!(e instanceof c.EbayPaused)) throw e; } await c.saveQuota(env); return made; };
  const made = await Promise.all(copies.map(burn)), total = (await copies[0].kvGet(env, "quota")).n;
  console.log(`   (copies made ${made.join(" + ")} calls; day total 4480 → ${total}; left for the phone: ${5000 - total})`);
  assert.equal(total, 4480 + browseCalls(), "every call counted");
  assert.ok(total <= 4600 && 5000 - total >= 400, `reserve kept (${5000 - total} left)`);
  const phone = load(); const d = await phone.ebay(env, "/buy/browse/v1/item_summary/search?q=phone"); assert.ok(d.itemSummaries, "your phone's search still works");
  let msg = ""; try { await load().ebay(auto, "/buy/browse/v1/item_summary/search?q=more"); } catch (e) { msg = e.message; }
  assert.match(msg, /automatic scans have used today's allowance \(\d+ of 5000 eBay calls\); the rest is kept for your phone/);
});

await t("sold details (Trading API): eBay's usage-limit error pauses them and does NOT mark sold items as missing", async () => {
  const db = newDb(), W = load(), env = mkEnv(db); await W.schema(env); const now = Date.now();
  await W.kvSet(env, "ebayUser", { refresh: "R", refreshExp: now + 100 * W.DAY, access: "U", accessExp: now + 3600e3 });
  db.prepare("INSERT INTO fillseen (id,cat,price,at,pkey) VALUES ('11','27386',150,?,'gpu:x|used'),('12','27386',150,?,'gpu:x|used')").run(now - 2 * W.DAY, now - W.DAY);
  NEXT.trading = () => new Response("<GetItemResponse><Ack>Failure</Ack><Errors><ErrorCode>518</ErrorCode><ShortMessage>Call usage limit has been reached.</ShortMessage></Errors></GetItemResponse>", { status: 200 });
  const rep = { errors: [] }; await W.soldDetails(env, rep);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM fillseen WHERE gi_at IS NULL").get().n, 2, "neither item marked missing");
  assert.equal(LOG.filter((u) => u.includes("/ws/api.dll")).length, 1, "stopped after the first refusal");
  assert.ok(await W.pausedFor(env, "trading", true)); assert.match(rep.errors[0], /sold-details lookups paused until/);
  assert.equal(await W.pausedFor(env, "browse", true), null, "Browse searches unaffected");
  LOG = []; await W.soldDetails(env, { errors: [] }); assert.equal(LOG.length, 0, "while paused: nothing sent");
});

// ---- the real Scan service entry points (scheduled job and phone requests) ----
const fresh = () => import(new URL("../worker.js", import.meta.url) + "?r=" + Math.random()); // a new copy of the Scan service
const mod = await fresh();
const run = async (fn) => { const p = []; const ctx = { waitUntil: (x) => p.push(x) }; const out = await fn(ctx); await Promise.all(p); return out; };

await t("scheduled job while paused: no scan, no auction learning, no deal checks sent to eBay; no crash recorded", async () => {
  const db = newDb(), env = mkEnv(db); await run((ctx) => mod.default.fetch(new Request("https://x/?config=1", { headers: { "X-FlipScout-Key": "k" } }), env, ctx));
  db.prepare("INSERT INTO kv(k,v) VALUES('config',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(CFG));
  db.prepare("INSERT INTO kv(k,v) VALUES('ebayGate',?)").run(JSON.stringify({ browse: { until: Date.now() + 3600e3, why: "limit", src: "ebay figures", tries: 0 } }));
  db.prepare("INSERT INTO kv(k,v) VALUES('ebayRate',?)").run(JSON.stringify({ at: Date.now(), limit: 5000, remaining: 0, reset: Date.now() + 3600e3 }));
  db.prepare("INSERT INTO listings (id,cat,pkey,type,status,end_at,first_seen,last_seen,bids) VALUES ('900','27386','gpu:x|used','AUC','live',?,1,1,1)").run(Date.now() + 60000);
  for (let i = 0; i < 3; i++) await run((ctx) => mod.default.scheduled({}, env, ctx));
  assert.equal(browseCalls(), 0, "nothing sent to eBay's Browse API in 3 scheduled runs");
  assert.equal(db.prepare("SELECT v FROM kv WHERE k='lastCrash'").get(), undefined, "no crash recorded");
});

await t("phone search while paused: a clear message, nothing sent; when allowed, its eBay calls are counted", async () => {
  const db = newDb(), env = mkEnv(db); const H = { headers: { "X-FlipScout-Key": "k" } }, m0 = await fresh();
  await run((ctx) => m0.default.fetch(new Request("https://x/?config=1", H), env, ctx));
  db.prepare("INSERT INTO kv(k,v) VALUES('ebayGate',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify({ browse: { until: Date.now() + 1800e3, why: "slow", src: "retry-after", tries: 0 } }));
  const m1 = await fresh();
  const r1 = await run((ctx) => m1.default.fetch(new Request("https://x/?q=rtx%203070", H), env, ctx)); const j1 = await r1.json(); assert.equal(r1.status, 200, "ordinary reply, so the app shows the message");
  assert.match(j1.error, /eBay asked FlipScout to slow down: eBay searches and checks paused until \d\d:\d\d \(UK time\)/); assert.equal(browseCalls(), 0);
  db.prepare("DELETE FROM kv WHERE k='ebayGate'").run(); const m2 = await fresh();
  const r2 = await run((ctx) => m2.default.fetch(new Request("https://x/?q=rtx%203070", H), env, ctx)); assert.equal(r2.status, 200);
  const q = JSON.parse(db.prepare("SELECT v FROM kv WHERE k='quota'").get().v); assert.equal(q.n, 1, "the phone's eBay call was counted");
});

await t("existing behaviour kept: the deployed database speed fix is still in place", async () => {
  assert.ok(SRC.includes("AND type='BIN' AND +status='live'`).bind(...chunk, now - 7 * DAY, now - 2 * DAY)"));
});


// ---- Release B (11 Nov 2026): rate-limit protection combined with the scan lease and time limits ----
const lockOf = async (W, env) => +((await env.DB.prepare("SELECT v FROM kv WHERE k='scanLock'").first()) || { v: 0 }).v;
await t("Release B: eBay paused → the scan stops before taking the scan lease, so the next scan isn't blocked", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env); await W.kvSet(env, "config", CFG);
  NEXT.browse = too({ "retry-after": "120" }); await assert.rejects(W.ebay(env, "/buy/browse/v1/item_summary/search?q=a"), W.EbayPaused);
  const r = await W.sweep({ ...env, AUTO: true }, false); assert.equal(r.skipped, "eBay paused");
  assert.ok((await lockOf(W, env)) < Date.now(), "no scan lease left behind");
});
await t("Release B: eBay refuses part-way (429) → the scan ends, its lease is given back and every call that reached eBay is counted", async () => {
  const W = load(), env = mkEnv(newDb()); await W.schema(env); await W.kvSet(env, "config", { ...CFG, cats: [...CFG.cats, { id: "177", name: "PC Laptops" }] });
  let k = 0; NEXT.browse = (u) => (/item_summary\/search/.test(u) && ++k === 2 ? reply(429, { errors: [{ errorId: 2001 }] }, { "retry-after": "300" }) : reply(200, { itemSummaries: [] }));
  const r = await W.sweep({ ...env, AUTO: true }, false); assert.ok(!r.skipped, JSON.stringify(r));
  assert.ok((await lockOf(W, env)) < Date.now(), "lease given back after the refusal");
  await W.saveQuota(env); assert.equal((await W.kvGet(env, "quota")).n, browseCalls(), "every call that reached eBay counted");
});
await t("Release B: every outside network call has a time limit (only the time-limited helper calls fetch directly)", async () => {
  const direct = SRC.split("\n").filter((l) => /\bfetch\(/.test(l) && !/xfetch\(|async fetch\(request/.test(l));
  assert.equal(direct.length, 1, "only one direct fetch: " + direct.join(" | ")); assert.match(direct[0], /AbortSignal\.timeout/);
});

console.log(`\n${n} checks passed`);
