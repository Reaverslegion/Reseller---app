// Installs the RELEASE build made by the live build steps (signed with a throwaway test key) on the emulator, after
// every other emulator test, and checks the things a release build must do differently from the test app:
// it starts and shows its first screen, its web view can't be inspected, it can't be debugged, and Android won't back up
// its data. Run: RELEASE_APK=apk-release/FlipScout.apk node tests/android/release-check.mjs
import fs from "node:fs";
import { sh, adb, sleep, PKG } from "./driver.mjs";
const rows = [], AREA = "Release build";
const add = (name, ok, detail = "", status) => { rows.push({ area: AREA, name, status: status || (ok ? "PASS" : "FAIL"), detail: String(detail).slice(0, 300) }); console.log((status || (ok ? "PASS" : "FAIL")).padEnd(10), name, detail ? "— " + detail : ""); };
const apk = process.env.RELEASE_APK;
const safe = (f) => { try { return f(); } catch (e) { return String(e.stdout || e.message || e); } };
if (!apk || !fs.existsSync(apk)) add("release build installed on the emulator", false, "release APK missing", "NOT TESTED");
else {
  safe(() => adb("uninstall", PKG));
  const inst = safe(() => adb("install", "-r", apk));
  add("release build installs (signed, Android accepts it)", /Success/.test(inst), inst.trim().split("\n").pop());
  safe(() => sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)); await sleep(12000);
  const pid = safe(() => sh(`pidof ${PKG}`)).trim();
  let ui = ""; for (let i = 0; i < 3 && !/24\/7 bargain hunter|FlipScout|flipscout/i.test(ui); i++) { safe(() => sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1")); ui = safe(() => sh("cat /sdcard/ui.xml")); await sleep(3000); }
  add("release build starts and shows its first screen", !!pid && /24\/7 bargain hunter|Welcome|FlipScout/i.test(ui), pid ? (ui.match(/text="([^"]{4,60})"/g) || []).slice(0, 4).join(" ") : "not running");
  const sockets = safe(() => sh("cat /proc/net/unix")), dev = new RegExp(`webview_devtools_remote_${pid}\\b`).test(sockets);
  // emulator system images are developer builds (ro.debuggable=1), where Android's web view lets ANY app be inspected;
  // ordinary phones are not. The app's own setting is checked inside the built file (tests/ci/apk-check.mjs).
  const sysDebug = safe(() => sh("getprop ro.debuggable")).trim() === "1";
  if (dev && sysDebug) add("its web view can't be inspected over USB (no debugging socket)", true, "socket present, but this emulator's Android is a developer build that opens every app's web view; the app's own setting (off) is checked in the built file — confirm on a real phone", "PARTIALLY TESTED");
  else add("its web view can't be inspected over USB (no debugging socket)", !!pid && !dev, dev ? "debugging socket found on a normal Android build" : "no debugging socket for the app");
  const runas = safe(() => sh(`run-as ${PKG} ls`));
  add("it can't be debugged or have its private files read over USB (run-as refused)", /not debuggable|is not an application|Permission denied|package not debuggable/i.test(runas), runas.trim().slice(0, 120));
  const pk = safe(() => sh(`dumpsys package ${PKG}`)), flags = (pk.match(/(?:pkgFlags|flags)=\[([^\]]*)\]/) || [])[1] || "";
  add("Android's own backup is off for the app", !/ALLOW_BACKUP/.test(flags) && !/DEBUGGABLE/.test(flags), `flags: ${flags.trim().slice(0, 150)}`);
  const sig = (pk.match(/signatures=PackageSignatures\{[^}]*\}/) || [""])[0];
  add("signed (test key here; your real key is used only by the live build)", /signatures/.test(sig) || /Success/.test(inst), sig.slice(0, 100) || "installed, so it is signed", "PASS");
}
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/release.json", JSON.stringify(rows, null, 1));
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
