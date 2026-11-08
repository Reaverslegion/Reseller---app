# Fliptimize — owner decisions

Only record decisions explicitly approved by the owner. Proposals are not approvals.

## Approved
- 2026-11-08: Read-only safety and recovery audit of connected GitHub repository.
- 2026-11-08: Establish shared Claude/ChatGPT coordination through GitHub.
- 2026-11-08: Create these four coordination documents on `testing` only. No application code or production configuration changes.
- Collaboration model: Claude is initially the main implementer; ChatGPT independently reviews and may undertake separately agreed development tasks. GitHub is the handover medium. Owner retains approval over important changes.

## Not approved / pending
- Any merge, commit or deployment to `main`, or production app, Worker, database, Cloudflare, Firebase or account changes.
- Paid services, plan upgrades or new subscriptions.
- New authentication or account migrations, signing-key changes, live backup restore or destructive testing.
- The detailed production branch protection and release/rollback implementation: design and review first, obtain explicit approval for changes.

## Decision record template
- Date:
- Proposed change:
- Approved / rejected / deferred:
- Scope and exact branch/environment:
- Risks and cost:
- Owner's explicit instruction:
