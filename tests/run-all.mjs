// Runs every test file. Used before every build and every Scan service update: if anything fails, nothing is uploaded.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const dir = new URL(".", import.meta.url).pathname, files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
let bad = 0;
for (const f of files) { const r = spawnSync(process.execPath, [dir + f], { encoding: "utf8" }); process.stdout.write(`\n== ${f}: ${r.status === 0 ? "PASS" : "FAIL"}\n${r.stdout}${r.stderr}`); if (r.status !== 0) bad++; }
console.log(bad ? `\n${bad} of ${files.length} test files FAILED` : `\nAll ${files.length} test files passed`);
process.exit(bad ? 1 : 0);
