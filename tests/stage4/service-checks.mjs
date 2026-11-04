// Stage 4 on the PRIVATE TEST Scan service only: background-job failures are recorded, ordinary bad requests aren't
// treated as faults, and (in GitHub, where the test service keeps its data on disk) a restart loses nothing.
// Run: TEST_APP_KEY=... [RESTART_CMD="bash tests/e2e/restart-test-service.sh"] node tests/stage4/service-checks.mjs
import fs from "node:fs";
import { execSync } from "node:child_process";
import * as F from "../integrity/scan-flow.mjs";
const URL_ = "http://127.0.0.1:8787", KEY = process.env.TEST_APP_KEY, rows = [];
const add = (area, name, status, detail = "") => { rows.push({ area, name, status, detail: String(detail).slice(0, 300) }); console.log(status.padEnd(17), name, detail ? "— " + String(detail).slice(0, 200) : ""); };
const ok = (b) => (b ? "PASS" : "FAIL");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = "CREATE TABLE IF NOT EXISTS errlog (sig TEXT PRIMARY KEY, src TEXT, kind TEXT, msg TEXT, place TEXT, ver TEXT, n INTEGER, first INTEGER, at INTEGER, alerted INTEGER)";
const errlog = (w = "1=1") => F.query(`SELECT src, kind, msg, place, n FROM errlog WHERE ${w}`);
const req = (q, o = {}) => fetch(`${URL_}/?${q}`, { ...o, headers: { "X-FlipScout-Key": KEY, "content-type": "text/plain" } });

// 1. the background job (every few minutes on the real service) fails: recorded, and the next run still works
try {
  await F.seedSql([[LOG], ["DELETE FROM errlog"]], { config: F.CONFIG, lastRun: 0, keyver: 3, fix1: true });
  await F.seedSql([["CREATE TRIGGER IF NOT EXISTS stage4job BEFORE INSERT ON kv WHEN NEW.k='lastRun' BEGIN SELECT RAISE(ABORT,'stage4 harmless background failure'); END"]]);
  const s = await fetch(`${URL_}/__scheduled`).then((r) => r.status).catch((e) => e.message);
  let r = []; for (let i = 0; i < 15 && !r.length; i++) { await sleep(1000); r = await errlog("kind='background job failed'"); }
  add("Monitoring", "a failed background scan is recorded (where, message), not lost", ok(r.length === 1 && r[0].place === "scan" && /stage4 harmless background failure/.test(r[0].msg)),
    r[0] ? `${r[0].src} · ${r[0].kind} at ${r[0].place}: ${r[0].msg}` : `job trigger answered ${s}; nothing recorded`);
  const crash = (await F.query("SELECT v FROM kv WHERE k='lastCrash'"))[0];
  add("Monitoring", "the 'last background problem' note shown in the app is saved too", ok(!!crash && /stage4 harmless/.test(crash.v)), crash ? crash.v.slice(0, 120) : "not saved");
} catch (e) { add("Monitoring", "a failed background scan is recorded", "FAIL", e.message); }
finally { await F.seedSql([["DROP TRIGGER IF EXISTS stage4job"]]).catch(() => {}); }
{ const s = await fetch(`${URL_}/__scheduled`).then((r) => r.status).catch(() => 0); await sleep(3000);
  const last = (await F.query("SELECT v FROM kv WHERE k='lastRun'"))[0];
  add("Reliability", "after the failure, the next background run works normally", ok(s === 200 && last && +last.v > 0), last ? `last run recorded at ${new Date(+last.v).toISOString()}` : `job answered ${s}`); }

// 2. a person's mistake (bad data) isn't a fault, so it doesn't fill the log or send alerts
await F.seedSql([["DELETE FROM errlog"]]);
for (let i = 0; i < 5; i++) await req("price=1", { method: "POST", body: "{garbled" });
add("Monitoring", "requests with bad data are answered 'bad request' and not logged as faults (no false alarms)", ok(!(await errlog()).length), `${(await errlog()).length} recorded`);

// 3. the problem list itself
await F.seedSql([], { rate: { h: 0, n: {} } }); // the security test used up this hour's report allowance
await req("report=1", { method: "POST", body: JSON.stringify({ kind: "test", msg: "stage 4 check", ver: "2.0" }) });
const pr = await req("problems=1").then((r) => r.json());
add("Monitoring", "the problem list can be read (newest first) with the key, and not without it", ok(Array.isArray(pr.problems) && pr.problems[0].kind === "test" && (await fetch(`${URL_}/?problems=1`)).status === 401), `${pr.problems.length} problems listed`);

// 4. restart the Scan service mid-use: nothing is lost
if (process.env.RESTART_CMD) {
  await F.seedSql([["DELETE FROM deals"], ["INSERT INTO deals (id,data,score,created,expires) VALUES ('998000000001',?,50,?,?)", [JSON.stringify({ id: "998000000001", kind: "deal", title: "restart test", price: 10 }), Date.now(), Date.now() + 864e5]]]);
  await req("backup=1", { method: "POST", body: JSON.stringify({ items: [{ id: 1, name: "restart test item" }], at: 1 }) });
  const before = { deals: (await F.query("SELECT COUNT(*) n FROM deals"))[0].n, errs: (await errlog()).length };
  const t = Date.now(); try { execSync(process.env.RESTART_CMD, { stdio: "inherit", timeout: 180000 }); } catch (e) { add("Reliability", "Scan service restarted", "FAIL", e.message); }
  const after = { deals: (await F.query("SELECT COUNT(*) n FROM deals"))[0].n, errs: (await errlog()).length }, bk = await req("backup=1").then((r) => r.json());
  add("Reliability", `Scan service stopped and started again (${((Date.now() - t) / 1000).toFixed(0)} s): deals, backup and problem log all kept`,
    ok(after.deals === before.deals && after.errs === before.errs && bk.data && bk.data.items[0].name === "restart test item"), `before ${JSON.stringify(before)} · after ${JSON.stringify(after)}`);
} else add("Reliability", "Scan service restart keeps all data", "NOT TESTED", "only run in GitHub, where the test service keeps its data on disk");

fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/service-stage4.json", JSON.stringify(rows, null, 1));
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
