// FOCUSED BACK-BUTTON INVESTIGATION (11–12 Nov 2026): why the phone's Back button sometimes leaves the app on a deal page.
// Same test app, test Scan service and fake deals as the journeys. Three rounds, each on a freshly installed app set up like
// a person (setup code TYPED, popular categories added; the cloud-restore offer, if shown, answered "Not now"):
//   A) fresh session, Android's autofill on          B) fresh session, Android's autofill off
//   C) LONG session like the failing runs: sort picker, sales sheet (closed with Back), Dark/Light theme, app restarts,
//      then Back on a deal page both straight away (as the journeys do) and after 6 s (as the auction steps do)
// For every Back press it records: the app's own navigation state (screen, Back history, sheet/picker flags, focused
// element, how many "backbutton" events reached the page), Android's focused window (an "isn't responding" box or another
// window would show here) and the phone-log lines around the press. If a press fails, it records whether a 2nd press works.
// Nothing in the app is changed; the only thing added is a passive counter of the page's "backbutton" events.
// Run (inside the emulator job): APK=... TEST_APP_KEY=... node tests/android/back-check.mjs   (part=back)
import fs from "node:fs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import { App, Results, sleep, sh, adb, PKG } from "./driver.mjs";
import { makeDeals, seedDeals } from "./seed.mjs";

