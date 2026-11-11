# FlipScout — Stage 4 follow-up findings (Step 1)

4 Nov 2026 · testing branch only · main, live Scan service, live database, secrets, Google Cloud and Firebase untouched.
Evidence runs: 41795613187 (Stage 4 baseline) and 41802248435 (Stage 4 part + new jobs). Commits: 19eec1c, a05e07c, 26cfb3a, 5676b36.

## 1. The Stage 4 non-passing checks, exactly (baseline run 41795613187)

| # | Result | Check | Evidence | Severity | What happens next |
|---|---|---|---|---|---|
| F1 | FAIL | Dependencies › phone build: 1 critical, 1 high, 3 moderate | `tar` (critical) via `@capacitor/cli` 6; glob/minimatch/rimraf | Low in practice: build tools on GitHub's throwaway machines, not shipped in the app | Fix = Capacitor 8 (decision D3) |
| F2 | FAIL | Dependencies › Scan service deploy: 7 high, 1 moderate | all inside wrangler 3 (miniflare, undici, ws, sharp, zod, esbuild, busboy) | Low: deploy tool only, not in the live service | **Fixed on testing**: Wrangler 4.157.0, all checks + deploy dry run pass |
| F3 | FAIL | Phone app build › debug mode | `debuggable=true`, `assembleDebug` | High (phone lost/shared) | **Prepared on testing**: release build passes (D1) |
| F4 | FAIL | Phone app build › Android backup | `allowBackup=true` | Medium | **Prepared on testing**: backup off (D2) |
| F5 | FAIL | Performance › 13 deals sort 2,259 ms | single timing | Low | Not reproduced: 54 timed sorts, max 0.5 s (see §2) |
| F6 | FAIL | Performance › 1,000 deals sort 2,002 ms | single timing | Low | Same |
| P1 | PARTLY | admin connection box (emulator limit) | Chrome 109 can't tap folded box | — | Phone checklist |
| P2 | PARTLY | wrong-key setup code typed in Menu (emulator limit) | same | — | Phone checklist |
| P3 | PARTLY | GitHub's own Actions pinned by tag, not commit | normal practice | Low | Optional |
| P4 | PARTLY | Android target 34 (Play needs 35) | apk-check | Medium for Play only | Capacitor 7+/8 (D3) |
| P5 | PARTLY | signing | debug certificate, password `android` | High | D1 |
| P6 | PARTLY | key accepted in web address | old app versions | Low/medium | **Prepared**: notice + off switch (D4) |
| P7 | PARTLY | any website may call the service (CORS *) | by design; key is the lock | Low | Keep; documented |
| P8 | PARTLY | single-user design | one service per user | — | Documented |
| P9–10 | PARTLY | 58 controls 36 px tall (light, dark) | ≥24 px WCAG minimum met; <48 px Android advice | Low | Design choice |
| P11–17 | PARTLY | scrolling smoothness at 13…3,000 deals | emulator draws with software | — | Phone checklist |
| N1–3 | NOT TESTED | wrong-key recovery after the emulator limit: Deals shows "wrong key"; "Check address and key ›"; right key fixes Deals | the step before (typing in the folded box) can't be done on the emulator, so these never ran | Medium | Phone checklist. **Owner verified only that the keyboard opens/stays open — not this journey.** |

