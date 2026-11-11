// Stage 4: harmless security tests against the PRIVATE TEST Scan service only (127.0.0.1). Never the live one.
// Key checks, injection attempts, malformed and oversized data, rate limits, error messages, backup safety.
// Run: TEST_APP_KEY=... TEST_URL=http://127.0.0.1:8787 node tests/security/service-security.mjs
import fs from "node:fs";
const URL_ = process.env.TEST_URL || "http://127.0.0.1:8787", KEY = process.env.TEST_APP_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_)) { console.error("REFUSED: security tests only run against a local test service"); process.exit(1); }
const rows = [], AREA = "Security";
const add = (name, ok, detail = "", status) => { rows.push({ area: AREA, name, status: status || (ok ? "PASS" : "FAIL"), detail: String(detail).slice(0, 300) }); console.log((status || (ok ? "PASS" : "FAIL")).padEnd(17), name, detail ? "— " + String(detail).slice(0, 200) : ""); };

// if this script itself crashes, say so as a FAIL row (and keep every row already recorded) — never a silent gap
{ const die = (e) => { try { rows.push({ area: "Test run", name: `${process.argv[1].split("/").pop()}: the test script itself stopped`, status: "FAIL", detail: String((e && e.stack) || e).slice(0, 300) });
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync(`results/${process.argv[1].split("/").pop().replace(/\.mjs$/, "")}-crash.json`, JSON.stringify(rows.filter((r) => r.area === "Test run"))); } catch (x) {} process.exit(1); };
  process.on("uncaughtException", die); process.on("unhandledRejection", die); }
