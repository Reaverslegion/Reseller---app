// Runs the app's own self-test (Menu › Admin › Self-test) in a headless browser and prints the PASS / FAIL / NOT TESTED report.
// Fill runs are simulated with a fake browser: nothing is sent to eBay. Needs Playwright. Run: node tests/selftest.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { console.log("NOT TESTED  app self-test (Playwright isn't installed on this computer)"); process.exit(0); }
const file = fileURLToPath(new URL("../index.html", import.meta.url));
const b = await chromium.launch(), pg = await b.newPage();
const errs = []; pg.on("pageerror", e => errs.push(String(e)));
// block every network request: the self-test must work without the internet or eBay
await pg.route("**/*", r => r.request().url().startsWith("file:") ? r.continue() : r.abort());
await pg.goto("file://" + file); await pg.waitForTimeout(800);
const res = await pg.evaluate(() => afSelfTest());
console.log(await pg.evaluate(r => stReport(r), res));
if (errs.length) console.log("Page errors:\n  " + errs.join("\n  "));
await b.close();
const fail = res.filter(x => x.status === "FAIL").length;
process.exit(fail || errs.length ? 1 : 0);
