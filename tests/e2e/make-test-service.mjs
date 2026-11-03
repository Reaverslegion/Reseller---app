// Builds a PRIVATE TEST copy of the Scan service in .test-service/, to run with Cloudflare's local simulator
// ("wrangler dev --local"). It is completely separate from the live service:
//   - its database and backup store are local files on the test machine, thrown away after the run
//   - every eBay / Google address is pointed at the fake eBay (tests/e2e/fake-ebay.mjs)
//   - no schedule (no automatic hunting), no Cloudflare login, no real keys
// It refuses to run if a Cloudflare key is present, so it can never be pointed at the real account by mistake.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const out = path.join(root, ".test-service");
const FAKE = process.env.FAKE_EBAY_URL || "http://127.0.0.1:8788";
if (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN) { console.error("REFUSED: a Cloudflare key is present. The test service must run with no access to the real account."); process.exit(1); }
const key = process.env.TEST_APP_KEY;
if (!key || key.length < 16) { console.error("TEST_APP_KEY (a random throwaway key) is needed"); process.exit(1); }

let src = fs.readFileSync(path.join(root, "worker.js"), "utf8");
const hosts = ["https://api.ebay.com", "https://auth.ebay.com", "https://fcm.googleapis.com", "https://oauth2.googleapis.com", "https://www.googleapis.com"];
for (const h of hosts) src = src.split(h).join(FAKE + "/" + h.slice(8));
// safety check: nothing in the test copy may still point at a real outside service (www.ebay.co.uk is only used for links shown to you)
const left = [...src.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]).filter((h) => h !== "https://www.ebay.co.uk");
if (left.length) { console.error("REFUSED: test copy still calls real services: " + [...new Set(left)].join(", ")); process.exit(1); }

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "worker.js"), src);
fs.writeFileSync(path.join(out, "wrangler.toml"), `name = "flipscout-test-local-only"
main = "worker.js"
compatibility_date = "2024-09-23"
workers_dev = false

[[kv_namespaces]]
binding = "BACKUP"
id = "local-test-only"

[[d1_databases]]
binding = "DB"
database_name = "flipscout-test-local-only"
database_id = "00000000-0000-0000-0000-000000000000"
`);
fs.writeFileSync(path.join(out, ".dev.vars"), `APP_KEY=${key}\nEBAY_ID=fake-id\nEBAY_SECRET=fake-secret\n`);
console.log("Test service ready in .test-service (local only, fake eBay at " + FAKE + ", no schedule, no real keys)");
