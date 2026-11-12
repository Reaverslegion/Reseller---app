# Fliptimize — owner decisions

Only record decisions explicitly approved by the owner. Proposals are not approvals.

> **12 Nov 2026 (documentation phase v1.1, branch `docs/knowledge-system-v1`; v1.0 reviewed by ChatGPT; v1.1 corrections
> awaiting final review and owner approval). Status words: see
> [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md#status-words-implementation--approval-status).**
> Original v1.0 note:
> the "Approved" list below is kept exactly as written on 8 Nov. A recovered decision history, superseded decisions and
> open conflicts were added after it. Recovered entries come from Claude's project records and memory of the owner's
> statements; the owner's exact words are quoted only where they were recorded. Evidence labels: see
> [AI_HANDOVER.md](AI_HANDOVER.md#evidence-labels).

## Approved
- 2026-11-08: Read-only safety and recovery audit of connected GitHub repository.
- 2026-11-08: Establish shared Claude/ChatGPT coordination through GitHub.
- 2026-11-08: Create these four coordination documents on `testing` only. No application code or production configuration changes.
- Collaboration model: Claude is initially the main implementer; ChatGPT independently reviews and may undertake separately agreed development tasks. GitHub is the handover medium. Owner retains approval over important changes.
- 2026-11-08: Branch safety: delete `deploy/ebay-ratelimit` and `hotfix/d1-query-main` (done by the owner manually); add the deploy lock to `test/ebay-ratelimit` and `check/live-version` (done by Claude). Owner's words: "I approve the four branch safety changes recommended by you and independently reviewed by ChatGPT."
- 2026-11-08: Release PR #1 to `main` using Option A (`[skip ci]` merge commit, no redeploy). Owner's words: "I explicitly approve releasing Fliptimize Pull Request #1 using Option A, as independently reviewed by ChatGPT." Done: `main` = `465d26b`.

## Recovered decision history (21 Oct – 12 Nov 2026)

Owner-confirmed means the owner stated or approved it (source: Claude's records). "Done" is only marked `VERIFIED` where
the repository shows it.

### Product and business
| Date | Decision | Status | Evidence |
|---|---|---|---|
| 21–22 Oct | App named FlipScout; package ID `com.reaverslegion.flipscout` | Name: interim (see 7 and 12 Nov). Package ID: kept | `VERIFIED` package ID in main |
| 22 Oct | Keep sold-price data as a key feature; get it via phone-side "Check sold prices"/price book; pool prices across users later | Price book RELEASED (admin fill); pooling across users is a FUTURE CONCEPT. Licensing unresolved (VISION §6) | `OWNER-REPORTED`; `VERIFIED` fill code |
| 23 Oct | Build 2.0 in 3 stages (1 bargain alarm, 2 connect eBay + selling, 3 polish/reports); Stage 2 not yet | Stage 1 RELEASED; Stage 2 DEFERRED | `OWNER-REPORTED` |
| Oct | Deals judged on minimum profit (return % optional), sorted by profit | In force | `OWNER-REPORTED`; `VERIFIED` code |
| Oct | Alerts are the app's own (Firebase), never a third-party app (ntfy rejected) | In force | `OWNER-REPORTED`; `VERIFIED` FCM code |
| Oct | Spares/repairs: seller's words and facts only, never suggest fixes | In force (VISION R4) | `OWNER-REPORTED` |
| Oct | Every money figure has a clear final total — "I never want anyone on my app to need to add anything up." | In force (VISION R1) | quote recorded in HANDOFF 24 Oct |
| Oct | Automatic settings keep a manual version in the admin page for a global adjustment | In force — see conflict C3 | `OWNER-REPORTED` |
| 24 Oct | Stay on rented cloud (Cloudflare), no own server; launch checklist kept for later | In force | `OWNER-REPORTED` |
| 25 Oct | Keep Cloudflare Workers Paid ongoing | In force | `OWNER-REPORTED` |
| 25 Oct | Remove the Prices tab (eBay deals only); hide half-built Sell and Money tabs until deal-finding is proven | In force — see C6, C8 | `OWNER-REPORTED`; `VERIFIED` 3 tabs in main |
| 25 Oct | Manual price fill only (automatic daily fill dropped) | In force | `OWNER-REPORTED` |
| 25 Oct | No guessed accuracy figures shown to users | In force (VISION R7) | `OWNER-REPORTED` |
| 29 Oct | "Data first" priority over deal speed | In force (not re-confirmed since) | `OWNER-REPORTED` |
| 29 Oct | Use FlipScout only as a personal data-collection app | **SUPERSEDED** (7 Nov, 12 Nov) | `OWNER-REPORTED` |
| 7 Nov | Goal: polished, trustworthy, commercially credible app worth paying for; keep Private and Business seller modes | In force | `OWNER-REPORTED` |
| 7 Nov | Fliptimize consolidation (D1 logo on hold; D2 "demo layout, FlipScout truth"; D3 evidence summaries, no confidence meter; D4 3 tabs; D5 standard + compact cards; D6 keep package ID; D7 light canvas #F6F6FA with card borders; D8 solid violet buttons; D9 do not code yet; D10 commercial-readiness research only) | D2–D8 released in 2.0.132; D9 superseded by the later redesign build; D1 still open | project doc "Fliptimize consolidation review" |
| 8 Nov | Fox logo is a placeholder only, not approved | In force | `OWNER-REPORTED` |
| 12 Nov | Fliptimize is to become a commercially viable professional reseller platform; use "Fliptimize — Android app currently named FlipScout" until branding is final; never present projected profit as guaranteed | In force | owner instruction 12 Nov |
| 12 Nov | Professional tools first; Reseller Academy, courses, challenges, achievements, badges, streaks and points **deferred** (kept) | In force | owner instruction 12 Nov |
| 12 Nov | **Reuse Before Build** is a permanent engineering principle (docs/OPEN_SOURCE.md) | In force | owner instruction 12 Nov |
| 12 Nov | Light mode "feels washed out and bland": record a future improvement, no redesign now | AGREED PRODUCT DIRECTION (later UX feedback; the released theme's approval stands) | owner instruction 12 Nov |
| 12 Nov | Clarification: work has deliberately concentrated on the deal-finding engine, valuation, reliability and infrastructure; the subscription business and most future features are intentionally not designed yet. Do not invent tier names, prices, guarantees, recipient limits, first-look windows, algorithms, projections or launch dates. Future business design is a separate phase | In force | owner instruction 12 Nov (v1.1) |
| 12 Nov | Business directions recorded at concept level (docs/FEATURES_AND_ROADMAP.md §4). One-time purchase previously discussed around £4.99 — **not approved**; no subscription price approved | Recorded | owner instruction 12 Nov (v1.1) |
| 12 Nov | Backup V2 design inputs recorded (35-day daily, 12-week weekly, 12-month monthly retention; protect fillseen, listing and sold-price history; copies outside the live database; encryption/offsite; isolated restore test; recovery objectives and costs first) — not approved, not implemented | Recorded (docs/RECOVERY.md §3) | owner instruction 12 Nov (v1.1) |
| 12 Nov | Testing and release acceptance: test scope and acceptance criteria must suit the change, be documented and be explicitly approved by the owner; known failures are reported and assessed, never hidden or relabelled as passes; historical failures do not automatically block every future phone build; any policy change beyond this clarification needs separate approval | In force | owner instruction 12 Nov (v1.1) |

### Engineering, security and releases
| Date | Decision | Status | Evidence |
|---|---|---|---|
| 22 Oct | Security clean-up: repo private, Cloudflare token rolled, eBay Cert ID rotated, Firebase Android key restricted to the app | Done | `OWNER-REPORTED` |
| 3 Nov | Development rules: testing branch first; no unapproved change to main; no untested upload to live; never modify the live database; no destructive tests on the live service; never change features to make tests pass; never expose keys; never claim an unrun test passed | In force (SAFETY_RULES) | `OWNER-REPORTED` |
| 4 Nov | D1 release build with the existing key | Done | `VERIFIED` `assembleRelease` in main build.yml |
| 4 Nov | D1b new strong signing-key password | Build reads it from a secret; whether it was changed is `UNVERIFIED` | `VERIFIED` build.yml uses `KEYSTORE_PASS` |
| 4 Nov | D2 Android's own backup off | Done | `VERIFIED` build.yml |
| 4 Nov | D3 wrangler 3 → 4 | Done (4.157.0) | `VERIFIED` deploy-worker.yml |
| 4 Nov | D3b Capacitor 6 → 8 "not yet, own step later" | Done later in Release A (8.6.0) | `VERIFIED` build.yml |
| 4 Nov | D4 stop accepting the key in the web address (two steps) | Switch `KEY_IN_URL` exists; whether it is set to off live is `UNVERIFIED` | `VERIFIED` worker.js |
| 4 Nov | D5 restrict the Firebase key further (package + fingerprint + 2 APIs) | `UNVERIFIED` | needs the owner's Google account |
| 4 Nov | D6 Crashlytics "not now" | Deferred | decision table |
| 4 Nov | D7 paid GitHub plan for branch protection — optional; D8 Play developer account — later | Not done | decision table |
| 4 Nov | D9/D10 separate phone test service and TEST app | Test service partly built; status `DEV-REPORTED` | project docs |
| 4 Nov | D11 how long other sellers' usernames in fill history are kept | **Open** (privacy) | decision table |
| 8 Nov | GitHub Actions minutes: commit once per finished task; quick checks on uploads; full suite by hand before phone builds | In force | AI_HANDOVER procedure 8 |
| 11 Nov | Release A (app 2.0.132: Capacitor 8 + Fliptimize redesign) merged to main and built | Done; phone checks passed `OWNER-REPORTED` | `VERIFIED` main 9e7269a, build run 42975706497 |
| 11 Nov | Release B (Scan service) — owner's words: "I approve deploying Release B to production. Deploy only the reviewed main commit 1620653…" | Deployed 11 Nov 11:22 UTC (version ec61ce36); deploy workflow disabled afterwards | `VERIFIED` main 1620653, workflow disabled; deploy details `DEV-REPORTED` |
| 11 Nov | Android phase: investigate Back issue, "Back up now" feedback, regression checks — testing branch only | Backup feedback built (2.0.133); Back cause unknown | `VERIFIED` testing |
| 11 Nov | Pagination / no arbitrary deal limit: plan for later, do not build yet | AGREED PRODUCT DIRECTION (not approved for development) | `OWNER-REPORTED` |
| 12 Nov | Test-only fix of the update test; 2.0.133 prepared for the phone | Done; 2.0.133 installed and 7/7 phone checks passed | `VERIFIED` testing 577c591, run 43165667086; phone `OWNER-REPORTED` |
| 12 Nov | No further emulator Back-button investigation for now; keep the defect open | In force | owner instruction 12 Nov |
| 12 Nov | Build a GitHub-based project knowledge system, documentation only, on a dedicated branch; no merge without approval | In progress (this branch) | owner instruction 12 Nov |

## Superseded decisions (kept for history)
| Was | Replaced by | When |
|---|---|---|
| Personal data-collection use only (29 Oct) | Commercial professional reseller platform | 7 Nov, confirmed 12 Nov |
| Keep the name FlipScout (22 Oct) | Future brand Fliptimize; app still shows FlipScout until branding is final | Nov 2026 |
| Navy/green look (21 Oct); "Graphite & Sage" dark mode (25 Oct) | Fliptimize design tokens (Release A) | 7–11 Nov |
| Debug build with a well-known password (Oct) | Release build (D1); password status unverified (D1b) | 4–11 Nov |
| Capacitor 6, wrangler 3 | Capacitor 8.6.0, wrangler 4.157.0 | 11 Nov |
| Fliptimize D9 "do not start coding" (7 Nov) | Redesign built and released as 2.0.132 | 8–11 Nov |

## Conflicts awaiting the owner
| # | Conflict | Options | Status |
|---|---|---|---|
| C1 | Personal use (29 Oct) vs commercial product (7 Nov) | — | **Resolved** 12 Nov: commercial |
| C2 | Name FlipScout vs brand Fliptimize | Interim wording agreed 12 Nov; final name, logo and launcher name still open | Partly resolved |
| C3 | Separation of owner-only administration from public customer features: "delete database-building tools (admin) before public release" (Oct) vs "keep a manual version of every automatic setting in the admin page for global adjustments" (Oct) | Separate owner-only admin from customer builds; or remove some tools only | **Open** |
| C4 | Data licensing: current price data comes partly from automatic sold-price learning and phone-side page reading, vs eBay licence concerns and the commercial direction | See VISION §6 | **Open — must resolve before launch** |
| C5 | £1 testing minimum profit (7 Nov) vs £50 minimum profit and £200 spending limit read on 11 Nov | — | **Not a conflict** (clarified 12 Nov, v1.1): user-adjustable settings at different times; keep them configurable; values unchanged |
| C6 | "FlipScout is only for eBay" (25 Oct) vs worldwide toolkit and more marketplaces (12 Nov) | — | **Not a conflict** (clarified 12 Nov, v1.1): eBay is the current engine scope; expansion is a FUTURE CONCEPT, not approved |
| C7 | Prediction Lab "future plan, not to build yet" vs built on `feature/prediction-lab` (8 Nov) | Keep for later; update to current code; or shelve | **Open** |
| C8 | Sell and Money tabs hidden "until deal-finding is proven" (25 Oct) vs inventory and financial tracking now part of the product focus (12 Nov) | Decide when and how to bring them back | **Open** (timing decision) |
| C9 | Light theme approved and released (D7, 7 Nov) vs "washed out" feedback (12 Nov) | — | **Not a conflict** (clarified 12 Nov, v1.1): later UX feedback; improvement kept as future work |
| C10 | Spares rule R4 ("never suggest fixes") vs the future Repair & Flip concept (optional, user-requested repair research with parts, prices and guides) | Proposed clarification VISION R4a: R4 governs automatic deal discovery; Repair & Flip, if ever approved, is user-requested and evidence/compatibility-checked, never claiming an easy or guaranteed repair | **Awaiting owner confirmation** |

## Not approved / pending
- Any merge, commit or deployment to `main`, or production app, Worker, database, Cloudflare, Firebase or account changes.
- Paid services, plan upgrades or new subscriptions.
- New authentication or account migrations, signing-key changes, live backup restore or destructive testing.
- The detailed production branch protection and release/rollback implementation: design and review first, obtain explicit approval for changes.
- Added 12 Nov: releasing 2.0.133 to `main`; merging this documentation branch; building any feature in docs/FEATURES_AND_ROADMAP.md; any data acquisition; standing approval for future documentation changes (each change needs its own approval).

## Decision record template
- Date:
- Proposed change:
- Approved / rejected / deferred:
- Scope and exact branch/environment:
- Risks and cost:
- Owner's explicit instruction:
