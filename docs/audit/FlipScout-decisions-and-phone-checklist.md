# FlipScout — decisions for you, and the phone-test checklist

4 Nov 2026 · everything below was prepared and tested on the **testing** branch only. Nothing here has changed your live
app, live Scan service, live database, Google/Firebase settings or GitHub settings. Each "yes" is a separate approval.

## C. Decision table

| # | Decision | My recommendation | Why | Risk if yes | Risk if no | Cost | Safe test done on testing? |
|---|---|---|---|---|---|---|---|
| D1 | Switch the live app to a **release build** signed with your **existing** key | **Yes** | Debug builds can be inspected by anyone with your unlocked phone and a USB cable | Low: same key, so it installs as an update and keeps your data. Do it once with your phone at hand | Key and data easier to read off a lost/shared phone | Free | Yes: release build installs and starts on the emulator, can't be debugged, backup off |
| D1b | Give the signing key a **new strong password** (key itself unchanged) | Yes, after D1 | The current password is the well-known "android" | Low: if the new password is lost you can't update the app → keep it in a password manager | Anyone who gets the key file can sign look-alike updates | Free | Prepared: build reads the password from a GitHub secret |
| D2 | Turn **Android's own backup off** (Google backup / phone-to-phone copy) | **Yes** | It copies your Scan service key into Google backups; the key can't be excluded on its own | You restore via FlipScout's cloud backup + your setup code instead (tested) | Key stays in Google backups | Free | Yes (part of D1's build) |
| D3 | Upgrade **Wrangler 3 → 4** (the Scan service's deploy tool) | **Yes** | Clears 7 high warnings in the deploy tool | Low: all service, security and monitoring checks + a deploy dry run passed on v4 | Warnings stay (deploy machine only) | Free | Yes |
| D3b | Upgrade **Capacitor 6 → 8** (the app's framework) | **Not yet** — as its own step later | Needed for Google Play (target Android 15+) and clears the build-tool warnings | Medium: minimum Android rises to 7.0; Android 16 forces edge-to-edge; every plugin changes major version | Warnings stay (build machine only); Play not possible | Free | Trial only: builds; Android 15 screens fine |
| D4 | Stop accepting the key **in the web address** | Yes, in two steps | Old app versions put the key where logs can see it | Old app versions (before 25 Oct) would need updating | Small leak risk stays | Free | Yes: a "notice" shows each old-style use; switch tested both ways |
| D5 | **Restrict the Firebase key** in Google Cloud (package + signing fingerprint; Firebase Installations + FCM Registration only) | **Yes** | Stops anyone reusing the key for other Google services | If done wrong, alerts stop until fixed (test an alert after) | Key usable by others for those APIs (within quota) | Free | No (needs your Google account) |
| D6 | Add **Firebase Crashlytics** | **Not now** | Own crash capture now records native crashes free with no new accounts | Sends crash data to Google; needs a build change | Fewer crash details than Crashlytics | Free (please confirm on Firebase's pricing page) | Own capture tested with a real crash |
| D7 | **GitHub paid plan** for branch protection on main | Optional | Stops accidental changes to main | — | Main relies on care (live build/deploy only run from main) | GitHub paid plan | — |
| D8 | **Google Play developer account** | Later | Needed only to publish on Play | — | — | $25 one-off | — |
| D9 | How the **phone test app** connects: separate free test Scan service on your Cloudflare account | **Yes** (option A) | Real-shaped data with zero risk to your live data | Creates a second worker + database on your Cloudflare account | Phone test limited to screens without data | Free within your plan | Test app built (not installed) |
| D10 | **Install the "FlipScout TEST" app** on your phone | When you're ready | Needed for the phone-only checks below | None to your real app (separate package) | Phone-only checks stay untested | Free | Built; can't replace the real app (checked) |
| D11 | Delete other sellers' usernames from old fill history after N days | Your call (privacy) | They're kept forever today | None for deals | Personal data kept longer than needed | Free | — |

## D. Phone-test checklist (when you approve D9 + D10)
Install: open the GitHub run's "FlipScout-TEST-for-phone" download on your phone → tap the file → allow "install unknown apps" for your browser if asked → Install. It appears as **FlipScout TEST** with a red TEST BUILD label. Your real FlipScout is not touched.
Remove afterwards: long-press FlipScout TEST › App info › Uninstall. (A newer test build may need the old one uninstalled first.)

1. **Opening with many deals:** open the TEST app; time from tap to cards (aim under 5 s with 1,500 deals). Scroll quickly top to bottom — note any stutter.
2. **Sorting:** change the sort order 5 times; each should feel instant (under 1 s).
3. **Back deep in the list:** scroll far down, open a deal, press Back — the same deal should be at the top.
4. **Wrong-key recovery (never verified end to end):** Menu › Advanced: Scan connection › paste a setup code with one wrong letter → Deals should say "wrong key" with "Check address and key ›" and "Try again" → fix the key → deals load.
5. **TalkBack:** phone Settings › Accessibility › TalkBack on; swipe through Deals, a deal page and Menu — every button should be read with a clear name. Turn TalkBack off after.
6. **Problems and alerts:** Menu › admin tools (tap the version 7 times) › Problems — open and refresh. (Alerts are off in the TEST app.)
7. **Backup and restore:** add a stock item → Menu › Back up now → uninstall TEST → reinstall → connect → Restore → item back.
8. **Offline and back:** turn on flight mode → open the app (deals still shown, clear message) → flight mode off → after a minute deals refresh.
9. **Restart and data:** change the spend limit → swipe the app away → reopen → limit kept.
10. **Installation safety:** after all this, open your real FlipScout — same data, same version as before.
