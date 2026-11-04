// Stage 3 on the Android emulator: the data-integrity audit (tests/integrity/audit.mjs) driven through the REAL app
// with real taps, against the private test Scan service, its throwaway database and the fake eBay only.
// Run (inside the emulator job, after journeys.mjs): TEST_APP_KEY=... node tests/android/integrity.mjs
import fs from "node:fs";
import { App, Results, sleep, sh, adb, PKG } from "./driver.mjs";
import { runAudit } from "../integrity/audit.mjs";

const KEY = process.env.TEST_APP_KEY;
const CHAOS = (m) => fetch(`http://127.0.0.1:8791/mode?m=${m}`).then((r) => r.json()).catch(() => null);
const app = new App("screenshots/integrity"), R = new Results(app);
app.netQuiet = async () => { let last = -1, same = 0; for (let i = 0; i < 30; i++) { let n = 0; try { n = Object.values((await (await fetch("http://127.0.0.1:8791/stats")).json()).stats).reduce((a, b) => a + b, 0); } catch (e) { return; }
  if (n === last) { if (++same >= 3) return; } else { same = 0; last = n; } await sleep(1000); } };
app.beforeJourney = () => CHAOS("normal");
adb("reverse", "tcp:8787", "tcp:8789");
fs.mkdirSync("results", { recursive: true });
app.startLog("logcat-integrity.txt");
app.prepPhone();

const tabs = (n) => app.tap({ sel: "#nav button", nth: n });
const drv = {
  eval: (e) => app.eval(e), waitFor: (e, ms, w) => app.waitFor(e, ms, w), waitText: (t, ms) => app.waitText(t, ms),
  tap: (s) => app.tap(s), fill: (s, t) => app.fill(s, t), back: () => app.back(), shot: (n) => app.shot(n),
  relaunch: async () => { await app.stop(); await app.launch(); app.cal = null; await app.waitFor(`typeof render==="function"`, 30000, "the app"); },
  menu: () => tabs(2), dealsTab: () => tabs(0),
};

// a clean app, set up through its own screens the way a new user would
const ready = await R.journey("Android emulator", "Stage 3 set-up (clean app)", async (step) => {
  await step("app data cleared and app opened", async () => { try { sh(`pm clear ${PKG}`); } catch (e) {} try { sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`); } catch (e) {}
    await app.launch(); await app.waitFor(`typeof render==="function"`, 30000, "the app"); });
  await step("welcome guide", async () => { await app.waitText("Your 24/7 bargain hunter", 20000); for (let i = 0; i < 3; i++) await app.tap({ text: "Next", exact: true });
    await app.tap("Private seller"); await app.tap("Start using FlipScout"); });
  await step("connect to the test Scan service", async () => { await app.tap("Connect now"); await app.waitFor(`!!document.getElementById("s_url")`, 8000, "address box");
    await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`);
    await app.waitFor(`(()=>{try{return JSON.parse(localStorage.getItem("resell_helper_v1")).set.key.length===48}catch(e){return false}})()`, 8000, "connection saved"); });
  await step("popular categories", async () => { await tabs(0); await app.waitText("Pick what to hunt", 15000); await app.tap("Start with popular categories"); await app.waitText("Added \\d+ popular categor", 15000); });
  await step("admin tools on (for Scan now)", async () => { await tabs(2); const p = await app.locate({ text: "FlipScout version", sel: "div[onclick]" });
    for (let i = 0; i < 7; i++) { await app.tapXY(p.x, p.y); await sleep(150); } await app.waitText("Admin tools on", 6000); await tabs(0); });
});
let log = [];
if (ready) log = await runAudit(drv, R);
try { app.logcat && app.logcat.kill(); } catch (e) {}
fs.writeFileSync("results/integrity.json", JSON.stringify(R.rows, null, 1));
const c = (s) => R.rows.filter((r) => r.status === s).length;
console.log(`\nIntegrity audit: ${c("PASS")} passed, ${c("FAIL")} failed, ${c("PARTIALLY TESTED")} partly, ${c("NOT TESTED")} not run`);
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
console.log("\nDiscrepancy details (first 5 of each):");
for (const x of log) console.log(`- ${x.check}: ${x.count}\n    ` + x.items.slice(0, 5).map((i) => JSON.stringify(i)).join("\n    "));
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
