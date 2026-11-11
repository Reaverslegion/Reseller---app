// Scan time limits on the PRIVATE TEST Scan service + fake eBay + throwaway database (9 Nov 2026):
// stalled eBay answers (no answer at all, or headers then a stalled body), an exceeded budget, the hard stop, lock release, a safe retry, existing deals kept, and no
// overlapping scan while a slow one runs. Short limits are set through kv "scanLimits" (it can only shorten them).
// Run: TEST_APP_KEY=... node tests/stage4/scan-time.mjs
import fs from "node:fs";
import * as F from "../integrity/scan-flow.mjs";
const URL_ = "http://127.0.0.1:8787", EBAY = "http://127.0.0.1:8788", rows = [], AREA = "Back end (scan time limits)";
const add = (name, ok, detail = "") => { const s = ok ? "PASS" : "FAIL"; rows.push({ area: AREA, name, status: s, detail: String(detail).slice(0, 300) }); console.log(s.padEnd(5), name, detail ? "— " + String(detail).slice(0, 260) : ""); };
{ const die = (e) => { try { rows.push({ area: "Test run", name: "scan-time.mjs: the test script itself stopped", status: "FAIL", detail: String((e && e.stack) || e).slice(0, 300) });
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/scan-time-crash.json", JSON.stringify(rows.filter((r) => r.area === "Test run"))); } catch (x) {} process.exit(1); };
  process.on("uncaughtException", die); process.on("unhandledRejection", die); }
const run = () => fetch(`${URL_}/?run=1`, { headers: { "X-FlipScout-Key": process.env.TEST_APP_KEY } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sched = () => fetch(`${URL_}/__scheduled`).then((r) => ({ status: r.status }));
const mode = (m) => fetch(`${EBAY}/__fake/mode`, { method: "POST", body: JSON.stringify({ mode: m }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kv = async (k) => { const r = (await F.query("SELECT v FROM kv WHERE k=?", [k]))[0]; return r ? JSON.parse(r.v) : null; };
const calls = async () => { const q = await kv("quota"); return q ? +q.n || 0 : 0; };
const dealIds = async () => (await F.query("SELECT id FROM deals ORDER BY id")).map((r) => r.id);
const lockFree = async () => !(+(await kv("scanLock")) > Date.now());
const seed = (lim) => F.seedSql([], { lastRun: 0, lastManual: 0, rate: { h: 0, n: {} }, scanLimits: lim });
const timed = async (f) => { const t = Date.now(), r = await f(); return { ...r, ms: Date.now() - t }; };
const errs = (r) => (r.body && r.body.errors) || [];

try {
  await mode("normal");
  await F.seedSql([["DELETE FROM deals"], ["DELETE FROM listings"]], { config: F.CONFIG, keyver: 3, fix1: true, rate: { h: 0, n: {} }, scanLimits: null });
  await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(7) });
  const L = []; let id = 780000000000;
  F.MODELS.forEach((m) => [0.5, 0.6, 0.7, 0.8].forEach((f) => L.push(F.listing({ id: ++id, title: `${m.title.replace(" Graphics Card", "")} used #${id}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
  await F.fakeSearch(L);
  await seed(null); const ref = await run(), have = await dealIds();
  add(`a normal scan within the limits is complete (${have.length} deals)`, ref.status === 200 && !ref.body.incomplete && have.length > 0, `answered ${ref.status}, errors: ${errs(ref).join("; ") || "none"}`);

  // 1. eBay stops answering: every call gives up after the (shortened) timeout; the scan ends, says so, keeps the deals
  await seed({ net: 1500, soft: 8000, hard: 12000 }); await mode("stall");
  const st = await timed(run); await mode("normal");
  add("stalled eBay: the scan ends instead of waiting (each call gives up after the timeout)", st.status === 200 && st.ms < 12000 + 1500 + 5000, `answered ${st.status} after ${(st.ms / 1000).toFixed(1)} s`);
  add("…and reports the problem clearly", errs(st).some((e) => /no answer within/.test(e)), errs(st).slice(0, 2).join("; "));
  add("…and the deals already found are kept", JSON.stringify(await dealIds()) === JSON.stringify(have), `${(await dealIds()).length} deals (before ${have.length})`);
  add("…and the lock is released", await lockFree(), "");

  // 1b. eBay sends its headers straight away but the rest of the answer never comes: reading the answer gives up too
  await seed({ net: 1500, soft: 8000, hard: 12000 }); await mode("stall-body");
  const sb = await timed(run); await mode("normal");
  add("stalled answer body (headers arrive, the rest never does): the scan ends instead of waiting", sb.status === 200 && sb.ms < 12000 + 1500 + 5000, `answered ${sb.status} after ${(sb.ms / 1000).toFixed(1)} s`);
  add("…and reports it as eBay not answering in time", errs(sb).some((e) => /no answer within/.test(e)), errs(sb).slice(0, 2).join("; "));
  add("…and the deals already found are kept, and the lock is released", JSON.stringify(await dealIds()) === JSON.stringify(have) && (await lockFree()), `${(await dealIds()).length} deals (before ${have.length})`);

  // 2. the budget runs out: no new eBay call starts, the scan is marked incomplete, the rest waits for the next scan
  await seed({ net: 3000, soft: 600, hard: 15000 }); await mode("slow"); const c0 = await calls();
  const bu = await timed(run); await mode("normal"); const used = (await calls()) - c0;
  add("budget used up: the scan stops starting eBay calls and says it's incomplete", bu.status === 200 && bu.body.incomplete === "time budget" && errs(bu).some((e) => /Scan stopped early/.test(e)), `incomplete=${bu.body.incomplete}; ${errs(bu).slice(-1)[0] || ""}`);
  add("…after only a few eBay calls (not the whole scan)", used > 0 && used < 10, `${used} eBay calls`);
  add("…the deals already found are kept, and the lock is released", JSON.stringify(await dealIds()) === JSON.stringify(have) && (await lockFree()), "");

  // 3. the hard stop: a call that hangs past it is the last thing the scan waits for; nothing runs afterwards
  await seed({ net: 4000, soft: 500, hard: 1500 }); await mode("stall");
  const hs = await timed(run); await mode("normal");
  add("hard stop: the scan ends within the hard stop + one timed-out call", hs.status === 200 && hs.ms < 1500 + 4000 + 4000, `answered ${hs.status} after ${(hs.ms / 1000).toFixed(1)} s, incomplete=${hs.body.incomplete}`);
  add("…reports that it stopped at the safety limit", hs.body.incomplete === "safety limit" && errs(hs).some((e) => /safety limit/.test(e)), errs(hs).slice(-1)[0] || "");
  add("…keeps the deals and releases the lock", JSON.stringify(await dealIds()) === JSON.stringify(have) && (await lockFree()), "");
  const rep = await kv("lastReport");
  add("…and the incomplete scan is recorded for the app and Admin", rep && rep.incomplete === "safety limit", JSON.stringify(rep || {}).slice(0, 120));

  // 4. a safe retry: the very next scan (once the usual 45 s / interval allow it) is normal and complete
  await seed(null); const again = await run();
  add("retry after an incomplete scan: the next scan runs normally and completes", again.status === 200 && !again.body.incomplete && !errs(again).length, `answered ${again.status}, errors: ${errs(again).join("; ") || "none"}`);

  // 5. no overlap while a slow (stalled) scan runs, even once the 45 seconds and the interval have passed
  await seed({ net: 3000, soft: 20000, hard: 30000 }); await mode("stall"); const c1 = await calls();
  const slow = run(); await sleep(1500); await F.seedSql([], { lastManual: 0, lastRun: 0 });
  const during = await run(); await sched(); const slowRes = await slow; await mode("normal");
  add("while a stalled scan runs, a new manual scan is refused and the background job doesn't start one", during.status === 429 && slowRes.status === 200, `answers ${during.status}, slow scan ${slowRes.status}`);
  add("…and the stalled scan still ends and releases the lock", await lockFree(), `${(await calls()) - c1} eBay calls attempted`);
} finally {
  await mode("normal").catch(() => {}); await F.seedSql([], { scanLimits: null }).catch(() => {});
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/scan-time.json", JSON.stringify(rows));
}
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
