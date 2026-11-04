// Builds the testing report from every results/*.json file the test jobs produced.
// Each check is PASS, FAIL, NOT TESTED or PARTIALLY TESTED. A check only counts as PASS if it actually ran and passed:
// anything planned but not built yet, or whose job didn't run, is listed as NOT TESTED.
import fs from "node:fs";
// write each line straight out, so nothing is lost when the script ends right after a long list
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import path from "node:path";

const dir = process.argv[2] || "results";
const rows = [];
if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir, { recursive: true })) if (String(f).endsWith(".json")) {
  // remember which job's results folder each row came from (results-<job>/...), to tell a crash from a recorded failure
  const from = String(f).split(/[\\/]/)[0];
  try { rows.push(...JSON.parse(fs.readFileSync(path.join(dir, String(f)), "utf8")).map((r) => ({ ...r, _from: from }))); } catch (e) { rows.push({ area: "Report", name: "could not read " + f, status: "FAIL", _from: from }); }
}
// every area the system is meant to cover; an area with no results is NOT TESTED
const AREAS = ["Unit tests", "Build", "Test Scan service", "Android emulator", "User journeys", "Unusual behaviour", "Deals: app vs database",
  "Dependencies", "Phone app build", "Security", "Monitoring", "Accessibility", "Performance", "Device conditions", "Reliability", "Backup and restore", "Release build", "Compatibility: Android 11", "Compatibility: Android 15"];
// a job that failed before it could record any results is a FAIL, never "not tested"
let jobs = {}; try { jobs = JSON.parse(process.env.JOB_RESULTS || "{}"); } catch (e) {}
// any job that didn't succeed is a FAIL in the report, even if it recorded some passing rows before it broke (a crash part-way
// must never look like a pass). "skipped" only counts as NOT TESTED when it was skipped on purpose (e.g. a trial switched off).
const FOLDER = { "Unit tests": "results-unit", "Dependencies": "results-supply", "Build": "results-build", "Test Scan service": "results-service",
  "Android emulator": "results-android", "Capacitor 8 trial": "results-cap8-build", "Other Android versions": "results-compat", "Phone test build": "results-phone-build", "Emulator test app build": "-" };
for (const [a, res] of Object.entries(jobs)) if (res !== "success") {
  const f = FOLDER[a] || "", recorded = rows.some((r) => f && String(r._from || "").startsWith(f) && r.status === "FAIL");
  if (res === "failure" && recorded) continue; // its own FAIL rows already say what failed (no double counting)
  const onPurpose = res === "skipped" && /trial/i.test(a);
  rows.push({ area: a, name: res === "skipped" ? "the job didn't run" : "the job didn't finish successfully", status: onPurpose ? "NOT TESTED" : "FAIL", detail: "job result: " + res + (res === "skipped" && !onPurpose ? " (a job it depends on failed)" : "") }); }
for (const a of AREAS) if (!rows.some((r) => r.area === a)) rows.push({ area: a, name: "(not set up yet, or its job didn't run)", status: "NOT TESTED" });

for (const r of rows) if (/trial/i.test(r.area) && r.status === "FAIL") { r.status = "PARTIALLY TESTED"; r.detail = "TRIAL ONLY (not your app yet): " + (r.detail || ""); }
const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", "NOT TESTED": "⬜ NOT TESTED", "PARTIALLY TESTED": "🟨 PARTIALLY TESTED" };
const count = (s) => rows.filter((r) => r.status === s).length;
let md = `# FlipScout testing report\n\n`;
md += `Branch **${process.env.GITHUB_REF_NAME || "?"}**, version ${String(process.env.GITHUB_SHA || "").slice(0, 7)}, run ${process.env.GITHUB_RUN_NUMBER || "?"}\n\n`;
md += `**${count("PASS")} passed · ${count("FAIL")} failed · ${count("PARTIALLY TESTED")} partly tested · ${count("NOT TESTED")} not tested**\n\n`;
md += `| Area | Check | Result | Details |\n|---|---|---|---|\n`;
for (const a of [...new Set([...AREAS, ...rows.map((r) => r.area)])]) for (const r of rows.filter((x) => x.area === a))
  md += `| ${a} | ${String(r.name).replace(/\|/g, "/")} | ${icon[r.status] || r.status} | ${String(r.detail || "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 200)} |\n`;
fs.writeFileSync("test-report.md", md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
// one short line per area, readable from the run's page without downloading anything
for (const a of [...new Set(rows.map((r) => r.area))]) {
  const rs = rows.filter((r) => r.area === a), st = rs.map((r) => r.status);
  const s = st.includes("FAIL") ? "FAIL" : st.every((x) => x === "PASS") ? "PASS" : st.every((x) => x === "NOT TESTED") ? "NOT TESTED" : "PARTIALLY TESTED";
  console.log(`::notice title=${a}: ${s}::${rs.filter((r) => r.status === "PASS").length}/${rs.length} passed${rs.filter((r) => r.status === "FAIL").map((r) => " | FAIL: " + r.name).join("").slice(0, 400)}`);
}
process.exit(count("FAIL") ? 1 : 0);
