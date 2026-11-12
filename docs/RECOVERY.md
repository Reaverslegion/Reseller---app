# Fliptimize — backup, disaster recovery and rollback

Version 1.0 · prepared 12 Nov 2026 on branch `docs/knowledge-system-v1` · NOT yet reviewed by ChatGPT or approved by the owner.
Evidence labels: see [AI_HANDOVER.md](../AI_HANDOVER.md#evidence-labels). Nothing here authorises a restore, a rollback or a
change to production. Never write secret values in this file.

## 1. What is backed up today

| What | How | Covers | Evidence |
|---|---|---|---|
| Phone data (items, rules, settings incl. Scan service key, categories, checklist, tracked items) | Automatic cloud backup to the Scan service (Cloudflare KV, latest + previous copy) and "Back up now" | Everything except the unsaved add-item draft | `VERIFIED` code; restore tested on emulator (update tests 4 Nov, 12 Nov); 2.0.133 backup feedback phone check `OWNER-REPORTED` |
| Phone data, by hand | Admin: "Manual backup (copy and paste)" → paste restore | Same as above | `VERIFIED` code; tested on emulator |
| Android's own Google backup | **Off** since the release build (it copied the Scan key) | — | `VERIFIED` build.yml |
| Price list | Weekly KV export of resale prices (optionally fill sales) | Price data only | `DEV-REPORTED` (PROJECT_STATUS 8 Nov) |
| Scan service code | GitHub `main` | Code and workflows | `VERIFIED` |
| Live database (D1) | **No verified full backup or tested restore** | — | `UNVERIFIED` — highest recovery gap |
| Secrets and signing key | Stored as GitHub/Cloudflare secrets; owner's own copies unknown | — | `UNVERIFIED` — owner should confirm copies are in a password manager |

## 2. Rollback procedures (recorded, not rehearsed in production)

**Scan service (Cloudflare Worker)** — `DEV-REPORTED` (Release B record, 11 Nov 2026):
1. Cloudflare dashboard → Workers & Pages → flipscout-search → Deployments → roll back to the previous version
   (for Release B: **0d44aa43**).
2. Then revert the merge on `main` with `[skip ci]`, so the code matches what is live.
3. Rolling back code does **not** restore deleted data (e.g. deals removed by re-judging).

**Android app** — `DEV-REPORTED`:
- Android refuses to install a lower version over a higher one without uninstalling (which deletes data). The owner has
  said never to ask them to uninstall.
- Safe route: build the previous code with a **higher** version number and install it over the top. A rollback rehearsal of
  this kind passed on the emulator (update tests on `claude/capacitor-8-upgrade`, 11 Nov).
- Data route: restore from the cloud backup or the pasted backup text.

**Signing key:** losing the key or its password means the app can never be updated in place again. Its safekeeping is
`UNVERIFIED` (see §4).

## 3. Backup V2 — requirements (`PROPOSED`)

The owner's "Backup V2" plan is referenced but its contents are **not in any Claude-accessible record** (probably in
ChatGPT conversations). Until supplied, these are the proposed minimum requirements, drawn from earlier audits:

1. **Full database backup** of D1 on a schedule, kept for a defined period, outside the live database.
   Research first: Cloudflare D1's own point-in-time restore ("Time Travel") and export features may already provide this
   (reuse before build — not yet verified for this account or plan).
2. **Tested restore** into an isolated test database, never the live one, with a written result.
3. **Recovery targets** agreed with the owner: how much data may be lost (e.g. one day) and how fast service must return.
4. **Per-user backups** once there are subscribers: one user's restore must never overwrite another user's data or newer
   data ("rollback without overwriting newer customer data" — PROJECT_STATUS 8 Nov).
5. **Secrets and signing key:** an offline copy in the owner's password manager; a written procedure for rotating each.
6. **Retention and privacy:** decide how long other sellers' usernames in fill history are kept (open decision D11) and
   how long backups are kept; document deletion on request once there are users.
7. **Monitoring:** an alert if scans stop or backups fail (partly exists: Problems list and repeated-error alerts).

## 4. Open items for the owner

- Confirm the signing key and its password, the Scan service setup code and service passwords are stored in a password
  manager (do **not** send them to any AI).
- Approve research of D1 backup options and a test restore in a test database (no production change).
- Supply the Backup V2 notes from ChatGPT, if they exist.
