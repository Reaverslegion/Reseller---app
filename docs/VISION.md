# Fliptimize — product vision, rules and architecture

**Fliptimize — Android app currently named FlipScout.** Use this wording until branding is finalised.

Version 1.1 · 12 Nov 2026 · branch `docs/knowledge-system-v1` · v1.0 reviewed by ChatGPT; v1.1 corrections pending final
review and owner approval. Status words (RELEASED, AGREED PRODUCT DIRECTION, FUTURE CONCEPT …) are defined in
[FEATURES_AND_ROADMAP.md](FEATURES_AND_ROADMAP.md#status-words-implementation--approval-status).

**Where the project stands (owner, 12 Nov 2026):** work has deliberately concentrated on the deal-finding engine, valuation
calculations, reliability and supporting infrastructure. The subscription business and most future features have **not**
been designed in detail — intentionally. This document records direction, not specifications.
Evidence labels are explained in [AI_HANDOVER.md](../AI_HANDOVER.md#evidence-labels). Feature status lives in
[FEATURES_AND_ROADMAP.md](FEATURES_AND_ROADMAP.md); decisions in [DECISIONS.md](../DECISIONS.md).

## 1. What Fliptimize is for

`OWNER-REPORTED` (owner instruction, 12 Nov 2026): Fliptimize is intended to become a **commercially viable, professional
reseller platform**. It helps resellers:

- identify worthwhile buying opportunities;
- estimate realistic resale values;
- calculate costs, fees, profit and ROI;
- understand risk and confidence;
- track inventory, spending and financial outcomes;
- allocate limited opportunities fairly among subscribers;
- make better business decisions.

**Projected profits are estimates, never guaranteed earnings.** No screen, document or marketing text may present them as
guaranteed.

The earlier "personal-use data collection app only" direction (29 Oct 2026) is `SUPERSEDED` by this commercial direction
(owner, 7 Nov and 12 Nov 2026). See DECISIONS.md.

### Professional tools first — no gamification for now
`OWNER-REPORTED` (owner decision, 12 Nov 2026). The priority is genuine reseller value, not time spent in the app.

- **Product focus** (the owner's "active product priorities"; AGREED PRODUCT DIRECTION — none is approved for development
  by this list): reliable deal discovery and valuation; profit and ROI calculations; inventory and financial tracking;
  potential, secured and realised profit; deal notifications; personalised market insights; subscription value and fair
  allocation; useful analytics and decision support. Several of these exist in part today (deal discovery, valuation,
  profit maths, notifications — RELEASED); the rest are directions only.
- **Deferred (kept, not deleted):** Reseller Academy, educational courses, interactive challenges, achievements and progress
  badges, streaks and points. Revisit only with evidence that they improve user outcomes, subscriber retention or
  commercial performance. Practical repair and selling guides remain possible future items.

## 2. Product rules (must be preserved)

Each rule keeps its original meaning and source. If a later decision conflicts with a rule, flag it in DECISIONS.md
("Conflicts awaiting the owner") rather than changing the rule.

| # | Rule | Source |
|---|---|---|
| R1 | **Nobody should need to add anything up.** Every money figure comes with a clear final total (total you pay, profit). | Owner, Oct 2026 (Claude memory; HANDOFF 24 Oct §1) |
| R2 | Support both **Private and Business seller** modes; fees and buyer-protection fee follow the mode. | Owner, 7 Nov 2026; finance tests |
| R3 | Keep the user's own **minimum profit** and **spending limit** settings, adjustable by the user; deals are judged on minimum profit (return % optional). Values used at different times (e.g. £1 for testing; later £50 minimum profit and £200 spending limit) are user settings, not product decisions. | Owner, Oct 2026; spending limit "an important option"; clarified 12 Nov |
| R4 | **Spares/repairs (original rule, unchanged):** never suggest fixes or call something an easy fix. Show only the seller's own words and the facts; the user judges the fault and enters their own repair cost. In ordinary deal discovery, clearly distinguish the **seller's reported condition** from the **app's risk warnings**. The app must not automatically claim a faulty item is easy to repair, invent a diagnosis, or imply a repair is guaranteed. | Owner, Oct 2026 (HANDOFF 24 Oct §1); restated 12 Nov |
| R5 | Never invent repair diagnoses or claim part compatibility without evidence. | Owner instruction, 12 Nov 2026 (extends R4) |
| R4a | **Proposed clarification — awaiting owner confirmation (DECISIONS C10):** R4 governs automatic deal discovery. A possible future Repair & Flip feature (FUTURE CONCEPT, not approved) could offer *optional, user-requested* repair research — parts, prices and guides — only with evidence and compatibility checks, never automatic claims of an easy or guaranteed repair. | Owner instruction, 12 Nov 2026 |
| R6 | Anything made automatic keeps a **manual version in the admin page**, so the owner can set a global adjustment for all users. | Owner, Oct 2026 — see conflict C3 in DECISIONS.md |
| R7 | **Never show an accuracy figure that hasn't been measured**; show the evidence instead (e.g. "From N sales"). | Owner, 25 Oct 2026 |
| R8 | **Never put "eBay" in the product name, icon or domain.** Plain-text mentions are fine, with "Not affiliated with eBay". | HANDOFF 24 Oct §1 |
| R9 | **No evasive data collection.** No spoofing, random delays to look human, proxies, captcha solving, burner accounts or server-side scraping. Data reading must be user-initiated and paced. | Owner + Claude, 23–26 Oct 2026 (see REJECTED list) |
| R10 | Users must **not be asked to install other apps**; alerts are the app's own notifications. | Owner, Oct 2026 (ntfy rejected) |
| R11 | Ease of use is what is being sold: users must instinctively understand every screen; cut clutter but keep data power users need. | Owner, Oct 2026 |
| R12 | Calculations must stay the tested ones; never remove or change a feature just to make a test pass. | Owner, 3 Nov 2026 |

## 3. Scope map (topics to document — NOT approval to build)

Status of each item is in FEATURES_AND_ROADMAP.md. **Current engine scope: eBay (UK).** A worldwide toolkit and other
marketplaces are FUTURE CONCEPTS — they extend the initial scope rather than contradict it, and are not approved for
development.

### Business model — agreed directions and concepts (not designs)
`OWNER-REPORTED` (12 Nov 2026). AGREED PRODUCT DIRECTION: commercial professional reseller platform; free reseller tools;
multiple paid subscription tiers; tier-based potential-profit opportunity **targets** (not guarantees); fair round-robin
distribution; matching by available budget and preferred categories; limited recipients per opportunity; redistribution
of unclaimed opportunities; fairness informed by opportunities already received; potential, secured and realised profit
tracking. FUTURE CONCEPT: possible priority access for higher tiers; possible one-time purchase (previously discussed around
£4.99 — **not approved**); possible worldwide standalone toolkit.

**Not decided (deliberately):** tier names or prices, guaranteed returns, recipient limits, first-look windows, allocation
algorithms, revenue or subscriber projections, launch dates. The allocation system needs later design, simulation and
evidence that enough genuine opportunities exist to support the proposed subscription value. Business design is a separate
future phase.

### Topic summary

- **Core:** Android app and Scan service · eBay API integration · historical sold-price data · resale estimates and
  sell-through · profit, fees, postage, ROI and risk controls · inventory, budgeting and financial tracking · Prediction Lab
  and accuracy validation · condition matching and deal quality · pagination, scaling and incremental updates.
- **Business:** UK automated deal discovery · worldwide reseller toolkit · free and possible one-time purchase models ·
  multiple paid subscription tiers · fair round-robin deal allocation · matching by budget, category and preferences ·
  priority access and unclaimed-deal redistribution · limited recipients per deal · subscription value targets (not
  guarantees) · subscription economics.
- **Engagement:** deal alerts · daily opportunity dashboard · potential, secured and realised profit · personalised market
  insights · business analytics.
- **Future:** optional risky-condition listings · Repair & Flip · replacement-part costs and compatibility · practical
  repair guides · more marketplaces and countries.
- **Engineering:** Backup V2 and disaster recovery · data retention and recovery testing · security and privacy · GitHub
  Actions cost controls · Cloudflare infrastructure and monitoring · open-source research · deployment and rollback
  safeguards · commercial launch requirements.

*v1.0 said most business-model details were missing records. Corrected in v1.1: the owner confirmed (12 Nov) that these
were intentionally not designed yet; the concept-level items above are now recorded. Backup V2 design inputs are in
[RECOVERY.md](RECOVERY.md) §3.*

## 4. Brand

| Item | Status | Evidence |
|---|---|---|
| Future brand **Fliptimize**; domains owned (.com, .co.uk); trademark and name availability checked by the owner | `OWNER-REPORTED` | Owner, Nov 2026 |
| Visible app name today: **FlipScout**; Android package ID kept (`com.reaverslegion.flipscout`) | `VERIFIED` (main 1620653) | build files; decision D6 of 7 Nov |
| Preferred mark: layered, forward-moving geometric symbol (violet/indigo/orchid), light and dark versions. **Final logo not supplied**; app uses a text-only wordmark | `OWNER-REPORTED` | Owner, Nov 2026 |
| Geometric fox head — placeholder only, **not approved** | `REJECTED` as final logo | Owner, 7–8 Nov 2026 |
| Light canvas #F6F6FA, visible card borders, solid violet buttons (released in 2.0.132) | `VERIFIED` (in main) | Fliptimize decisions D7–D8, 7 Nov |
| Light mode "feels washed out and bland" → future improvement to visual hierarchy, contrast, accessibility and long-session comfort; **not an immediate redesign**. Later UX feedback on a theme that was approved and released — not a reversal of that approval | `OWNER-REPORTED`; AGREED PRODUCT DIRECTION | Owner, 12 Nov 2026 |
| Earlier looks: navy/green (21 Oct), "Graphite & Sage" dark mode (25 Oct) | `SUPERSEDED` by the Fliptimize redesign (Release A) | session notes 24–25 Oct |

## 5. Architecture (as of main `1620653`, 11 Nov 2026)

`VERIFIED` from the repository unless marked.

| Part | What it is |
|---|---|
| App | One file `index.html` (vanilla JavaScript), packaged for Android with **Capacitor 8.6.0** (plugins: app 8.1.2, push-notifications 8.1.3, app-launcher 8.0.1, cordova-plugin-inappbrowser 6.0.1). Release build signed with the existing key. Android's own backup is off. Tabs: Deals, Following, Settings. Data stored on the phone in `resell_helper_v1`. |
| Scan service | One Cloudflare Worker (`worker.js`), runs every minute and hunts at the user's interval. Deployed by `.github/workflows/deploy-worker.yml` with wrangler 4.157.0, by hand only (workflow currently **disabled**). |
| Database | Cloudflare D1 (listings, sales, prices, fill sales, deals, follows, deal removals, problem log, settings). Release B keeps a 3,000-deal ceiling. |
| Backup store | Cloudflare KV: the app's cloud backup (latest + previous copy) and a weekly price-list export. Not a full database backup. |
| Alerts | Firebase Cloud Messaging push notifications. |
| Tests / CI | `tests/` (38 entries) run by `.github/workflows/test.yml` (quick and full levels, emulator suites); signing guard; update test; read-only live checks. |
| Data in | eBay Browse API (listings for sale), Trading GetItem (item checks), phone-side reading of eBay sold pages that the user opens ("Fill prices", admin only), learned results of ended auctions. See §6. |

Single-user design today: one shared app key ("setup code"), no accounts. Multi-user accounts, hosted sign-in and
subscriptions are **not built** (`VERIFIED`: no account system in main).

## 6. Data licensing and commercial risk — UNRESOLVED

`UNVERIFIED / DISPUTED` — recorded from Claude's reading of eBay's terms on 22–24 Oct 2026 (HANDOFF 24 Oct §7). This is
**not legal advice** and must be re-checked against the current agreement versions and by a qualified adviser before any
commercial launch.

**Relevant terms as recorded (re-verify):**
- eBay API License Agreement **§9.5**: no using eBay content to suggest or model prices.
- **§8.1.4.1**: average selling prices need eBay's permission.
- **§8.1.3**: listing data no more than 6 hours old; other content no more than 24 hours.
- eBay **User Agreement**: bans automated gathering of content without permission.

**Intended data uses and their status:**

| Use | Source and permission | Concern |
|---|---|---|
| Finding listings for sale, deal alerts | Official Browse API under the developer licence | Freshness rules (§8.1.3); daily call limit (5,000/day recorded) |
| Learning sold prices from ended auctions (automatic) | Official API data | Possible conflict with §9.5 / §8.1.4.1. Recorded plan (24 Oct): **switch off before going public** |
| "Fill prices" — phone reads eBay sold pages the user opens (admin tool) | User Agreement; user-initiated, paced | Grey area; realistic risk recorded as account blocks/captchas. Owner accepted for private use |
| Pooling prices across users (community price book) and offering valuations to paying subscribers | — | Commercial redistribution of eBay-derived values; needs permission or a licensed source |
| Prediction Lab outcomes | Trading GetItem | Same §9.5 question if used to model prices |

**Must be resolved before commercial launch:** written permission from eBay or approved access to official sold data
(Marketplace Insights is a limited-release API; small developers reportedly refused), and/or a licensed third-party data
source; legal review of terms, privacy and data retention; decision on switching off automatic sold-price learning.
**Research only — no scraping, data acquisition or production change is authorised by this document.**

## 7. Commercial launch requirements (recorded checklist, not approved work)

`DEV-REPORTED` (session notes 24 Oct; owner asked to keep it on the roadmap, to do closer to launch):
use the app personally first to prove deals are real · multi-user Scan service with sign-up/log-in · eBay compliance and
higher call limits · privacy policy, terms of use, account/data deletion, ICO registration · HMRC self-employment once
takings pass £1,000/year · icon, UK trade mark, Play Store listing ($25 developer account), signed app bundle ·
subscriptions via Google Play billing · free test group of 10–20 resellers before charging · delete or lock down admin
tools and the temporary live-data review job.
