// FOCUSED BACK-BUTTON INVESTIGATION (11 Nov 2026): why the phone's Back button sometimes leaves the app on a deal page.
// Same test app, test Scan service and fake deals as the journeys. Two rounds on a freshly installed app:
//   A) the emulator as it comes (Android's autofill service on), B) Android's autofill service switched off.
// In each round the setup code is TYPED into the connection box (as a person would, and as the journeys do), then a deal
// is opened and the phone's Back button pressed, many times. For every press it records what Android and the app were
// doing: the focused window, autofill's state, autofill/back lines from the phone's log, the app's screen and how many Back
// events reached the page. Nothing in the app is changed; the only thing added is a passive counter of the page's
// "backbutton" events (it doesn't touch Android's Back handling). If a press fails, it records whether a 2nd press works.
// Run (inside the emulator job): APK=... TEST_APP_KEY=... TRIES=15 node tests/android/back-check.mjs
import fs from "node:fs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import { App, Results, sleep, sh, adb, PKG } from "./driver.mjs";
import { makeDeals, seedDeals } from "./seed.mjs";

const KEY = process.env.TEST_APP_KEY, APK = process.env.APK || "FlipScout.apk", TRIES = +process.env.TRIES || 15;
const app = new App("screenshots"), R = new Results(app, "results/back-check.json"), AREA = "Back button investigation";
const safe = (f) => { try { return f(); } catch (e) { return `(failed: ${String(e.message || e).split("\n")[0]})`; } };
const focus = () => safe(() => sh("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")).replace(/\s+/g, " ").trim();
const autofill = () => safe(() => sh("dumpsys autofill | grep -iE 'Session|Save UI|Fill UI|showing|mUi|FillUi|SaveUi' | head -12")).replace(/\s+/g, " ").trim().slice(0, 400);
const logSince = (n) => { try { return fs.readFileSync("logcat-back.txt", "utf8").slice(n).split("\n").filter((l) => /autofill|SaveUi|FillUi|KEYCODE_BACK|onBackPressed|OnBackPressed|backbutton|InputDispatcher|Capacitor\/Plugin|Capacitor.*App/i.test(l)).slice(-12).map((l) => l.slice(0, 220)).join(" | "); } catch (e) { return ""; } };
const logSize = () => { try { return fs.statSync("logcat-back.txt").size; } catch (e) { return 0; } };
const COUNTER = `(()=>{if(!window.__pgBack){window.__pgBack=0;document.addEventListener("backbutton",()=>{window.__pgBack++})}return window.__pgBack})()`;
const STATE = `JSON.stringify({tab:typeof tab!=="undefined"?tab:null,prev:typeof prev!=="undefined"?prev.length:null,sheet:typeof sheetOn!=="undefined"?sheetOn:null,pick:typeof pickOn!=="undefined"?!!pickOn:null,active:document.activeElement&&document.activeElement.tagName,pageBack:window.__pgBack||0})`;