const call = async (q, { key = KEY, header = true, method, body, raw } = {}) => {
  const h = {}; if (key && header) h["X-FlipScout-Key"] = key;
  const r = await fetch(`${URL_}/?${q}${key && !header ? "&key=" + encodeURIComponent(key) : ""}`, { method: method || (body !== undefined || raw !== undefined ? "POST" : "GET"), headers: { ...h, "content-type": "text/plain" }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {} return { status: r.status, text, json, headers: r.headers };
};
const q = async (sql, args = []) => (await call("__testquery=1", { body: { q: sql, args } })).json.rows;
const ENDPOINTS = ["deals=1", "config=1", "prices=1", "follows=1", "flags=1", "backup=1", "problems=1", "sales=x", "needs=1", "fillstats=1", "ebayconnect=1", "check=123", "q=rtx", "tree=1", "lookfor=rtx", "seen=1"];

// 1. the key (a space before or after the key isn't a near miss: web requests strip it before the service sees it)
let bad = [];
for (const e of ENDPOINTS) for (const k of [null, "wrong", KEY.slice(0, -1), KEY + "x", KEY.toUpperCase() === KEY ? KEY.toLowerCase() : KEY.toUpperCase(), KEY.slice(0, 5) + (KEY[5] === "a" ? "b" : "a") + KEY.slice(6)])
  { const r = await call(e, { key: k }); if (r.status !== 401) bad.push(`${e} with ${k === null ? "no key" : "a near-miss key"} → ${r.status}`); }
add(`every endpoint (${ENDPOINTS.length}) refuses no key, a wrong key and near-miss keys (${ENDPOINTS.length * 6} tries)`, !bad.length, bad.slice(0, 3).join("; "));
const inUrl = await call("deals=1", { header: false });
add("key accepted in the web address (older app versions)", true, `answered ${inUrl.status}: still accepted. Keys in web addresses can end up in logs; the current app sends it in a header. Recommend dropping this once no old app versions remain.`, "PARTIALLY TESTED");
const pre = await fetch(`${URL_}/?deals=1`, { method: "OPTIONS" });
add("browser permission check (OPTIONS) needs no key but returns nothing", pre.status < 300 && !(await pre.text()), `status ${pre.status}`);
add("any website may call the service (Access-Control-Allow-Origin: *), so the key is the only protection", pre.headers.get("access-control-allow-origin") === "*", "by design: the app runs from its own local page; the key must stay secret", "PARTIALLY TESTED");

// 2. injection attempts (SQL and others) leave the data intact and never cause a server error
const before = (await q("SELECT COUNT(*) n FROM deals"))[0].n, tables = (await q("SELECT COUNT(*) n FROM sqlite_master"))[0].n;
const evil = ["' OR '1'='1", "1; DROP TABLE deals; --", "\" OR 1=1 --", "%27%20OR%201%3D1", "../../etc/passwd", "<script>alert(1)</script>", "${7*7}", "\u0000", "x".repeat(5000), "😀".repeat(500)];
bad = [];
for (const v of evil) for (const p of ["sales", "check", "unfollow", "unprice", "lookfor", "unflag", "seen", "q", "suggest"]) {
  const r = await call(`${p}=${encodeURIComponent(v)}`); if (r.status >= 500) bad.push(`${p}=${v.slice(0, 20)} → ${r.status} ${String(r.json && r.json.error).slice(0, 60)}`);
}
const after = (await q("SELECT COUNT(*) n FROM deals"))[0].n, tables2 = (await q("SELECT COUNT(*) n FROM sqlite_master"))[0].n;
add(`${evil.length * 9} injection attempts (SQL, path, script, template, control characters, huge, emoji) on 9 inputs: no server error`, !bad.length, bad.slice(0, 3).join("; "));
add("after the injection attempts, no table or deal was changed or dropped", before === after && tables === tables2, `deals ${before}→${after}, tables ${tables}→${tables2}`);

// 3. malformed and oversized data
const cfg0 = (await call("config=1")).json.config;
const m1 = await call("config=1", { raw: "{not json" }), m2 = await call("price=1", { raw: "[[[" }), m3 = await call("follow=1", { raw: "" });
add("garbled data is refused as a bad request (400), not a server error", [m1, m2, m3].every((r) => r.status === 400), [m1, m2, m3].map((r) => r.status).join(", "));
const weird = await call("config=1", { body: { cats: [{ id: "1; DROP", name: "<b>x</b>" }, { id: "27386", name: "x".repeat(500) }, ...Array.from({ length: 50 }, (_, i) => ({ id: String(i), name: "c" }))], rules: { maxSpend: -5, minProfit: "abc" }, region: "mars", interval: 7 } });
const cc = weird.json && weird.json.config;
add("settings with wrong types, bad ids, too many categories and odd values are cleaned before saving", !!cc && cc.cats.every((c) => /^\d+$/.test(c.id)) && cc.cats.length <= 15 && cc.rules.maxSpend >= 0 && cc.region === "uk" && cc.interval === 0 && cc.cats.every((c) => c.name.length <= 80),
  cc ? `${cc.cats.length} categories kept, maxSpend ${cc.rules.maxSpend}, region ${cc.region}` : weird.status);
await call("config=1", { body: cfg0 });
const big = await call("backup=1", { raw: JSON.stringify({ x: "a".repeat(5_100_000) }) });
add("a backup over 5 MB is refused (413) and nothing is overwritten", big.status === 413, `status ${big.status}`);
const good = { test: "backup-integrity", at: 1 }; await call("backup=1", { body: good });
const garbled = await call("backup=1", { raw: "{oops" }), kept = (await call("backup=1")).json;
add("a garbled backup is refused (400) and the saved backup is unchanged", garbled.status === 400 && kept && kept.data && kept.data.test === "backup-integrity", `status ${garbled.status}`);

// 4. rate limits stop a leaked key running up eBay calls
await call("__testseed=1", { body: { kv: { rate: { h: 0, n: {} } } } }); // start the hour's counts from zero
let last = 0, n = 0; for (; n < 305; n++) { const r = await call(`q=ratelimit${n}`); last = r.status; if (r.status === 429) break; }
add("searches are limited to 300 an hour (the 301st is refused, 429)", last === 429 && n === 300, `refused after ${n} searches (status ${last})`);
await call("__testseed=1", { body: { kv: { rate: { h: 0, n: {} } } } });
let rl = 0; for (let i = 0; i < 125; i++) { const r = await call("report=1", { body: { kind: "rate test", msg: "x" } }); if (r.status === 429) { rl = i; break; } }
add("problem reports from the app are limited (120 an hour)", rl === 120, `refused after ${rl}`);

// 5. nothing secret in any answer or in the problem log
const answers = []; for (const e of ENDPOINTS) answers.push((await call(e)).text);
const errs = await q("SELECT msg, place, ver FROM errlog");
const leak = (t) => t.includes(KEY) || /fake-secret|EBAY_SECRET|APP_KEY|FCM_SA|private_key|-----BEGIN/i.test(t);
add("no answer contains the key, eBay secret or other credentials", !answers.some(leak), "");
add("the problem log contains no key or credentials", !errs.some((r) => leak(JSON.stringify(r))), `${errs.length} problems recorded`);
add("server errors don't include internal details such as file paths or program traces", !answers.some((t) => /at [\w.]+ \(|\.js:\d+:\d+|node_modules|\/home\//.test(t)), "");

// 6. one user's data can't reach another
add("each person's data lives in their own Scan service and database; there are no user accounts to mix up", true,
  "by design (one private Scan service per user, one key). Anyone with the key sees everything on that service; keys must never be shared", "PARTIALLY TESTED");

fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/security.json", JSON.stringify(rows, null, 1));
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
