# Fliptimize — feature register and roadmap

Version 1.2 · 12 Nov 2026 · branch `docs/knowledge-system-v1` · v1.0 reviewed by ChatGPT; v1.1–v1.2 corrections pending
final review and owner approval. **Read [VISION.md §0](VISION.md#0-confirmed-long-term-vision-owner-12-nov-2026--read-this-first)
first:** the eBay engine is the foundation; the nine categories are a test selection, not a limit. Listing a feature here is **not** approval to build it.

**Owner clarification (12 Nov 2026):** work so far has deliberately concentrated on the deal-finding engine, valuation
calculations, reliability and supporting infrastructure. The subscription business and most future features have **not**
been designed in detail — this is intentional. Nothing below is a specification, price, algorithm, projection or
commitment.

## Status words (implementation / approval status)
Kept separate from the evidence labels (`VERIFIED`, `OWNER-REPORTED`, `DEV-REPORTED` …, see
[AI_HANDOVER.md](../AI_HANDOVER.md#evidence-labels)). Priority is a third, separate thing (§8).

| Status | Meaning |
|---|---|
| **RELEASED** | Implemented and released, with evidence of the code and its deployment/release build |
| **BUILT, NOT RELEASED** | Implemented on a branch, or hidden in the app, but not released to users |
| **APPROVED FOR DEVELOPMENT** | The owner explicitly approved implementation; work not complete |
| **AGREED PRODUCT DIRECTION** | The owner wants this capability or direction; detailed design and implementation not approved |
| **FUTURE CONCEPT** | Discussed as a possibility; no final specification or development approval |
| **DEFERRED** | Considered and deliberately postponed |
| **REJECTED** | Explicitly decided against |
| **SUPERSEDED** | Replaced by a later decision |
| **UNVERIFIED / DISPUTED** | Evidence missing or contradictory |

At the time of writing **no item is APPROVED FOR DEVELOPMENT** — every open item needs separate owner approval.

## 1. Deal discovery and valuation (core engine — current focus)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| 24/7 hunting in chosen eBay UK categories (Browse API); deal list and deal pages | RELEASED | `VERIFIED` main 1620653 | Current buying source: eBay UK. The engine is the platform's foundation, not a temporary system |
| Nine initial **test** categories ("Start with popular categories"); users may also choose other categories | RELEASED | `VERIFIED` `STARTER` list in index.html | Chosen for popular, fast-selling test products — **not permanent product or architectural limits** |
| Category verification safeguard (only hand-verified categories score high or alert; others capped, never alerted) | RELEASED | `VERIFIED` `VERIFIED_CATS` (12 entries, 26 Oct) | Stays until an expansion is separately designed, tested and approved |
| Historical eBay sold-price coverage for essentially every category with reliable comparable sales | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov (v1.2) | Long-term objective; broad coverage does not exist today. **Mass category expansion not approved** |
| Eligibility rule: recommend only with sufficient trustworthy comparable sales (multiple sales, correct product/version/condition, evidence-based selling speed); otherwise no invented price, confidence or profit | AGREED PRODUCT DIRECTION (principle); partly RELEASED today (evidence thresholds, "not verified yet" caps) | `OWNER-REPORTED` 12 Nov; `VERIFIED` code | No numerical thresholds or accuracy targets set in this documentation. Changes to valuation algorithms/thresholds not approved |
| Multiple buying sources (e.g. Facebook Marketplace, Amazon, online retailers, clearance/discount offers) valued against the eBay sold-price database; new and used items | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov (v1.2) | **No integration approved.** Each source needs separate research (feasibility, terms, licensing, reliability, cost); no API or automated access assumed |
| Keeping unmatched listings for future research | UNVERIFIED / undecided | `OWNER-REPORTED` 12 Nov | Separate technical decision, subject to costs and data rights |
| Sell-price estimate from sold evidence ("From N sales", range, trend), careful price | RELEASED | `VERIFIED` code; method `DEV-REPORTED` | Licensing risk: VISION.md §6 |
| "Fill prices" (owner-only admin): phone reads eBay sold pages the user opens; category fills | RELEASED (admin only) | `VERIFIED` code | Admin vs customer separation unresolved (DECISIONS C3) |
| Learning sale prices from ended auctions (automatic) | RELEASED | `VERIFIED` worker header | Recorded plan: switch off before going public (VISION §6) |
| Model matching rules; "not verified yet" categories capped and never alerted | RELEASED | `VERIFIED` (`VERIFIED_CATS`) | Re-measure accuracy before trusting new categories |
| Condition handling, risk words, scam signs, collection-only detection, description fault check | RELEASED | `VERIFIED` code | Seller-reported condition vs app risk warnings must stay distinct (VISION R4) |
| Spares/repairs deal type (seller's words only; user enters repair cost) | RELEASED | `VERIFIED` code | VISION R4 |
| Secondary score with evidence summary (no separate confidence meter) | RELEASED | `VERIFIED` (Release A) | Fliptimize decision D3 |
| Re-judging every live deal each scan; 3,000-deal ceiling | RELEASED (Release B) | `VERIFIED` main; live effect `DEV-REPORTED` (758 → 44 deals) | |
| Sell-through ranges (only with ≥10 sales over ≥3 days) | RELEASED | `DEV-REPORTED` | Never a guessed number (VISION R7) |
| Server-side filtering, pagination, incremental updates, no arbitrary deal limit | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` Nov 2026 ("not to be built yet") | Draft design in a Claude project note (development plan §2) |
| Prediction Lab (owner-only validation of auction predictions against outcomes) | BUILT, NOT RELEASED | `VERIFIED` branch `feature/prediction-lab` @ 812dae5 | Built on older code; future unresolved (DECISIONS C7) |

## 2. Money, inventory and financial tracking

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Profit, fees (Private/Business), buyer-protection fee, postage and packaging, max pay / max bid, totals on every money figure | RELEASED | `VERIFIED` code + finance tests | VISION R1–R3 |
| User-adjustable minimum profit, spending limit, "must not lose money if it only sells cheap" | RELEASED | `VERIFIED` code | Values are the user's own settings and change over time (e.g. £1 for testing, later £50 and £200) — not product decisions |
| Auction profit at your max bid and "if it ended now · not final" | RELEASED | `VERIFIED` (Release A) | |
| Stock/items with bought and sold figures; Money summary | BUILT, NOT RELEASED (hidden) | `VERIFIED` code: screens exist but are not in the navigation (Deals, Following, Settings); hiding `OWNER-REPORTED` 25 Oct | Existing code — not the intended future experience (DECISIONS C8) |
| Inventory and financial tracking (full experience) | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | Not designed |
| Potential, secured and realised profit tracking and dashboards | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | Definitions not yet written |
| Budgeting / spending tracking | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | |
| Profit by category, tax-year report, slow-stock nudges | FUTURE CONCEPT | `OWNER-REPORTED` Oct (Stage 3 ideas) | |

## 3. Alerts, engagement and insights

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Push deal alerts (Firebase), test alert, quiet hours | RELEASED | `VERIFIED` code; delivery `OWNER-REPORTED` (2.0.132, 2.0.133) | |
| Following listings with a max price | RELEASED | `VERIFIED` code | |
| Act now strip, NEW badges, ending-later auctions | RELEASED | `VERIFIED` code | |
| Daily opportunity dashboard | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | Not designed |
| Personalised market insights; business analytics and decision support | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | Earlier ideas: best time to buy, sell-side timing |
| Reseller Academy, courses, challenges, achievements, badges, points, streaks | DEFERRED | `OWNER-REPORTED` 12 Nov | Kept, not deleted; revisit only with evidence of user or commercial value |
| Practical repair and selling guides | FUTURE CONCEPT | `OWNER-REPORTED` 12 Nov | Must follow VISION R4/R5 |

## 4. Business model — agreed directions and concepts, NOT designs

`OWNER-REPORTED` (owner instructions, 12 Nov 2026). Future business design is a **separate phase**. The allocation system
will need design, simulation and evidence that enough genuine opportunities exist to support the proposed subscription
value. No tier names, prices, guaranteed returns, recipient limits, first-look windows, allocation algorithms, revenue or
subscriber projections or launch dates have been decided.

| Item | Status | Notes |
|---|---|---|
| Commercial professional reseller platform | AGREED PRODUCT DIRECTION | Profits are estimates, never guaranteed |
| Free reseller tools | AGREED PRODUCT DIRECTION | Which tools are free is not decided |
| Multiple paid subscription tiers | AGREED PRODUCT DIRECTION | No names or prices decided |
| Tier-based potential-profit opportunity **targets** | AGREED PRODUCT DIRECTION | Targets, not guarantees; no figures decided |
| Fair round-robin distribution of opportunities | AGREED PRODUCT DIRECTION | No algorithm decided |
| One shared opportunity pool fed by all supported buying sources and categories | AGREED PRODUCT DIRECTION | v1.2 vision |
| Matching by available budget and preferred categories (specialist subscribers or broad, many-category subscribers), practical suitability and opportunities already received | AGREED PRODUCT DIRECTION | No algorithm decided |
| Limited recipients per opportunity to reduce competition | AGREED PRODUCT DIRECTION | No limit decided |
| Redistribution of unclaimed opportunities | AGREED PRODUCT DIRECTION | No timing decided |
| Fairness informed by opportunities already received | AGREED PRODUCT DIRECTION | |
| Potential, secured and realised profit tracking | AGREED PRODUCT DIRECTION | Also §2 |
| Possible priority access for higher tiers | FUTURE CONCEPT | No windows decided |
| Possible one-time purchase option (previously discussed around **£4.99**) | FUTURE CONCEPT | Price **not approved** |
| Possible worldwide standalone toolkit | FUTURE CONCEPT | |
| Earlier note: Google Play subscriptions, "roughly £5–£10/month", free trial (24 Oct) | FUTURE CONCEPT | Previously discussed; **not approved** |
| Multi-user accounts, hosted sign-in, per-user data | FUTURE CONCEPT (launch prerequisite) | Not built |
| Selling: connect eBay, list items, live listings (Stage 2) | DEFERRED | Owner: "not yet" (23 Oct) |

## 5. Future features

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Optional risky-condition opportunities (user opt-in) | FUTURE CONCEPT | `OWNER-REPORTED` 12 Nov | Spares type exists today |
| Repair & Flip: optional, user-requested repair research (parts, prices, guides) with evidence and compatibility checks | FUTURE CONCEPT | `OWNER-REPORTED` 12 Nov | **Not approved to build**; rule clarification awaiting owner (DECISIONS C10) |
| Additional buying sources (other marketplaces and retailers) | AGREED PRODUCT DIRECTION — see §1 | `OWNER-REPORTED` 12 Nov (v1.2) | Moved up from FUTURE CONCEPT by the confirmed vision; still **not approved** for development |
| Other countries / worldwide standalone toolkit | FUTURE CONCEPT | `OWNER-REPORTED` 12 Nov | |
| Improved light theme (hierarchy, contrast, accessibility, long-session comfort) | AGREED PRODUCT DIRECTION | `OWNER-REPORTED` 12 Nov | Later UX feedback on a released, approved theme; not a redesign now |
| Other sources (e.g. second-hand marketplaces) | Covered by "Additional buying sources" above | `DEV-REPORTED` (HANDOFF 24 Oct) | Earlier idea, now part of the v1.2 vision |

## 6. Engineering

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Release build, same signing key, Android backup off | RELEASED | `VERIFIED` build.yml on main | Decisions D1, D2 |
| Capacitor 8.6.0; wrangler 4.157.0 | RELEASED | `VERIFIED` main | D3b, D3 |
| Scan lease, time limits, eBay rate-limit protection, D1 query fix, Problems list | RELEASED (Release B) | `VERIFIED` main; deploy `DEV-REPORTED` | |
| "Back up now" feedback (app 2.0.133) | BUILT, NOT RELEASED | `VERIFIED` testing d7efb7a; phone 7/7 `OWNER-REPORTED` | On the owner's phone; not merged into main |
| Backup V2 and disaster recovery | FUTURE CONCEPT (previously discussed design inputs) | `OWNER-REPORTED` 12 Nov | docs/RECOVERY.md §3 |
| Separate test and live Scan services | Partly built | `DEV-REPORTED` | |
| Signing guard | RELEASED | `VERIFIED` tests/ci/signing_guard.py | |
| Branch protection on main | Not available | `DEV-REPORTED` | Needs a paid GitHub plan (D7, optional) |
| Remove the temporary live-data review job before launch | AGREED PRODUCT DIRECTION | `VERIFIED` review.yml still on main | |
| Sold-price research system (`soldprices`) | BUILT, NOT RELEASED (outside GitHub) | `DEV-REPORTED` (ZIP only) | |
| Intermittent emulator Back-button failure | **Open defect** | `VERIFIED` test runs; phone passed `OWNER-REPORTED` | Do not mark fixed |

## 7. Rejected and superseded (do not reintroduce without the owner)

| Idea | Status | Why | Source |
|---|---|---|---|
| ntfy (third-party alert app) | REJECTED | Users must not install other apps | Owner, Oct 2026 |
| Evasive scraping: spoofing, random delays/pages to look human, proxies, captcha solving | REJECTED | Breaks eBay's terms; dishonest | Owner + Claude, 23–26 Oct |
| Terapeak scraper with a burner account; server-side 24/7 scraping | REJECTED | Same | HANDOFF 24 Oct |
| Desktop browser identity for eBay pages | REJECTED | eBay rejected sign-in; looks like evasion | HANDOFF 24 Oct |
| Automatic daily price fill | REJECTED | Kept getting stuck; saved no time | Owner, 25 Oct |
| Manual copy-paste diagnostics | REJECTED | Owner doesn't want to paste page dumps | HANDOFF 24 Oct |
| Separate Prices tab | REJECTED | App was for eBay deals only (the tab's removal stands; the wider "eBay only" reasoning is SUPERSEDED as to buying sources — see DECISIONS) | Owner, 25 Oct |
| Third-party sold-data scrapers | REJECTED | Scrape eBay against its terms | soldprices research, 29 Oct |
| Auto-buy | REJECTED | eBay API restricts it | HANDOFF 24 Oct |
| Geometric fox as the final logo | REJECTED | Not the intended mark | Owner, 7–8 Nov |
| Firebase Crashlytics | DEFERRED | Own crash capture is free and works | Decision D6, 4 Nov |
| Personal-use-only app | SUPERSEDED | Commercial direction | DECISIONS |

## 8. Suggested order of work — `PROPOSED` (priority only; not approval)

1. Final review of this documentation set; owner decision on merging it.
2. Owner decision on releasing 2.0.133 to main (separate approval).
3. Foundations: research Cloudflare backup/restore options and a test restore (RECOVERY.md); data-licensing research and
   advice; bring the `soldprices` code into the repository if supplied.
4. Engine evidence: Prediction Lab decision; accuracy measurement before any accuracy claims.
5. A separate business-design phase (allocation design and simulation, tier concepts) only after the engine is proven.
