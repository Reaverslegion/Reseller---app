# Fliptimize — Reuse Before Build policy and open-source research register

Version 1.1 · 12 Nov 2026 · branch `docs/knowledge-system-v1` · v1.0 reviewed by ChatGPT; v1.1 corrections pending final
review and owner approval.

**The register in §3 is a starting point, not a complete inventory of all previous research.** Research done in ChatGPT
conversations has not been recovered and is **outstanding**; do not assume every previously considered solution is listed.
Evidence labels: see [AI_HANDOVER.md](../AI_HANDOVER.md#evidence-labels).

## 1. Policy — Reuse Before Build (permanent principle, owner, 12 Nov 2026)

Fliptimize maximises **responsible** reuse of existing open-source code to move faster, cut engineering and maintenance
costs, avoid reinventing the wheel, build on community-tested foundations and concentrate custom work on what makes
Fliptimize different. **The goal is maximum useful reuse, not maximum dependency count.**

Before proposing any substantial new functionality (or any new dependency):

1. Check whether existing project code already does it.
2. Research established open-source implementations.
3. Prefer secure, actively maintained, well-documented projects.
4. Check commercial licensing, attribution, notices, patent provisions and distribution obligations.
5. Evaluate integration complexity, security, performance and maintenance cost.
6. Compare reuse against custom development.
7. Avoid unnecessary dependencies and architectural complexity.
8. Record promising **and rejected** options in §3 of this file.
9. Get the owner's approval for significant dependencies or architectural changes.

**Licences:** MIT, Apache-2.0, BSD and ISC are generally promising, but every candidate is still reviewed. MPL, GPL, AGPL,
non-commercial, source-available and unclear licences need particular scrutiny and are **never assumed suitable** for the
commercial product. This file is not legal advice.

### Proposal check (copy into any proposal)

```
Reuse check — <feature>
- Existing code that already helps:
- Candidates (name · licence · last release · maintenance/security signals · fit):
- Integration and running cost (incl. GitHub Actions minutes, Cloudflare usage):
- Reuse vs build — recommendation and why:
- New dependency? yes/no → owner approval needed:
```

Existing safeguards that support this: dependency and secret scan job in `test.yml` (npm audit), GitHub add-ons pinned to
exact commits, signing guard. `PROPOSED` later: a free automatic check that flags any new dependency in a pull request.

## 2. Components already in use

Licences marked "to confirm" were not checkable from this session (package registry unreachable) — confirm from the
package before relying on them.

| Component | Used for | Version (main 1620653) | Licence | Evidence |
|---|---|---|---|---|
| Capacitor (core, android, cli) | Android app shell | 8.6.0 | MIT — to confirm | `VERIFIED` version in build.yml |
| @capacitor/app, push-notifications, app-launcher | Back button, alerts, opening eBay | 8.1.2 / 8.1.3 / 8.0.1 | MIT — to confirm | `VERIFIED` version |
| cordova-plugin-inappbrowser | In-app browser for price fills | 6.0.1 | Apache-2.0 — to confirm | `VERIFIED` version |
| wrangler | Deploying the Scan service | 4.157.0 | MIT or Apache-2.0 — to confirm | `VERIFIED` version |
| Playwright | Local and CI browser tests | 1.63.0 (tooling) | Apache-2.0 | `VERIFIED` (installed package) |
| GitHub actions/checkout, setup-node, setup-java, upload/download-artifact | CI | pinned commits | MIT — to confirm | `VERIFIED` usage |
| reactivecircus/android-emulator-runner | Emulator tests | pinned | to confirm | `VERIFIED` usage |
| Cloudflare Workers, D1, KV; Firebase Cloud Messaging | Hosting, database, alerts | services | Commercial services (not open source) | `VERIFIED` usage |

## 3. Research register

| Date | Need | Option | Licence / terms | Result | Source |
|---|---|---|---|---|---|
| 29 Oct 2026 | Official sold-price data | eBay Marketplace Insights API | eBay licence; limited release | **Promising but probably unavailable** (small developers reportedly refused) | soldprices research (project doc) |
| 29 Oct 2026 | Sold-price history | eBay Finding API (completed items) | — | **Rejected:** decommissioned 2025 | same |
| 29 Oct 2026 | Sold-price history | eBay Terapeak / Product Research | No API or export | **Rejected** for automation | same |
| 29 Oct 2026 | Sold-price history | Third-party eBay scrapers | Against eBay's terms | **Rejected** | same |
| 24–29 Oct 2026 | Category price licences | Commercial price-data licences (one evaluated: paid, USD only) | Commercial | **Deferred**; possible later via import | HANDOFF 24 Oct; soldprices |
| 24 Oct 2026 | Price floor for tech | Retailer cash prices | No API; terms unchecked | **Idea only** | HANDOFF 24 Oct |
| 29 Oct 2026 | Sold-price research system | Built in-house (Python, SQLite) | Own code | Built; **not in the repository** (ZIP only) | soldprices research |
| Oct 2026 | Alerts | ntfy | Open source | **Rejected:** users must not install another app | Owner |
| 4 Nov 2026 | Crash reporting | Firebase Crashlytics | Google service | **Deferred:** own crash capture works | Decision D6 |
| 4–11 Nov 2026 | App framework upgrade | Capacitor 6 → 8 | MIT — to confirm | **Adopted** (Release A) | DECISIONS |
| 4–11 Nov 2026 | Deploy tool upgrade | wrangler 3 → 4 | to confirm | **Adopted** (Release B) | DECISIONS |
| 12 Nov 2026 | Database backup (Backup V2) | Cloudflare D1 point-in-time restore / export | Cloudflare service | **To research** before building anything | RECOVERY.md |

`UNVERIFIED` / outstanding: open-source research done in ChatGPT conversations is not recorded here yet. Add it as dated
rows when it is supplied; no major new research was done for v1.1.
