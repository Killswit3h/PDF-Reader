# iPad / iPhone via TestFlight — automated setup

This app already runs on Android by loading the desktop renderer verbatim inside
a Capacitor WebView. **iOS is the same target with a different shell**: `cap add
ios` wraps the identical `www/` bundle in a WKWebView. This doc covers the iOS
build + **fully automated TestFlight delivery** so you never touch Xcode for a
routine release.

> **TL;DR of the workflow once set up:** merge a PR to `main` → GitHub Actions
> builds, signs, and uploads a new build to TestFlight → your iPad's TestFlight
> app notifies you and installs it. No App Review, no manual steps, no public
> App Store release.

---

## What's automated in this repo

| Piece | File | Does |
|---|---|---|
| iOS Capacitor target | `capacitor.config.json` (`ios` block), `@capacitor/ios` dep | wraps `www/` in a WKWebView |
| npm scripts | `package.json` (`ios:add/sync/open/beta`) | mirror the `android:*` scripts |
| App icon | `build/make-ios-icons.js` | opaque, no-alpha 1024² AppIcon from the FieldMark artwork |
| Info.plist keys | `build/patch-ios.js` | export-compliance exemption + Files-app visibility |
| Signing + upload | `fastlane/Fastfile`, `fastlane/Appfile`, `Gemfile` | `match` certs → archive → TestFlight |
| CI | `.github/workflows/ios.yml` | unsigned build-check on every PR; TestFlight upload on `main` |
| No self-update on iOS | `src/renderer/js/platform-web.js` (`checkUpdates`) | TestFlight owns updates |

Like `android/`, the generated `ios/` project is **git-ignored** and rebuilt from
config on every run — so there's no Xcode project to hand-maintain.

> **Why CocoaPods, not SPM:** the `ios:*` scripts and CI pass
> `cap add ios --packagemanager CocoaPods`. Capacitor 8 otherwise defaults to a
> Swift Package Manager project, whose resolver pulls the Capacitor Swift
> packages from remote sources and can select versions incompatible with the
> plugin sources pinned in `node_modules` (a real build break we hit — e.g. the
> Share plugin against a mismatched core). CocoaPods references the local pinned
> podspecs, so the build uses exactly the versions in `node_modules`. It also
> produces `App.xcworkspace`, which the build/fastlane steps target.

---

## One-time setup (the only manual part — ~30 min)

These steps need a human with an Apple account; everything after is hands-off.

### 1. Apple Developer Program
Enrol at <https://developer.apple.com/programs/> ($99/yr). Note your **Team ID**
(Membership page, 10 chars) → this becomes the `APPLE_TEAM_ID` secret.

### 2. Register the app
In [App Store Connect](https://appstoreconnect.apple.com/) → **Apps → +** create
an app with bundle id **`com.pdfsigner.app`** (matches `capacitor.config.json`).
You do **not** need to fill store metadata or ever click "Submit for Review" —
TestFlight works on an app record that's never publicly released.

### 3. App Store Connect API key (for unattended auth — no 2FA)
App Store Connect → **Users and Access → Integrations → App Store Connect API →
+**. Role **App Manager**. Download the `.p8` (once only). Record:
- **Key ID** → `ASC_KEY_ID`
- **Issuer ID** (top of the page) → `ASC_ISSUER_ID`
- the `.p8`, base64-encoded → `ASC_KEY_P8_BASE64`
  ```bash
  base64 -i AuthKey_XXXXXXXX.p8 | tr -d '\n'
  ```

### 4. A private `match` repo for signing assets
`match` stores the encrypted distribution certificate + provisioning profile in a
git repo so CI can sign reproducibly. Create an **empty private repo** (e.g.
`Killswit3h/ios-certs`) → its URL becomes `MATCH_GIT_URL`.

Then, once, from a Mac with this repo checked out:
```bash
bundle install
# choose a strong passphrase → this becomes MATCH_PASSWORD
export MATCH_PASSWORD='…'
bundle exec fastlane match appstore \
  --git_url "https://github.com/<you>/ios-certs.git" \
  --app_identifier com.pdfsigner.app \
  --api_key_path <(echo) # or log in interactively the first time
```
This generates and commits the encrypted cert/profile. CI later pulls them
read-only (the Fastfile uses `readonly: true`).

For CI to clone that private certs repo over HTTPS, create
`MATCH_GIT_BASIC_AUTHORIZATION`:
```bash
echo -n "<github-username>:<a-PAT-with-repo-scope>" | base64
```

### 5. Add the GitHub secrets
Repo **Settings → Secrets and variables → Actions → New repository secret**, add
all seven:

| Secret | From |
|---|---|
| `APPLE_TEAM_ID` | step 1 |
| `ASC_KEY_ID` | step 3 |
| `ASC_ISSUER_ID` | step 3 |
| `ASC_KEY_P8_BASE64` | step 3 |
| `MATCH_GIT_URL` | step 4 |
| `MATCH_PASSWORD` | step 4 |
| `MATCH_GIT_BASIC_AUTHORIZATION` | step 4 |

### 6. Add yourself as an internal tester
App Store Connect → your app → **TestFlight → Internal Testing → +**, add your
Apple ID. Internal testers get every build **with no Beta App Review**, live
minutes after upload. Install the **TestFlight** app on your iPad and sign in.

That's it. From here it's automatic.

---

## The everyday loop (zero manual steps)

1. Do your work on a feature branch, open a PR (the repo's golden workflow).
   - The **build-check** CI job compiles the iOS app unsigned on every push, so
     breakage is caught before merge.
2. Merge the PR to `main`.
   - The **testflight** CI job builds, signs (`match`), stamps the build number
     (`github.run_number`) and marketing version (`package.json`), and uploads.
3. Minutes later, TestFlight on your iPad shows the new build → tap **Update**.

Want a build without merging? Actions → **iOS → Run workflow** (manual dispatch).

### Versioning
- **Marketing version** = `version` in `package.json` (one source of truth,
  shared with the web/Android builds). Bump it when you want a new visible version.
- **Build number** = the CI run number, so every upload is unique and increasing
  (TestFlight requires this). No manual bumping.

### Notes
- **90-day expiry:** each TestFlight build expires 90 days after upload. Since you
  upload on every merge, the latest build is always fresh.
- **Up to 100 internal testers**, ~30 devices each — plenty for your own iPads.
- **No public release, ever:** submitting to TestFlight and "Release to the App
  Store" are separate actions. You can stay on TestFlight indefinitely.

---

## Local builds (optional, needs a Mac)

```bash
npm ci
npm run ios:add     # first time: generate the native ios/ project
npm run ios:open    # open in Xcode → Run on a simulator or connected iPad
# or, to push a TestFlight build from your Mac (needs the env vars from above):
npm run ios:beta
```

## Alternative: ad-hoc (no TestFlight, fixed devices)
If you'd rather skip Apple's servers for a fixed set of your own iPads, register
each device's UDID and use `export_method: "ad-hoc"` to produce an installable
`.ipa` — no review, no expiry mid-year, but you re-sign yearly and manage UDIDs
yourself. TestFlight is smoother for frequent iteration, which is why it's the
default here.