const KEY = process.env.TEST_APP_KEY, APK = process.env.APK || "FlipScout.apk", TRIES = +process.env.TRIES || 10, CYCLES = +process.env.CYCLES || 8;
const app = new App("screenshots"), R = new Results(app, "results/back-check.json"), AREA = "Back button investigation";
const safe = (f) => { try { return f(); } catch (e) { return `(failed: ${String(e.message || e).split("\n")[0]})`; } };
const focus = () => safe(() => sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")).replace(/\s+/g, " ").trim().slice(0, 300);
const LOG = "logcat-back.txt", logSize = () => { try { return fs.statSync(LOG).size; } catch (e) { return 0; } };
const logSince = (n) => { try { return fs.readFileSync(LOG, "utf8").slice(n).split("\n").filter((l) => /autofill|KEYCODE_BACK|onBackPressed|backbutton|InputDispatcher|ANR|not responding|Killing|Capacitor|chromium.*Console|WindowManager.*focus/i.test(l)).slice(-14).map((l) => l.slice(0, 200)).join(" | "); } catch (e) { return ""; } };
const COUNTER = `(()=>{if(window.__pgBack===undefined){window.__pgBack=0;document.addEventListener("backbutton",()=>{window.__pgBack++})}return window.__pgBack})()`;
const STATE = `JSON.stringify({tab:typeof tab!=="undefined"?tab:null,prev:typeof prev!=="undefined"?prev.slice(-5):null,sheet:typeof sheetOn!=="undefined"?sheetOn:null,pick:typeof pickOn!=="undefined"?!!pickOn:null,onb:document.getElementById("onb")&&document.getElementById("onb").style.display,active:document.activeElement&&(document.activeElement.tagName+(document.activeElement.id?"#"+document.activeElement.id:"")),pageBack:window.__pgBack||0})`;
const onList = `!!document.querySelector(".dcard")&&document.getElementById("gear").style.visibility!=="visible"`;
const waitList = async (ms = 6000) => { for (let w = 0; w < ms / 500; w++) { if (await app.eval(onList).catch(() => false)) return true; await sleep(500); } return false; };
const toDeals = async () => { if (await app.eval(onList).catch(() => false)) return; await app.tap({ sel: "#nav button", nth: 0 }); await app.waitFor(`!!document.querySelector(".dcard")`, 15000, "deal cards"); };
const tally = {};

adb("reverse", "tcp:8787", "tcp:8789"); // the phone's localhost:8787 = the test Scan service (as in the journeys)
app.startLog(LOG);
app.prepPhone();
for (let i = 0; i < 18; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();
const svc0 = safe(() => sh("settings get secure autofill_service")).trim();
R.add(AREA, "Android's autofill service on this emulator (as it comes)", "PASS", svc0 || "(none)");
await seedDeals(makeDeals(14));

// one Back press on a deal page, fully recorded. wait = how long the deal page is open before Back (0 = like the journeys)
async function press(round, label, nth, wait) {
  const t = (tally[round] = tally[round] || { ok: 0, fail: 0, second: 0, fails: [] });
  try {
    await toDeals(); await app.unblock();
    await app.tap({ sel: ".dcard", nth, wait: 1200 });
    await app.waitFor(`document.getElementById("gear").style.visibility==="visible"`, 8000, "the deal page");
    if (wait) await sleep(wait);
    const before = { app: JSON.parse(await app.eval(STATE)), focus: focus() }, L = logSize();
    await app.back();
    if (await waitList()) { t.ok++; return; }
    t.fail++;
    const after = { app: JSON.parse(await app.eval(STATE).catch(() => "{}")), focus: focus() }, lines = logSince(L), shot = await app.shot(`back-fail ${round} ${label}`);
    await app.back(); const b2 = await waitList(); if (b2) t.second++;
    t.fails.push({ label, wait, before, after, secondPressWorked: b2, log: lines, shot });
    if (!b2) await toDeals().catch(() => {});
  } catch (e) { t.fails.push({ label, wait, setupError: String(e.message || e).slice(0, 200) }); await toDeals().catch(() => {}); }
}
function report(round, n) {
  const t = tally[round] || { ok: 0, fail: 0, second: 0, fails: [] }, errs = t.fails.filter((f) => f.setupError);
  R.add(AREA, `${round}: the phone's Back button on a deal page returned to the list`, t.fail ? "FAIL" : errs.length ? "PARTIALLY TESTED" : "PASS",
    `${t.ok} of ${t.ok + t.fail} presses${t.fail ? `; ${t.fail} failed, a 2nd press then worked ${t.second} times` : ""}${errs.length ? `; ${errs.length} presses not made (test setup)` : ""}`);
  for (const f of t.fails) R.add(AREA, `${round}: ${f.setupError ? "press not made" : "press failed"} (${f.label})`, f.setupError ? "PARTIALLY TESTED" : "FAIL", JSON.stringify(f).slice(0, 1800));
  console.log(round, JSON.stringify(t, null, 1).slice(0, 8000));
}

// a freshly installed app, set up like a person
async function setup(round, autofillOn) {
  safe(() => sh(`pm uninstall ${PKG}`)); await sleep(1000);
  if (!autofillOn) safe(() => sh("settings put secure autofill_service null")); else if (svc0 && svc0 !== "null") safe(() => sh(`settings put secure autofill_service ${svc0}`));
  const now = safe(() => sh("settings get secure autofill_service")).trim();
  await R.journey(AREA, `${round}: set up like a person (autofill service: ${now || "none"})`, async (step) => {
    await step("installed and opened", async () => { app.install(APK); await app.launch(); await app.waitFor(`typeof render==="function"&&!!document.getElementById("app")`, 30000, "the app"); });
    await step("welcome guide closed", async () => { await app.waitText("Your 24/7 bargain hunter", 15000); for (let i = 0; i < 3; i++) await app.tap({ text: "Next", exact: true });
      await app.tap("Private seller"); await app.tap("Start using FlipScout"); await app.waitText("Connect your Scan ser", 8000); });
    await step("setup code TYPED into the connection box", async () => { await app.tap("Connect now"); await app.waitFor(`!!document.getElementById("s_url")`, 8000, "address box");
      await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`);
      await app.waitFor(`(()=>{try{return JSON.parse(localStorage.getItem("resell_helper_v1")).set.key.length===48}catch(e){return false}})()`, 8000, "saved"); });
    await step("cloud-restore offer answered 'Not now' if it appears (an earlier round's backup)", async () => { await sleep(2500);
      if (await app.eval(`sheetOn&&/Restore your data\\?/.test(document.getElementById("sheet").innerText)`)) { await app.tap({ text: "Not now", exact: true }); await app.waitFor(`!sheetOn`, 5000, "the offer closed"); } });
    await step("popular categories added; deals list shown", async () => { await app.tap({ sel: "#nav button", nth: 0 }); await app.waitText("Pick what to hunt", 15000);
      await app.tap("Start with popular categories"); await app.waitFor(`!!document.querySelector(".dcard")`, 40000, "deal cards"); await app.eval(COUNTER); });
  });
}

await setup("A (fresh, autofill on)", true);
for (let i = 0; i < TRIES; i++) await press("A (fresh, autofill on)", `press ${i + 1}`, i % 6, i % 2 ? 2500 : 0);
report("A (fresh, autofill on)");
await setup("B (fresh, autofill off)", false);
for (let i = 0; i < TRIES; i++) await press("B (fresh, autofill off)", `press ${i + 1}`, i % 6, i % 2 ? 2500 : 0);
report("B (fresh, autofill off)");
if (svc0 && svc0 !== "null") safe(() => sh(`settings put secure autofill_service ${svc0}`));

// C: the long session (autofill back on, as the failing runs had it)
await setup("C (long session)", true);
const C = "C (long session)", steps = { sort: 0, sheet: 0, theme: 0, restart: 0 }, stepErr = [];
for (let k = 1; k <= CYCLES; k++) {
  const tryStep = async (name, f) => { try { await f(); steps[name]++; } catch (e) { stepErr.push(`cycle ${k} ${name}: ${String(e.message || e).slice(0, 120)}`); await toDeals().catch(() => {}); } };
  await tryStep("sort", async () => { await toDeals(); await app.tap({ sel: "#ds" }); await app.waitFor(`document.getElementById("pick").style.display==="block"`, 5000, "sort choices");
    await app.tap({ text: k % 2 ? "Most profit" : "Best score" }); await app.waitFor(`!pickOn`, 5000, "the sort picker closed"); });
  await tryStep("sheet", async () => { await toDeals(); const link = await app.eval(`(()=>{const e=[...document.querySelectorAll("#app *")].find(x=>!x.children.length&&/^From \\d+ sales?/.test(x.textContent.trim()));return e?e.textContent.trim():""})()`);
    if (!link) throw new Error("no 'From N sales' link on screen"); await app.tap({ text: link }); await app.waitFor(`sheetOn`, 8000, "the sales sheet");
    await sleep(1500); await app.back(); await app.waitFor(`!sheetOn`, 5000, "Back closed the sales sheet"); });
  await tryStep("theme", async () => { await app.tap({ sel: "#nav button", nth: 2 }); await app.tap({ text: k % 2 ? "Dark" : "Light", exact: true });
    await app.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(k % 2 ? "dark" : "light")}`, 4000, "the theme"); await toDeals(); });
  if (k % 3 === 0) await tryStep("restart", async () => { await app.stop(); await sleep(1000); await app.launch(); await app.waitFor(`typeof render==="function"`, 30000, "the app");
    await app.waitFor(`!!document.querySelector(".dcard")`, 30000, "deal cards"); await app.eval(COUNTER); });
  await press(C, `cycle ${k}, Back straight away`, k % 6, 0);
  await press(C, `cycle ${k}, Back after 6 s`, (k + 2) % 6, 6000);
}
R.add(AREA, `${C}: the steps before each press were done`, stepErr.length ? "PARTIALLY TESTED" : "PASS", `sort ${steps.sort}, sales sheet ${steps.sheet}, theme ${steps.theme}, restarts ${steps.restart} of ${CYCLES} cycles${stepErr.length ? "; " + stepErr.join(" · ") : ""}`);
report(C);

// the new "Back up now" feedback on the real app (test Scan service): busy at once, success only after the reply, announced
await R.journey("Backup button", "Back up now shows progress and the result", async (step) => {
  await step("Settings → Back up now: 'Backing up…' and disabled straight away", async () => {
    await app.tap({ sel: "#nav button", nth: 2 }); await app.waitFor(`!!document.getElementById("bk_now")`, 8000, "the Back up now button");
    await app.eval(`(()=>{window.__bk=[];const s=document.getElementById("bk_st"),b=document.getElementById("bk_now");new MutationObserver(()=>window.__bk.push([b.textContent,b.disabled,s.textContent])).observe(document.getElementById("app"),{subtree:true,childList:true,characterData:true,attributes:true});return 1})()`);
    await app.tap({ sel: "#bk_now" });
    await app.waitFor(`(window.__bk||[]).some(x=>x[0]==="Backing up…"&&x[1]===true)`, 3000, "'Backing up…' on a disabled button"); });
  await step("then 'Backed up at HH:MM' in the status line that TalkBack reads", async () => {
    await app.waitFor(`/^Backed up at \\d\\d:\\d\\d\\.$/.test(document.getElementById("bk_st").textContent)`, 25000, "Backed up at …");
    const r = await app.eval(`JSON.stringify({role:document.getElementById("bk_st").getAttribute("role"),live:document.getElementById("bk_st").getAttribute("aria-live"),btn:document.getElementById("bk_now").textContent,dis:document.getElementById("bk_now").disabled})`);
    const j = JSON.parse(r); if (j.role !== "status" || j.live !== "polite" || j.dis || j.btn !== "Back up now") throw new Error("status line or button wrong: " + r); await app.shot("backup done"); });
});
const sum = (k) => { const t = tally[k] || { ok: 0, fail: 0 }; return `${t.fail} of ${t.ok + t.fail}`; };
R.add(AREA, "summary: Back presses that failed", "PASS", `A fresh+autofill: ${sum("A (fresh, autofill on)")} · B fresh, no autofill: ${sum("B (fresh, autofill off)")} · C long session: ${sum(C)}`);
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + String(r.detail).slice(0, 400) : ""}`);
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
