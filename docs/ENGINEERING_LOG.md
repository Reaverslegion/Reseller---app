# FlipScout engineering record

This is a running record of what has been checked, what was found, what was fixed, and what is still unproven. It is updated as work happens. Plain English first, technical detail after.

---

## 1. What FlipScout is made of (26 Oct 2026)

| Part | What it is | Where |
| --- | --- | --- |
| **App** | One web page (`index.html`, about 230 KB), packaged as an Android app with Capacitor. Test ("debug") build. Saves its settings on the phone. Only talks to the Scan service (and eBay pages for the manual price fill). | GitHub → built by `build.yml` |
| **Scan service** | One Cloudflare Worker (`worker.js`, about 110 KB), on Workers Paid. Wakes every minute; scans at the chosen interval. | Cloudflare → deployed by `deploy-worker.yml` |
| **Database** | Cloudflare D1, `flipscout-db`. | Cloudflare |
| **Backup store** | Cloudflare KV, `flipscout-backup`: app backup plus a weekly price-list export. | Cloudflare |
| **Alerts** | Firebase push notifications. | Firebase |
| **Tests** | `tests/*.test.mjs`, run by `tests/run-all.mjs` before every build and every Scan service update. | GitHub |
| **Review job (temporary)** | `review.yml`: read-only queries on the live database so live deals can be checked. **Remove before launch.** | GitHub |

### Database tables (live counts, 26 Oct)

| Table | Holds | Rows |
| --- | --- | --- |
| `listings` | Every listing seen | 50,412 (35,092 live) |
| `sales` | Finished auctions learned as sales | 6,788 |
| `prices` | One sell-price per model | 665 (249 of them "similar title" groups) |
| `fillsales` | Sold listings read by the manual fill, per model | 8,469 |
| `deals` | Current deals | 60 |
| `follows` | Followed listings | 0 |
| `kv` | Settings, reports, counters | — |

### How a deal is made

1. The Scan service asks eBay's official API for the newest listings in the ticked categories.
2. Each title is matched to a model. Known kinds have their own rules: graphics cards, laptops, phones, consoles, tablets, CPUs, RAM, storage, monitors and fashion. Anything else falls back to a "similar title" group.
3. A sell price comes from the price list (manual fills of eBay sold pages), learned auction results, or asking prices as a last resort (scored lower and labelled).
4. Profit = sell price − eBay selling fee − your postage and packing − (price + postage + buyer fee when the seller is private).
5. The **max pay** is capped by your minimum profit, the "must not lose money at the cheap end" rule and your spending limit.
6. A score out of 100 adds up six checks: evidence, match, seller, margin, competition and demand. Risky words and scam signs hide listings.

---

## 2. Checks done with evidence

| Date | Check | Result |
| --- | --- | --- |
| 26 Oct | Recalculated profit, costs and fees on all 60 live deals independently | ✅ All 60 match exactly |
| 26 Oct | Hand-checked all 60 live deals' product matches | ❌ 11 wrong (see 3). Fixed and locked in by tests |
| 26 Oct | Looked for price groups mixing different products (wide price spread) | ❌ Found "10th gen" and size-only groups. Fixed |
| 25 Oct | Code review: secrets, injection, cross-site scripting, data leaving the phone | ✅ No secrets in code; queries safe; text escaped. See the code-review notes |
| 25 Oct | Money maths unit tests | ✅ |

---

## 3. Problems found and fixed

