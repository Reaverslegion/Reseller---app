// One scan at a time (9 Nov 2026): manual + manual, manual + background and background + background must never run
// together, also when a scan takes longer than the 45-second "Just scanned" window; a scan that was cut off must not
// block scans for ever; the 45-second limit for manual scans stays.
// PRIVATE TEST Scan service + fake eBay + throwaway database only. Run: TEST_APP_KEY=... node tests/stage4/scan-lock.mjs [rounds]
import fs from "node:fs";
import * as F from "../integrity/scan-flow.mjs";
const URL_ = "http://127.0.0.1:8787", EBAY = "http://127.0.0.1:8788", rows = [], AREA = "Back end (one scan at a time)";
const ROUNDS = +process.argv[2] || 20;
const add = (name, ok, detail = "") => { const s = ok ? "PASS" : "FAIL"; rows.push({ area: AREA, name, status: s, detail: String(detail).slice(0, 300) }); console.log(s.padEnd(5), name, detail ? "— " + String(detail).slice(0, 240) : ""); };
{ const die = (e) => { try { rows.push({ area: "Test run", name: "scan-lock.mjs: the test script itself stopped", status: "FAIL", detail: String((e && e.stack) || e).slice(0, 300) });
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/scan-lock-crash.json", JSON.stringify(rows.filter((r) => r.area === "Test run"))); } catch (x) {} process.exit(1); };
  process.on("uncaughtException", die); process.on("unhandledRejection", die); }
const run = () => fetch(`${URL_}/?run=1`, { headers: { "X-FlipScout-Key": process.env.TEST_APP_KEY } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const sched = () => fetch(`${URL_}/__scheduled`).then((r) => ({ status: r.status, sched: true }));
const mode = (m) => fetch(`${EBAY}/__fake/mode`, { method: "POST", body: JSON.stringify({ mode: m }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kv = async (k) => { const r = (await F.query("SELECT v FROM kv WHERE k=?", [k]))[0]; return r ? JSON.parse(r.v) : null; };
const calls = async () => { const q = await kv("quota"); return q ? +q.n || 0 : 0; };
// a scan has finished when its report is newer than t and no scan holds the lock
const settled = async (t, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const r = await kv("lastReport"), l = await kv("scanLock");
  if (r && r.at >= t && !(+l > Date.now())) return true; await sleep(250); } return false; };
const reset = (extra = {}) => F.seedSql([["DELETE FROM deals"], ["DELETE FROM listings"]], { lastRun: 0, lastManual: 0, rate: { h: 0, n: {} }, ...extra });

try {
  await mode("normal");
  // an eBay pause left by an EARLIER test (backend-gaps.mjs sends a fake 429 with Retry-After) would make the first scans here
  // send nothing; wait for it to end, plus the Scan service's 30-second memory of it, so this test starts from a normal state
  { const g = await kv("ebayGate"), until = Math.max(0, ...Object.values(g || {}).map((x) => +(x && x.until) || 0));
    if (until > Date.now()) { console.log(`(waiting ${Math.ceil((until - Date.now()) / 1000) + 31} s for an eBay pause left by an earlier test to end)`); await sleep(until - Date.now() + 31000); } }
  await F.seedSql([["DELETE FROM deals"], ["DELETE FROM listings"]], { config: F.CONFIG, keyver: 3, fix1: true, rate: { h: 0, n: {} } });
  await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(7) });
  const L = []; let id = 770000000000;
  F.MODELS.forEach((m) => [0.5, 0.6, 0.7, 0.8].forEach((f) => L.push(F.listing({ id: ++id, title: `${m.title.replace(" Graphics Card", "")} used #${id}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
  await F.fakeSearch(L);

  // reference: the eBay calls ONE scan makes. It varies a little (the first scan also fetches a sign-in token, background
  // scans skip a manual-only step), so it's measured as a range; two scans at once would be about double.
  const solo = []; let one, c0, t0;
  for (const f of [run, run, sched]) { await reset(); c0 = await calls(); t0 = Date.now(); const r = await f(); await settled(t0); solo.push((await calls()) - c0); if (f === run && !one) one = r; }
  const LO = Math.min(...solo), HI = Math.max(...solo), ONE = `${LO}–${HI}`;
  add(`a single scan works and makes ${ONE} eBay calls (manual, manual, background)`, one.status === 200 && LO > 0 && HI < 2 * LO, `answered ${one.status}; ${solo.join(", ")}`);
  // one scan's calls vary by a call or two (e.g. 14–16), so "one scan" = some calls but fewer than two scans' worth
  const oneScan = (n) => n > 0 && n < 2 * LO - 2;

  // 1. many requests at the same moment, repeatedly: exactly one scan may run
  let bad = [], err5 = [];
  for (let i = 0; i < ROUNDS; i++) {
    await reset(); c0 = await calls(); const t = Date.now();
    const res = await Promise.all([run(), run(), run(), run(), run(), sched(), sched()]);
    if (!(await settled(t))) bad.push(`round ${i + 1}: scan never finished`);
    const n = (await calls()) - c0, ok200 = res.filter((r) => !r.sched && r.status === 200).length;
    if (!oneScan(n) || ok200 > 1) bad.push(`round ${i + 1}: ${n} eBay calls (one scan = ${ONE}), manual answers ${res.filter((r) => !r.sched).map((r) => r.status).join("/")}`);
    err5.push(...res.filter((r) => r.status >= 500).map((r) => r.status));
  }
  add(`5 manual + 2 background requests at once, ${ROUNDS} rounds: only one scan ever runs`, !bad.length, bad.slice(0, 3).join("; ") || "one scan every round");
  add("…and no server errors", !err5.length, err5.join(", "));

  // 2. a scan that takes longer than the 45-second window: once 45 s have passed (lastManual cleared), new requests
  //    must still be refused while it runs (real slow scan: fake eBay answers every call half a second late)
  await reset(); await mode("slow"); c0 = await calls(); const tl = Date.now();
  const long = run(); await sleep(1500);
  await F.seedSql([], { lastManual: 0, lastRun: 0 }); // as if the 45 s and the background interval had passed
  const during = await Promise.all([run(), sched()]); await sleep(500); const busy = await run();
  const longRes = await long; await mode("normal"); await settled(tl, 60000); const nl = (await calls()) - c0;
  add("a long scan is not overlapped once 45 s have passed: a new manual scan is refused while it runs", during[0].status === 429 && busy.status === 429, `answers ${during[0].status}, ${busy.status}; ${JSON.stringify(during[0].body).slice(0, 90)}`);
  add("…and the background job doesn't start a second scan either (exactly one scan's eBay calls)", longRes.status === 200 && oneScan(nl), `${nl} eBay calls, long scan answered ${longRes.status}`);

  // 3. a scan that was cut off (lock left behind) blocks scans only until the lock runs out, never for ever
  await reset({ scanLock: Date.now() + 60000 }); const blocked = await run();
  add("a lock still in date (a scan running elsewhere) refuses a manual scan with 429, not a server error", blocked.status === 429, `answered ${blocked.status}`);
  await reset({ scanLock: Date.now() - 1000 }); const after = await run();
  add("a lock left behind by a scan that was cut off, once out of date, no longer blocks: the next scan runs", after.status === 200, `answered ${after.status}`);
  const lk = await kv("scanLock");
  add("…and a finished scan releases its lock straight away", !(+lk > Date.now()), `lock ${lk}`);

  // 4. the existing limits are unchanged: a second manual scan within 45 s is still "Just scanned"
  await reset(); await run(); const again = await run();
  add("the 45-second limit for manual scans is unchanged ('Just scanned')", again.status === 429 && /Just scanned/.test(again.body.error || ""), `answered ${again.status}: ${again.body.error || ""}`);
  await reset(); const c1 = await calls(); const t2 = Date.now(); await sched(); await settled(t2); const sch = (await calls()) - c1;
  add("a background scan on its own still runs when due", oneScan(sch), `${sch} eBay calls`);
  // (a background tick that doesn't scan may still do its small existing deal checks, so "no scan" = lastRun unchanged)
  await F.seedSql([], {}); const r0 = await kv("lastRun"), c2 = await calls(); await sched(); await sleep(2000); const r1 = await kv("lastRun");
  add("…and is still skipped when not due (scan scheduling unchanged)", r1 === r0 && (await calls()) - c2 < LO, `last scan time ${r1 === r0 ? "unchanged" : "CHANGED"}, ${(await calls()) - c2} eBay calls by other background checks`);
} finally {
  await mode("normal").catch(() => {});
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/scan-lock.json", JSON.stringify(rows));
}
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
