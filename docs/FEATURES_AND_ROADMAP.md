# Fliptimize — feature register and roadmap

Version 1.0 · prepared 12 Nov 2026 on branch `docs/knowledge-system-v1` · NOT yet reviewed by ChatGPT or approved by the owner.
Evidence labels: see [AI_HANDOVER.md](../AI_HANDOVER.md#evidence-labels). Listing a feature here is **not** approval to build it.

**Status words**
- **Released** — in `main` and the live app/Scan service.
- **Built, not released** — exists on a branch or testing build only.
- **Active priority** — owner-confirmed direction (12 Nov 2026); design and build still need separate approval.
- **Planned** — on the roadmap; needs design and approval.
- **Deferred** — kept for later; not on the active roadmap.
- **Rejected** — decided against; do not reintroduce without the owner.

## 1. Deal discovery and valuation (core)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| 24/7 hunting in chosen eBay UK categories (Browse API), deal list and deal pages | Released | `VERIFIED` main 1620653 | Popular categories offered on first run |
| Sell-price estimate from sold evidence ("From N sales", range, trend), careful price (40th percentile) | Released | `VERIFIED` code; method `DEV-REPORTED` (HANDOFF 24 Oct) | Licensing risk: VISION.md §6 |
| "Fill prices" (admin): phone reads eBay sold pages the user opens; category price fills | Released (admin only) | `VERIFIED` code | Owner: "delete before public release" vs keep manual tools — conflict C3 |
| Learning sale prices from ended auctions (automatic) | Released | `VERIFIED` (worker header) | Recorded plan: switch off before going public (VISION §6) |
| Model matching rules per category; "not verified yet" categories capped and never alerted | Released | `VERIFIED` (`VERIFIED_CATS` in worker) | Accuracy measured per category in Oct; re-measure before trusting new categories |
| Condition handling, risk words, scam signs, collection-only detection, description fault check | Released | `VERIFIED` code | Reported vs inferred faults must stay distinct (rule R4) |
| Spares/repairs deal type (seller's words only, user enters repair cost) | Released | `VERIFIED` code | Rule R4/R5 |
| Score (secondary "Score N · Strong/Fair/Weak") with evidence summary, no separate confidence meter | Released | `VERIFIED` (Release A) | Fliptimize decision D3 |
| Re-judging every live deal each scan; 3,000-deal ceiling | Released (Release B) | `VERIFIED` main; live effect `DEV-REPORTED` (758 → 44 deals) | |
| Server-side filtering, pagination, incremental updates, no arbitrary deal limit | Planned | `OWNER-REPORTED` preference, Nov 2026 | Design in project development plan §2; not to be built yet |
| Prediction Lab (owner-only validation of auction predictions against outcomes) | Built, not released | `VERIFIED` branch `feature/prediction-lab` @ 812dae5; not in main | Built on older testing code; needs update before any merge. Decision needed (DECISIONS.md) |
| Sell-through / "how fast it sells" ranges (≥10 sales, ≥3 days) | Released | `DEV-REPORTED` (consolidation review) | Never shown as a guessed number (R7) |

## 2. Money, inventory and financial tracking

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Profit, fees (Private/Business), buyer-protection fee, postage and packaging, max pay / max bid, totals on every money figure | Released | `VERIFIED` code + finance tests | Rules R1–R3 |
| Minimum profit, spending limit, "must not lose money if it only sells cheap" rule | Released | `VERIFIED` code | Live values: see conflict C5 |
| Auction profit at your max bid and "if it ended now · not final" | Released | `VERIFIED` (Release A) | |
| Stock / items with bought and sold figures; Money summary (cash, profit, budget) | Built but hidden — Sell and Money screens exist in the code but are not in the navigation (tabs: Deals, Following, Settings); item data is stored and backed up | `VERIFIED` main code; hiding `OWNER-REPORTED` 25 Oct | Owner hid the half-built tabs until deal-finding is proven (conflict C8) |
| Inventory and financial tracking (full) | Active priority | `OWNER-REPORTED` 12 Nov | Design needed; reuse the existing stock data |
| Potential, secured and realised profit | Active priority | `OWNER-REPORTED` 12 Nov | Definitions only in ChatGPT records → missing |
| Budgeting / spending tracking | Active priority | `OWNER-REPORTED` 12 Nov | |
| Profit by category, tax-year report, slow-stock nudges | Planned (Stage 3 polish) | `OWNER-REPORTED` Oct 2026 | |

## 3. Alerts, engagement and insights

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Push deal alerts (Firebase), test alert, quiet hours | Released | `VERIFIED` code; delivery `OWNER-REPORTED` (2.0.132, 2.0.133 phone checks) | |
| Following listings with a max price, alerts | Released | `VERIFIED` code | |
| Act now strip, NEW badges, ending-later auctions | Released | `VERIFIED` code | |
| Daily opportunity dashboard | Active priority | `OWNER-REPORTED` 12 Nov | Not designed |
| Personalised market insights; business analytics and decision support | Active priority | `OWNER-REPORTED` 12 Nov | Earlier ideas: best time to buy, sell-side timing (HANDOFF 24 Oct) |
| Reseller Academy, courses, challenges, achievements, badges, streaks, points | **Deferred** | `OWNER-REPORTED` 12 Nov | Kept; revisit only with evidence of user/commercial value |
| Practical repair and selling guides | Deferred (possible future) | `OWNER-REPORTED` 12 Nov | Must follow R4/R5 |

## 4. Business model (all need design and approval)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| UK automated deal discovery for subscribers | Active priority | `OWNER-REPORTED` 12 Nov | Needs multi-user service and data licensing first |
| Multiple paid subscription tiers; free and possible one-time purchase | Planned | `OWNER-REPORTED` 12 Nov; Oct note: Google Play billing, about £5–£10/month, free trial | **Tier details missing** (ChatGPT records) |
| Fair round-robin allocation; matching by budget, category and preferences; priority access; unclaimed-deal redistribution; limited recipients per deal | Planned | `OWNER-REPORTED` 12 Nov; data model sketch in project development plan §2 ("cap how many subscribers get each bargain") | **Rules missing** (ChatGPT records) |
| Subscription value targets (not guarantees) and economics | Planned | `OWNER-REPORTED` 12 Nov | Must never promise earnings |
| Worldwide reseller toolkit; more marketplaces and countries | Planned (future) | `OWNER-REPORTED` 12 Nov | Earlier: app is eBay-only (25 Oct) — see conflict C6 |
| Multi-user accounts, hosted sign-in, per-user data | Planned (launch blocker) | `DEV-REPORTED` | Not built |
| Selling: connect eBay, list items, live listings (Stage 2) | Planned (parked) | `OWNER-REPORTED` 23 Oct "not yet" | |

## 5. Future features

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Optional risky-condition listings (user opt-in) | Planned (future) | `OWNER-REPORTED` 12 Nov | Spares type exists; rule R4 |
| Repair & Flip; replacement-part costs and compatibility | Planned (future) | `OWNER-REPORTED` 12 Nov | Compatibility only with evidence (R5); details missing |
| Vinted or other sources | Idea | `DEV-REPORTED` (HANDOFF 24 Oct) | |

## 6. Engineering

| Item | Status | Evidence | Notes |
|---|---|---|---|
| Release build, same signing key, Android backup off | Released | `VERIFIED` build.yml on main | Decisions D1, D2 (4 Nov) |
| Capacitor 6 → 8; wrangler 3 → 4 | Released | `VERIFIED` main | D3b, D3 |
| Scan lease, time limits, eBay rate-limit protection, D1 query fix, Problems list | Released (Release B) | `VERIFIED` main; deploy `DEV-REPORTED` (ec61ce36, 11 Nov) | |
| "Back up now" feedback | Built, not released (2.0.133 testing) | `VERIFIED` testing; phone `OWNER-REPORTED` 7/7 | Not merged into main |
| Backup V2 and disaster recovery | Planned | content `UNVERIFIED` (missing) | Requirements in RECOVERY.md |
| Separate test and live Scan services | Partly built | `DEV-REPORTED` (phone test service, test database) | |
| Signing guard (key usable only by locked workflows) | Released | `VERIFIED` tests/ci/signing_guard.py | |
| Branch protection on main | Not available | `DEV-REPORTED` | Needs paid GitHub plan (D7, optional) |
| Remove the temporary live-data review job before launch | Planned | `VERIFIED` review.yml still on main | |
| Intermittent emulator Back-button failure | **Open defect** | `VERIFIED` test runs; phone passed `OWNER-REPORTED` | Do not mark fixed |
| Light mode visual improvement | Planned | `OWNER-REPORTED` 12 Nov | Not an immediate redesign |

## 7. Rejected (do not reintroduce without the owner)

| Idea | Why | Source |
|---|---|---|
| ntfy (third-party alert app) | Unprofessional; users must not install other apps | Owner, Oct 2026 |
| Evasive scraping: spoofing, random delays/pages to look human, proxies, captcha solving | Breaks eBay's terms; dishonest | Owner + Claude, 23–26 Oct |
| Terapeak scraper with a burner account; server-side 24/7 scraping | Same | HANDOFF 24 Oct |
| Desktop browser identity for eBay pages | eBay rejected sign-in; looks like evasion | HANDOFF 24 Oct |
| Automatic daily price fill | Kept getting stuck; saved no time | Owner, 25 Oct |
| Manual copy-paste diagnostics | Owner doesn't want to paste page dumps | HANDOFF 24 Oct |
| Separate Prices tab | App is for eBay deals only | Owner, 25 Oct |
| Third-party sold-data scrapers | Scrape eBay against its terms | soldprices research, 29 Oct |
| Auto-buy | eBay API restricts it | HANDOFF 24 Oct |
| Geometric fox as final logo | Not the intended mark | Owner, 7–8 Nov |
| Firebase Crashlytics | "Not now": own crash capture is free and works | Decision D6, 4 Nov (deferred) |

## 8. Proposed roadmap order — `PROPOSED`, needs owner approval

1. **Now:** review and approve this documentation set (owner + ChatGPT); decide whether to release 2.0.133 to main.
2. **Foundations:** verify backups and a test restore (RECOVERY.md); resolve data-licensing questions (research and advice);
   bring the sold-price research code into the repository if the owner supplies it.
3. **Core value:** inventory and financial tracking with potential/secured/realised profit; daily opportunity dashboard;
   Prediction Lab (update to current code) to measure accuracy before claiming it; Light mode improvement.
4. **Commercial platform:** multi-user accounts; server-side pagination; subscription tiers; fair allocation.
5. **Later:** insights and analytics, Repair & Flip, more marketplaces and countries.
