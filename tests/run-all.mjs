// Runs every test file. Used before every build and every Scan service update: if anything fails, nothing is uploaded.
// RELEASE A (11 Nov 2026, app-only release): 9 test files check Scan service changes that are not live yet (they ship
// with Release B). They are kept, not deleted, and run automatically as soon as worker.js contains that Scan service
// (detected by its functions below); until then each is listed as HELD, never as passed.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const dir = new URL(".", import.meta.url).pathname, files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
const HELD = ["deals-list.test.mjs", "fixes-2026-11-04.test.mjs", "fixes-stage3-2026-11-04.test.mjs", "key-in-url.test.mjs", "monitoring.test.mjs",
  "no-hidden-caps.test.mjs", "profit-accuracy.test.mjs", "review-fixes-2026-11-04.test.mjs", "scan-budget.test.mjs"];
const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const releaseB = ["async function xfetch(", "const SCAN_LEASE", "function postageOf(", "function cleanMsg(", "function postOutFor("].every((m) => worker.includes(m));
let bad = 0, held = 0;
for (const f of files) {
  if (!releaseB && HELD.includes(f)) { held++; process.stdout.write(`\n== ${f}: HELD for Release B (checks Scan service changes that are not live yet)\n`); continue; }
  const r = spawnSync(process.execPath, [dir + f], { encoding: "utf8" }); process.stdout.write(`\n== ${f}: ${r.status === 0 ? "PASS" : "FAIL"}\n${r.stdout}${r.stderr}`); if (r.status !== 0) bad++;
}
const ran = files.length - held, note = held ? ` (${held} held for Release B)` : "";
console.log(bad ? `\n${bad} of ${ran} test files FAILED${note}` : `\nAll ${ran} test files passed${note}`);
process.exit(bad ? 1 : 0);