adb("reverse", "tcp:8787", "tcp:8789"); // the phone's localhost:8787 = the test Scan service (as in the journeys)
app.startLog("logcat-back.txt");
app.prepPhone();
for (let i = 0; i < 18; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();
const svc0 = safe(() => sh("settings get secure autofill_service")).trim();
R.add(AREA, "Android's autofill service on this emulator (as it comes)", "PASS", svc0 || "(none)");
await seedDeals(makeDeals(14));

async function round(label, autofillOn) {
  safe(() => sh(`pm uninstall ${PKG}`)); await sleep(1000);
  if (!autofillOn) safe(() => sh("settings put secure autofill_service null")); else if (svc0 && svc0 !== "null") safe(() => sh(`settings put secure autofill_service ${svc0}`));
  const now = safe(() => sh("settings get secure autofill_service")).trim();
  let ok = 0, fail = 0, second = 0; const fails = [];
  await R.journey(AREA, `${label}: set up like a person (autofill service: ${now || "none"})`, async (step) => {
    await step("installed and opened", async () => { app.install(APK); await app.launch(); await app.waitFor(`typeof render==="function"&&!!document.getElementById("app")`, 30000, "the app"); });
    await step("welcome guide closed", async () => { await app.waitText("Your 24/7 bargain hunter", 15000); for (let i = 0; i < 3; i++) await app.tap({ text: "Next", exact: true });
      await app.tap("Private seller"); await app.tap("Start using FlipScout"); await app.waitText("Connect your Scan ser", 8000); });
    await step("setup code TYPED into the connection box", async () => { await app.tap("Connect now"); await app.waitFor(`!!document.getElementById("s_url")`, 8000, "address box");
      await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`);
      await app.waitFor(`(()=>{try{return JSON.parse(localStorage.getItem("resell_helper_v1")).set.key.length===48}catch(e){return false}})()`, 8000, "saved"); });
    await step("deals list shown", async () => { await app.tap({ sel: "#nav button", nth: 0 }); await app.waitFor(`!!document.querySelector(".dcard")`, 30000, "deal cards"); await app.eval(COUNTER); });
  });
  for (let i = 0; i < TRIES; i++) {
    try {
      await app.waitFor(`!!document.querySelector(".dcard")`, 10000, "deal cards");
      await app.tap({ sel: ".dcard", nth: i % 6, wait: 1200 });
      await app.waitFor(`document.getElementById("gear").style.visibility==="visible"`, 8000, "the deal page");
      await sleep(2500); // the deal page's live check, as in the journeys
      const before = { app: JSON.parse(await app.eval(STATE)), focus: focus(), autofill: autofill() }, L = logSize();
      await app.back();
      let back = false; for (let w = 0; w < 12 && !back; w++) { back = await app.eval(`!!document.querySelector(".dcard")&&document.getElementById("gear").style.visibility!=="visible"`).catch(() => false); if (!back) await sleep(500); }
      if (back) { ok++; continue; }
      fail++; const after = { app: JSON.parse(await app.eval(STATE).catch(() => "{}")), focus: focus() }, lines = logSince(L);
      const s = await app.shot(`back-fail-${label}-${i + 1}`);
      await app.back(); let b2 = false; for (let w = 0; w < 12 && !b2; w++) { b2 = await app.eval(`!!document.querySelector(".dcard")&&document.getElementById("gear").style.visibility!=="visible"`).catch(() => false); if (!b2) await sleep(500); }
      if (b2) second++;
      fails.push({ press: i + 1, before, after, secondPressWorked: b2, log: lines, shot: s });
      if (!b2) { await app.tap({ sel: "#nav button", nth: 0 }).catch(() => {}); await sleep(1500); }
    } catch (e) { fails.push({ press: i + 1, error: String(e.message || e).slice(0, 200) }); fail++; await app.tap({ sel: "#nav button", nth: 0 }).catch(() => {}); await sleep(1500); }
  }
  R.add(AREA, `${label}: the phone's Back button on a deal page returned to the list`, fail ? "FAIL" : "PASS", `${ok} of ${TRIES} presses${fail ? `; ${fail} failed, a 2nd press then worked ${second} times` : ""}`);
  for (const f of fails) R.add(AREA, `${label}: press ${f.press} failed`, "FAIL", JSON.stringify(f).slice(0, 1500));
  console.log(`${label}: ${ok}/${TRIES} OK`, JSON.stringify(fails, null, 1).slice(0, 6000));
  return { ok, fail };
}

const a = await round("A (autofill on)", true);
const b = await round("B (autofill off)", false);
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
if (svc0 && svc0 !== "null") safe(() => sh(`settings put secure autofill_service ${svc0}`));
R.add(AREA, "summary (failures with autofill on vs off)", "PASS", `on: ${a.fail} of ${TRIES} failed · off: ${b.fail} of ${TRIES} failed`);
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + String(r.detail).slice(0, 300) : ""}`);
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
