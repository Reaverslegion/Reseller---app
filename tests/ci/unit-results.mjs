// Runs every unit test file and records each one as PASS or FAIL in results/unit.json for the testing report.
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const dir = new URL("..", import.meta.url).pathname;
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
const results = files.map((f) => {
  const r = spawnSync(process.execPath, [dir + f], { encoding: "utf8" });
  process.stdout.write(`\n== ${f}: ${r.status === 0 ? "PASS" : "FAIL"}\n${r.stdout}${r.stderr}`);
  const checks = (r.stdout.match(/^✓/gm) || []).length;
  return { area: "Unit tests", name: f, status: r.status === 0 ? "PASS" : "FAIL", detail: r.status === 0 ? (checks ? checks + " checks" : "") : (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") };
});
if (!files.length) results.push({ area: "Unit tests", name: "no test files found", status: "FAIL" });
mkdirSync("results", { recursive: true });
writeFileSync("results/unit.json", JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