| Found | Problem | Root cause | Fix | Proof |
| --- | --- | --- | --- | --- |
| 26 Oct | "Samsung Galaxy Tab A 32GB" priced at £169; Wii U at £169; e-reader at £124 | The "similar title" grouping used **any** word with a number, so "32GB" alone became a "model". All 32GB tablets and consoles were priced together | A group now needs a real model code. Sizes, units and generations ("32gb", "144hz", "10th") don't count | `tests/matching.test.mjs` |
| 26 Oct | Laptops with i5-1035G1 (10th gen) and i5-1135G7 (11th gen) both labelled "1th gen" and priced together | 4-digit Intel numbers starting with 1 were read as generation 1 | 10th gen and later read correctly; proper "st/nd/rd/th" | `tests/matching.test.mjs` |
| 26 Oct | "Nintendo Switch Tablet" (no dock or Joy-Cons) priced as a complete Switch | "switch tablet" wasn't recognised as not complete | Added | `tests/matching.test.mjs` |
| 26 Oct | Xbox One S **All Digital** priced as the disc model | No digital variant for Xbox One S | Added | `tests/matching.test.mjs` |
| 26 Oct | "500GB 1TB 2TB 4TB" listing shown as a 1TB deal at the 500GB price | Multi-size listings not detected | Such listings are skipped, in deals and in fills | `tests/matching.test.mjs` |
| 26 Oct | "fully working with small damage" phone shown as a deal | "damage" (without "-d") not a risk word | Added. "No damage" is still fine | `tests/matching.test.mjs` |
| 26 Oct | Loosely matched items with very wide prices could still become deals | Price-list prices claimed a fixed 15% spread | The real spread is used. Loose matches need consistent prices | — |
| 26 Oct | High scores on prices from only 5–6 sales | Evidence score ignored how many sales were behind a price | Evidence weighted by sale count. "Few sales" tag under 10 | — |
| 26 Oct | "Quadro RTX 5000 **Mobile**" laptop chip priced as a desktop card | Not treated as "not a card" | "mobile", "MXM", "GPU chip/module", "BGA" excluded from cards | `tests/filters.test.mjs`, `tests/matching.test.mjs` |
| 26 Oct | "PARTS ONLY" card shown as a deal | Risk words covered "for parts" only | Added parts only, spares only, sold as seen, as is, not tested | `tests/filters.test.mjs` |
| 26 Oct | Changes could be uploaded with failing tests | Tests weren't part of the upload | Every build and Scan service update runs all tests first | `build.yml`, `deploy-worker.yml` |

---

## 4. Still open (highest priority first)

| # | Priority | What | Why it matters | Plan |
| --- | --- | --- | --- | --- |
| 1 | High | **Matching accuracy isn't measured beyond about 15 hand-checked titles** | Wrong matches mean wrong prices, which means bad buys | Build a labelled set of about 300 real titles across categories and report the % right. Make it a test that must stay above the target |
| 2 | High | **No test copy of the system.** Every change goes straight to the live Scan service | A bad change hits real deals and alerts | Separate test Scan service and database |
| 3 | High | **Sold prices come from reading eBay's website** (manual fill), which eBay's rules don't allow | Account risk; can't be offered to other users at launch | Business decision before launch: eBay's official sold-data access (Marketplace Insights) or another lawful source |
| 4 | Medium | Built for one person: one shared password, no accounts | Blocks other users (Stage 2) | Accounts and per-user data in Stage 2 |
| 5 | Medium | App is one 230 KB file | Harder to change safely as it grows | Split into modules when Stage 2 starts |
| 6 | Medium | Debug build, weak signing password | Not allowed on the Play Store; easier to tamper with | Release build and new key before launch |
| 7 | Low | Not priced at all: Wii U, Kindles, monitors (by brand and model) | Missed deals, not wrong deals | Add proper rules after the accuracy set exists |
| 8 | Low | Old wrong rows still in the price list (size-only groups, "1th gen", "10th") | Shown in the price list, but no longer used for deals | Delete them. **Needs owner approval** (changes live data) |
| 9 | Note | Minimum profit is set to £5 | Smaller than the usual uncertainty in a sell price | Owner's business choice. Mentioned |

## 5. Not verified (be honest)

- Anything on a real phone: layouts, notifications, the manual fill reading eBay pages. Checked only from screenshots.
- Whether sell prices match eBay's real sold prices today. That's checked indirectly through sale counts and spread, not against an independent source.
- How the Scan service behaves under eBay errors and timeouts: the code handles them, but they aren't tested end to end yet.
