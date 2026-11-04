// Stage 4: reads the settings inside the phone app built by the LIVE build steps (in GitHub, with the test signing
// key) and reports the ones that matter for safety. It changes nothing. Run: node tests/ci/apk-check.mjs path/to/app.apk
import fs from "node:fs";
import { execSync } from "node:child_process";
const apk = process.argv[2], rows = [], AREA = "Phone app build";
const add = (name, status, detail = "") => { rows.push({ area: AREA, name, status, detail: String(detail).slice(0, 400) }); console.log(status.padEnd(17), name, detail ? "— " + detail : ""); };
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "/usr/local/lib/android/sdk";
const bt = fs.readdirSync(`${sdk}/build-tools`).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop(), tool = (t) => `${sdk}/build-tools/${bt}/${t}`;
const run = (c) => execSync(c, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const x = run(`${tool("aapt2")} dump xmltree --file AndroidManifest.xml "${apk}"`), badging = run(`${tool("aapt2")} dump badging "${apk}"`);
const attr = (name) => { const m = x.match(new RegExp(`android:${name}\\([^)]*\\)=\\(type 0x12\\)(0x[0-9a-f]+)`)); return m ? m[1] !== "0x0" : null; };
const debuggable = attr("debuggable"), backup = attr("allowBackup"), clear = attr("usesCleartextTraffic");
const target = +(badging.match(/targetSdkVersion:'(\d+)'/) || [])[1], min = +(badging.match(/sdkVersion:'(\d+)'/) || [])[1];
const perms = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1].replace("android.permission.", ""));
add("the app is built in debug mode (anyone with a USB cable can inspect it, and the Play Store refuses it)", debuggable ? "FAIL" : "PASS",
  debuggable ? "android:debuggable is on: the build workflow uses 'assembleDebug'. Changing this changes the live build, so it needs your approval" : "off");
add("Android's automatic backup of the app's data (which includes your Scan service key) is limited", backup === false ? "PASS" : "FAIL",
  backup === false ? "allowBackup is off" : "allowBackup is on: the key and settings are copied into Android/Google backups. Turning it off changes the live build, so it needs your approval");
add("the app doesn't allow unencrypted (http) web traffic to the internet", clear ? "FAIL" : "PASS", clear ? "usesCleartextTraffic is on" : "not allowed (Android's default)");
add(`Android version targeted (Google Play needs 35 for new apps from 31 Aug 2025)`, target >= 35 ? "PASS" : "PARTIALLY TESTED", `targets Android API ${target}, runs on ${min}+${target < 35 ? ": fine for installing it yourself, but Play would refuse it" : ""}`);
const risky = perms.filter((p) => /READ_|WRITE_|LOCATION|CAMERA|RECORD_AUDIO|CONTACTS|SMS|CALL|ACCOUNTS|QUERY_ALL|INSTALL|SYSTEM_ALERT/.test(p));
add(`permissions asked for: only what the app uses (${perms.length})`, risky.length ? "PARTIALLY TESTED" : "PASS", perms.join(", ") + (risky.length ? ` · worth checking: ${risky.join(", ")}` : ""));
const exported = [...x.matchAll(/E: (activity|receiver|service|provider)[\s\S]*?A: android:name\([^)]*\)="([^"]+)"[\s\S]*?(?=E: (?:activity|receiver|service|provider|application)|$)/g)]
  .filter((m) => /android:exported\([^)]*\)=\(type 0x12\)0xffffffff/.test(m[0])).map((m) => m[2].split(".").pop());
add("parts of the app other apps can open are only the expected ones", exported.every((n) => /MainActivity|FirebaseMessagingService|Receiver$/.test(n)) ? "PASS" : "PARTIALLY TESTED", exported.join(", ") || "none");
let cert = ""; try { cert = run(`${tool("apksigner")} verify --print-certs "${apk}"`); } catch (e) { cert = e.stdout || e.message; }
const dn = (cert.match(/Signer #1 certificate DN: (.+)/) || [])[1] || "unknown";
add("signing (this test build uses a throwaway key; the live build's key and password are checked in the workflow review)", "PARTIALLY TESTED",
  `signed by "${dn}". The live workflow writes the key's password ('android', the standard debug password) into the build file`);
fs.mkdirSync("results", { recursive: true });
const prev = fs.existsSync("results/build.json") ? JSON.parse(fs.readFileSync("results/build.json", "utf8")) : [];
fs.writeFileSync("results/build.json", JSON.stringify([...prev, ...rows], null, 1));
