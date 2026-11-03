// A fake eBay (and fake Google push service) for the private test Scan service.
// The test copy of worker.js has every eBay/Google address pointed here, so tests never reach the real eBay,
// never use the real eBay call allowance and never send a phone alert. Every request is logged to fake-ebay.log.
// Run: node tests/e2e/fake-ebay.mjs   (listens on 127.0.0.1:8788)
import http from "node:http";
import fs from "node:fs";

const LOG = process.env.FAKE_EBAY_LOG || "fake-ebay.log";
const PORT = +(process.env.FAKE_EBAY_PORT || 8788);
// items the tests can add later (by id) through POST /__fake/items
const items = new Map();
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    const u = new URL(req.url, "http://x");
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: req.method, path: u.pathname, query: u.search }) + "\n");
    if (u.pathname === "/__fake/items" && req.method === "POST") { for (const it of JSON.parse(body || "[]")) items.set(String(it.legacyItemId || it.itemId), it); return send(res, 200, { ok: true, n: items.size }); }
    if (u.pathname.includes("/oauth2/token") || u.pathname.includes("/identity/v1/oauth2")) return send(res, 200, { access_token: "fake-token", expires_in: 7200, token_type: "Bearer" });
    if (u.pathname.includes("/buy/browse/v1/item_summary/search")) return send(res, 200, { total: 0, itemSummaries: [] });
    if (u.pathname.includes("/buy/browse/v1/item/")) {
      const id = (u.pathname.match(/v1\|(\d+)\|/) || u.pathname.match(/(\d{6,})/) || [])[1];
      if (id && items.has(id)) return send(res, 200, items.get(id));
      return send(res, 404, { errors: [{ errorId: 11001, message: "not found (fake eBay)" }] });
    }
    if (u.pathname.includes("/commerce/taxonomy")) return send(res, 200, { categorySuggestions: [], rootCategoryNode: { childCategoryTreeNodes: [] } });
    if (u.pathname.includes("/ws/api.dll")) { res.writeHead(200, { "content-type": "text/xml" }); return res.end("<GetItemResponse><Ack>Failure</Ack></GetItemResponse>"); }
    if (u.pathname.includes("fcm") || u.pathname.includes("/token")) return send(res, 200, { access_token: "fake", name: "fake-message" });
    send(res, 404, { error: "fake eBay: unknown path" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake eBay listening on ${PORT}`));
