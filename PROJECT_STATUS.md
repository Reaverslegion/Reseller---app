# Fliptimize — project status

Last reviewed: 2026-11-08
Status: WORKING DRAFT — verify against current GitHub and Cloudflare before relying on it.
Owner: single nontechnical operator. Explain everything in plain English.

## Product
Android eBay reseller opportunity app. Core capabilities include eBay scanning, sold-price analysis, estimated profit and sell-through, deals and alerts. Subscription tiers, fair deal distribution and multi-user business operations are planned, not verified as production-ready.

## Environments
- `main`: production code. Never push, merge, deploy or change production without explicit owner approval.
- `testing`: nonproduction development and tests. Test infrastructure must remain separate from production.
- `feature/prediction-lab`: experimental Prediction Lab work; do not assume merged or deployed.

## Verified source-level observations (2026-11-08)
- Production Worker deployment is triggered by changes to `worker.js` or its deployment workflow on `main`; automated tests run before deployment.
- `main` was reported unprotected by the GitHub branch API. Recheck before taking action.
- Production weekly KV export covers resale price data and optionally fill sales, not a complete D1 disaster-recovery snapshot. Live backup success and restore are unverified.
- Android app has local and cloud backup logic; end-to-end disaster recovery remains unverified.
- Production error monitoring is less developed than `testing`, which contains a Problems log and repeated-error alerts.
- Existing production app/service authentication is not suitable as-is for independent paid user accounts.
- Testing branch includes substantial changes not yet integrated into main. Reconcile current production fixes before any future merge.

## Current priorities
1. Agree on and test a safe, owner-approved production release process.
2. Verify full backups and restore in an isolated environment.
3. Document and test rollback without overwriting newer customer data.
4. Add independent service health monitoring and understandable owner alerts.
5. Review multi-user authentication, permissions and signing before paid launch.

## Verification limitations
This status is based on repository inspection, not access to live Cloudflare configuration, actual backup objects, billing, current secrets or physical-phone testing. Do not claim those are healthy without checking.

## Next step
Claude and ChatGPT should read all four coordination documents, compare them with the latest repository state, and propose the first small safety improvement. No implementation or deployment is authorized by these documents.