## 2. The two slow sorts — evidence
Run 41802248435 timed every sort option 3 times at 13, 1,000 and 1,500 deals on the emulator (54 sorts), recording the app's own code time, browser freezes and how busy the virtual phone was:
13 deals: median 30 ms, slowest 54 ms · 1,000: median 232 ms, slowest 310 ms · 1,500: median 388 ms, slowest 513 ms. App code: median 5 / 194 / 297 ms.
No sort over 1.5 s. The earlier two (2.0–2.3 s) happened once each and never again; the same sorts ran 10–40× faster on a computer slowed 6×.
**Conclusion:** most likely the emulator pausing (it shares 2 slow cores with Android's own background work), not the app — but not proven. Stays on the phone checklist.

## 3. Release build and signing (decision D1)
Found: the live app is a **debug** build signed with an Android **debug-type key** (name `androiddebugkey`, password `android`, stored as the GitHub secret KEYSTORE_B64). Public fingerprint SHA-256 88:FD:60:0B…:A5:92.
Prepared on testing (build.yml), live build unchanged until approved:
- release build (`assembleRelease`): not debuggable; web view not inspectable (`webContentsDebuggingEnabled:false`, checked inside the built file);
- **signed with the same key file and name** → your installed app updates in place and keeps its data (Android only allows updates signed by the same key);
- passwords read from GitHub secrets KEYSTORE_PASS / KEYSTORE_KEY_PASS when they exist; until then the key's existing password is used (nothing new is created or exposed);
- tested: the release build installs and starts on the emulator, `run-as` refused (not debuggable), backup flags off.
Recommendation:
1. Now (after approval): switch the live build to the release build with the **same key** — no reinstall, no data loss.
2. Then: change the key's **password** (the key itself stays, so updates still work) and store it as a GitHub secret; keep an offline copy of the key file + password (e.g. a password manager). I'll give exact steps; I won't create or see the password.
3. Google Play later: Play won't accept a debug-type certificate. You'd create a proper upload key once and install the Play version fresh (one-off reinstall; your data comes back from FlipScout's cloud backup + your setup code). Play then signs the app for you (Play App Signing). Needs the $25 developer account (decision D8).

## 4. Android backup and the Scan service key (decision D2)
Everything the app keeps (deals cache, stock items, settings **and the Scan service key**) lives in one web-view storage area. Android can only include or exclude whole files, so **the key can't be excluded while keeping the rest**. Moving the key into Android's secure keystore would need a new native plugin (bigger change; not done).
Prepared: Android backup **off** (`allowBackup=false` + rules excluding everything from Google cloud backup and phone-to-phone transfer).
What still protects your data: FlipScout's own cloud backup on your Scan service (tested: back up → wipe → restore gives identical stock items, spend limit and categories). After a new phone you re-enter the setup code (keep it somewhere safe) and tap Restore.

## 5. Dependency upgrades (decision D3)
- **Wrangler 4.157.0: done on testing.** Trial: service smoke 9/9, security 16 checks, monitoring/restart 6, deploy dry run (bundles fine). Your deploy script only uses commands unchanged in v4. Live deploy keeps Wrangler 3 until you approve a merge.
- **Capacitor 8: trial only (not switched).** It builds with the live steps (Java 21, target Android 16/API 36) and on Android 15 the app draws below the status bar with no layout problems. But: minimum Android rises from 5.1 to **7.0**; Android 16 phones force edge-to-edge (the app has no top safe-area handling yet — not visible on the Android 15 emulator); all plugins move a major version. Recommended: approve as its own step with a full emulator run + your phone check. It also clears F1 and P4.

## 6. Key in the web address (decision D4)
Old app versions (before 25 Oct 2026, commit bb9c188) sent `?key=…` on every request. Where it can leak: Cloudflare's request logs/live tail if you open them, any proxy or VPN logs on the way (the address is encrypted in transit by HTTPS, but visible to Cloudflare and anything that logs full addresses). FlipScout's own problem log already strips it. Current app versions send it in a hidden header.
Prepared on testing: each use of the old way appears in the Problems list as "notice: key sent in the web address" (count, which kind of request; never the key; no alert). Switch `KEY_IN_URL=off` refuses it. Tested (5 checks).
Migration: deploy the notice (no behaviour change) → wait until no notice appears for ~2 weeks → turn the switch off → if anything breaks, turn it back on (one setting, instant).

## 7. Firebase and crash monitoring (decisions D5, D6)
Firebase project **flipscout-bc19a** (project number 290757458184), Android app com.reaverslegion.flipscout. Its API key is in the app by design. The app uses it only to register for alerts; your Scan service sends alerts with a separate service account, not this key.
Recommended restriction (Google Cloud console › APIs & Services › Credentials › the Android key): Application restriction = Android apps, package com.reaverslegion.flipscout + your signing key's SHA-1; API restriction = Firebase Installations API + FCM Registration API. Test an alert afterwards. **Not changed** (needs you).
Crashlytics: free on Firebase's no-cost plan (please confirm on Firebase's pricing page — I couldn't open it), needs a Gradle plugin + SDK, sends crash stack traces, device model, Android version and an installation ID to Google; can be set to opt-in. **Not connected.**
**Own native crash capture (built, tested, free, no accounts):** Java crash details saved just before Android closes the app + Android 11+'s record of why the app closed (crash, native crash, freeze/ANR, start failure). Sent on next start, cleaned of private details, to the Problems list. Tested with a real crash on the emulator (`am crash`): recorded once, shown in Problems. Not yet exercised: the Java-detail file (Android logged the test crash as native) and freezes (ANR).
Recommendation: keep own capture; add Crashlytics only before a public release.
Problems list verified: recorded with type, place, version, count; private details removed (keys, tokens, passwords, emails, address details); newest 300 kept; repeated problems alert at most every 6 hours (3× service, 5× app); notices never alert.

## 8. Phone test readiness
Built (not installed): **"FlipScout TEST"**, package com.reaverslegion.flipscout.test — installs **next to** your real app, can't replace it or read its data, red "TEST BUILD" label, version ends in -TEST. Alerts are off in it (Firebase only knows the real app's package; adding the test package in Firebase is free but is a change to your Firebase project). Each test build is signed with a one-off key, so a newer test build means uninstalling the old TEST app first (the real app is unaffected).
What it connects to — your choice (decision D9):
- **A (recommended): a separate free test Scan service** on your Cloudflare account (new worker + new database, no eBay keys, filled with representative copies of deals). Real-shaped data, zero risk to live data. Creating it is a change to your Cloudflare account → needs approval.
- B: your live Scan service — real deals, but the TEST app would save settings and backups there (could overwrite your real backup). Not recommended.
- C: no service — only the welcome guide and offline screens can be tested.
Going back: uninstall "FlipScout TEST" (long-press › Uninstall). Your real app, its data and its updates are untouched.
