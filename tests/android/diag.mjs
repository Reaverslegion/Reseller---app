// TEST-ONLY DIAGNOSTICS (9 Nov 2026, Capacitor 8 investigation). Does nothing unless DIAG=1, which only a manual run
// with "diag" ticked sets. Never changes a result: everything is written to diag/ (uploaded with the emulator logs)
// and every failure inside here is swallowed. No app code is touched.
//  - diagEvent: one timestamped line in diag/events.log (taps, keys, launches, screen state)
//  - diagSnap: Android's own view of the phone at that moment: which window has focus, the input system's state
//    (including any event it is still waiting to deliver), the resumed activity, and the app's process
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export const DIAG = process.env.DIAG === "1";
const DIR = "diag";
let n = 0;
const adbOut = (...a) => { try { return execFileSync("adb", a, { encoding: "utf8", timeout: 30000, maxBuffer: 64 << 20 }); } catch (e) { return `(failed: ${String(e.message || e).split("\n")[0]})`; } };
const write = (f, s) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(`${DIR}/${f}`, s); } catch (e) {} };

export function diagEvent(label, extra) {
  if (!DIAG) return;
  let x = ""; try { x = extra === undefined ? "" : " " + JSON.stringify(extra); } catch (e) { x = " (unprintable)"; }
  write("events.log", `${new Date().toISOString()} ${label}${x}\n`);
}

export function diagSnap(label, pkg = "com.reaverslegion.flipscout") {
  if (!DIAG) return;
  const f = `snap-${String(++n).padStart(2, "0")}-${String(label).replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.txt`;
  const parts = [
    ["time", new Date().toISOString()],
    ["app process", adbOut("shell", `pidof ${pkg}`)],
    ["focus", adbOut("shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|mFocusedWindow|mInputMethodWindow'")],
    ["resumed activity", adbOut("shell", "dumpsys activity activities | grep -E 'topResumedActivity|ResumedActivity|mFocusedApp'")],
    ["input dispatcher", adbOut("shell", "dumpsys input | sed -n '/Input Dispatcher State/,/Input Manager State/p'")],
  ];
  write(f, parts.map(([k, v]) => `===== ${k}\n${v}\n`).join(""));
  diagEvent("SNAPSHOT " + label, { file: f });
}

// the app's screen as the test sees it, plus how many Back events reached the page (counters installed below)
export const APP_STATE = `(()=>({tab:typeof tab!=="undefined"?tab:null,prev:typeof prev!=="undefined"?prev.length:null,
  sheet:typeof sheetOn!=="undefined"?sheetOn:null,pick:typeof pickOn!=="undefined"?pickOn:null,
  deal:typeof DV!=="undefined"&&DV?DV.id:null,liveDone:typeof DV!=="undefined"&&DV?DV.live!==undefined:null,
  cards:document.querySelectorAll(".dcard").length,focused:document.activeElement&&document.activeElement.tagName,
  back:window.__diagBack||null}))()`;
// counts Back events: Capacitor's backButton event (what the app's own handler listens to) and the page's
// "backbutton" event Capacitor also sends. Only counts; the app's own handler is untouched and still runs.
export const BACK_COUNTERS = `(()=>{if(window.__diagBack)return true;window.__diagBack={button:0,page:0,last:null};
  const A=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;
  if(A)A.addListener("backButton",()=>{window.__diagBack.button++;window.__diagBack.last=Date.now()});
  document.addEventListener("backbutton",()=>{window.__diagBack.page++});return true})()`;
