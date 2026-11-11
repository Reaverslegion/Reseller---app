// Writes seed.sql: invented test deals (and their invented price history) for the PHONE-TEST Scan service's own
// throwaway database. Nothing here comes from your real data. Run: node tests/phone/make-seed-sql.mjs 1500 > seed.sql
import { makeDeals, seedSql } from "../android/seed.mjs";
const n = +(process.argv[2] || 1500);
const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const out = [];
for (const [q, args = []] of seedSql(makeDeals(n, 450000000000), { days: 30 })) { let i = 0; out.push(q.replace(/\?/g, () => lit(args[i++])) + ";"); }
// settings: a few categories, alerts off, no automatic scans (the test service has no eBay keys)
const kv = { config: { cats: [{ id: "27386", name: "Graphics Cards" }, { id: "9355", name: "Mobile & Smart Phones" }], alerts: false, paused: true, interval: 0,
  rules: { seller: "private", minProfit: 20, minRoi: 0, post: 5, pack: 1, bpf: true } }, keyver: 3, fix1: true };
for (const [k, v] of Object.entries(kv)) out.push(`INSERT OR REPLACE INTO kv (k,v) VALUES (${lit(k)},${lit(JSON.stringify(v))});`);
console.log(out.join("\n"));
