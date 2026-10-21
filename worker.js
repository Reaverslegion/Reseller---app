// FlipScout search worker: app -> this worker -> eBay Browse API (eBay UK)
// Secrets needed in Cloudflare: APP_KEY, EBAY_ID, EBAY_SECRET
// Search: ?key=...&q=search words&max=100&region=uk|any&cat=categoryId
// Category ideas: ?key=...&suggest=search words
// Full eBay UK category list: ?key=...&tree=1
let TOKEN = null, TOKEN_EXP = 0;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function getToken(env) {
  if (TOKEN && Date.now() < TOKEN_EXP) return TOKEN;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(env.EBAY_ID + ":" + env.EBAY_SECRET),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("eBay login failed (" + res.status + ")");
  const d = await res.json();
  TOKEN = d.access_token;
  TOKEN_EXP = Date.now() + (d.expires_in - 120) * 1000;
  return TOKEN;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
    if (!env.APP_KEY || u.searchParams.get("key") !== env.APP_KEY) return json({ error: "wrong key" }, 401);
    if (u.searchParams.get("tree")) {
      try {
        const token = await getToken(env);
        const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/3", {
          headers: { Authorization: "Bearer " + token, "Accept-Encoding": "gzip" },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!r.ok) return json({ error: "category list failed (" + r.status + ")" }, 502);
        return new Response(r.body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", ...CORS } });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    const sug = (u.searchParams.get("suggest") || "").trim();
    if (sug) {
      try {
        const token = await getToken(env);
        const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/3/get_category_suggestions?q=" + encodeURIComponent(sug), {
          headers: { Authorization: "Bearer " + token },
        });
        if (!r.ok) return json({ error: "category lookup failed (" + r.status + ")" }, 502);
        const d = await r.json();
        const cats = (d.categorySuggestions || []).slice(0, 8).map((c) => ({
          id: c.category.categoryId,
          name: c.category.categoryName,
          path: (c.categoryTreeNodeAncestors || []).map((a) => a.categoryName).reverse().concat(c.category.categoryName).join(" › "),
        }));
        return json({ cats });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    const q = (u.searchParams.get("q") || "").trim();
    if (!q) return json({ error: "no search words" }, 400);
    const max = Math.max(1, parseFloat(u.searchParams.get("max")) || 50);
    const region = u.searchParams.get("region") === "any" ? "any" : "uk";
    const cat = (u.searchParams.get("cat") || "").replace(/[^0-9]/g, "");

    try {
      const token = await getToken(env);
      const filters = [
        `price:[..${max}]`,
        "priceCurrency:GBP",
        "buyingOptions:{FIXED_PRICE|AUCTION}",
        "deliveryCountry:GB",
      ];
      if (region === "uk") filters.push("itemLocationCountry:GB");
      const api =
        "https://api.ebay.com/buy/browse/v1/item_summary/search?limit=100&q=" +
        encodeURIComponent(q) + (cat ? "&category_ids=" + cat : "") + "&filter=" + encodeURIComponent(filters.join(","));
      const res = await fetch(api, {
        headers: {
          Authorization: "Bearer " + token,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
          "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=GB",
        },
      });
      if (!res.ok) return json({ error: "eBay search failed (" + res.status + ")" }, 502);
      const d = await res.json();
      const items = (d.itemSummaries || []).map((it) => {
        const auction = (it.buyingOptions || []).includes("AUCTION") && !(it.buyingOptions || []).includes("FIXED_PRICE");
        const pr = auction && it.currentBidPrice ? it.currentBidPrice : it.price;
        const so = (it.shippingOptions || [])[0];
        const id = it.legacyItemId || (it.itemId || "").split("|")[1];
        return {
          title: it.title || "",
          price: pr ? parseFloat(pr.value) : 0,
          ship: so && so.shippingCost ? parseFloat(so.shippingCost.value) : 0,
          cond: it.condition || "",
          auction,
          end: it.itemEndDate || null,
          loc: (it.itemLocation && it.itemLocation.country) || "",
          url: id ? "https://www.ebay.co.uk/itm/" + id : it.itemWebUrl,
        };
      });
      return json({ items });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
