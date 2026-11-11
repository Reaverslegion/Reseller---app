# Capacitor 6.2.3 → 8.6.0 upgrade (prepared 9 Nov 2026, branch `claude/capacitor-8-upgrade`, not released)

## Why
`npm audit` reports 5 problems in the phone build's packages: `tar` critical, `@capacitor/cli` high, and `glob`, `minimatch` and `rimraf` moderate. All of them are inside `@capacitor/cli` 6.2.3, which is a build tool on GitHub's machine and is not in the APK. 6.2.3 is the last 6.x release.

The 8.6.0 package set has **no known vulnerabilities**: trial run 42547888563, 9 Nov 2026.

## What changes
| | 6.2.3 (now) | 8.6.0 |
|---|---|---|
| Capacitor core, cli, android | 6.2.3 | 8.6.0 |
| @capacitor/app, push-notifications, app-launcher | 6.0.3, 6.0.5, 6.0.4 | 8.1.2, 8.1.3, 8.0.1 |
| cordova-plugin-inappbrowser | 6.0.1 | 6.0.1 (unchanged) |
| Java (build) | 17 | 21 (all live-build jobs: build.yml, test.yml ×3, phone-test-service.yml ×2) |
| Gradle / Android Gradle Plugin (from Capacitor's template) | 8.2.1 / 8.2.1 | 8.14.3 / 8.13.0 |
| Oldest Android | 5.1 (API 22) | **7.0 (API 24)** |
| Targets | Android 14 (API 34) | **Android 16 (API 36)** |

## What stays the same (checked against Capacitor's source)
- **App ID:** `com.reaverslegion.flipscout`, from the same `cap init` line.
- **Signing:** the same key file and the same settings block. The trial ran the release build with a throwaway key; only the real key differs.
- **Web origin:** `https://localhost`. The default `androidScheme` and `hostname` in `CapConfig.java` are identical in 6.2.3 and 8.6.0, so the app's saved data (localStorage) should survive an update. This still needs proving on a real update.
- **Minimum WebView:** 60 by default, 55 at minimum, the same in both.
- **Plugin features the app uses:** none were removed or changed (method lists compared in each plugin's `definitions.ts`, 6.x vs 8.x):
  - App: backButton, appStateChange, exitApp;
  - Push: register, checkPermissions, requestPermissions, createChannel, and the 4 listeners;
  - AppLauncher: openUrl.
- **Back button:** the app plugin uses Android's `OnBackPressedDispatcher` in both versions, so it's compatible with Android 16's predictive back.
- **Custom crash reporting** (`android-native/CrashInfoPlugin.java`): compiled and was registered in the 8.6.0 trial build.

## Remaining concerns (untested)
1. **Push notifications:** the trial app has Firebase switched off. The 8.x plugin uses one deprecated Android call (a compile notice only).
2. **Cordova in-app browser 6.0.1** under Capacitor 8: it builds, but opening pages ("Check sold prices") hasn't been tested.
3. **Android 16 (API 36):** no emulator check yet. Edge-to-edge layout can't be switched off when targeting 36, and the predictive-back animation applies.
4. **Phones on Android 5.1–6.0** can't install this update. They'd stay on the last Capacitor 6 build.
5. **Updating over the installed app with the real key:** data kept, alerts still registered.
6. **Build notices:** Gradle features that will need updating before Gradle 9 (not an error).
7. The existing "Capacitor 8 trial" job in `test.yml` now just tries the newest 8.x and is no longer needed for this upgrade.
