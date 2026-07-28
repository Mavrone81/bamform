# Slice 21-SHELL — in-app APK update (report)

Branch `feat/slice-21-shell`, worktree `/Users/mavronesamuel/dev/wt-21-shell`,
parent `bbbccec`. **Not merged, not pushed, nothing deployed to production.**

Owner requirement, verbatim: *"key is check if the mobile apk is updated and
allow for update download from form.bevorasg.com/app"*.
Biometrics were **not** implemented — withdrawn by the owner, and
`androidx.biometric` is not a dependency.

---

## 1. What was built

The shell now checks `https://form.bevorasg.com/app/version.json` on launch
(throttled, off the main thread, after the WebView has been told to load),
offers a dismissible strip when a newer `versionCode` exists, downloads the
APK with progress, **verifies it twice before any installer sees it**, and
hands it to Android's own package installer for the user to confirm.

New files:

| File | Role |
|---|---|
| `android/app/src/main/java/com/bamform/shell/UpdateManifest.kt` | the pinned origin constants, the URL trust rule, and a strict manifest parser |
| `android/app/src/main/java/com/bamform/shell/UpdateService.kt` | fetch / download / **SHA-256 gate** / **signer-certificate gate**. No UI, no state |
| `android/app/src/main/java/com/bamform/shell/UpdateController.kt` | throttle, prompt, progress, refusal messages, the single install intent |
| `android/download-page/index.html` | repo copy of `/var/www/form.bevorasg.com/app/index.html`, now manifest-driven |
| `android/release-note.txt` | the one human-written field in the manifest |
| `scripts/ci/assert-shell-update-contract.mjs` | the gate on all of the above |

Changed: `app/build.gradle.kts` (version bump + the manifest-generating task),
`AndroidManifest.xml` (`REQUEST_INSTALL_PACKAGES`), `activity_main.xml` (the
banner), `strings.xml`, `file_paths.xml` (a FileProvider `updates/` path),
`MainActivity.kt` (three lines wiring the controller), `android/README.md`,
`.github/workflows/ci.yml` (one new job-1 step).

**Nothing under `web/` or `api/` was touched** (`git status -- web api` is
empty), so the full web battery was not required; job-1's repo-wide steps were
run anyway and are reported below.

---

## 2. The manifest — format and generation

```json
{
  "versionCode": 2,
  "versionName": "1.2.0",
  "apkUrl": "https://form.bevorasg.com/app/bamform-1.2.0.apk",
  "sha256": "f1e94f87004661856b0a278414049f3913ec9e456f30d5bb95192357fcc985a3",
  "sizeBytes": 2626630,
  "releaseNote": "Adds in-app update checking: the app now finds new releases itself and verifies them before installing.",
  "releasedAt": "2026-07-28T10:39:23Z"
}
```

It is produced by the Gradle task **`:app:generateReleaseUpdateManifest`**,
which `assembleRelease` is `finalizedBy` — you cannot produce a release
without it. The task reads the APK through AGP's variant artifact API
(`SingleArtifact.APK` + `BuiltArtifactsLoader`), not a hard-coded output path,
so `versionCode` and `versionName` come out of the binary's own build
metadata; `sha256` and `sizeBytes` are computed from the **published copy**
after it is staged; and the task re-hashes that copy afterwards and fails if
it disagrees with what it just wrote. Output:

```
android/app/build/dist/
  bamform-1.2.0.apk
  version.json
  index.html
```

### Why this had to be mechanised — the drift already existed

The page live at `form.bevorasg.com/app` links to `bamform-1.1.apk` and its
footer reads `v1.1`, with `SHA-256 a2e921cb…`. The binary it links to carries
**`versionName 1.0.0` / `versionCode 1`**. Two hand-maintained descriptions of
one artefact had already disagreed, and nothing could notice. Cosmetic until
now; once an installed app decides whether to download *new code* from that
description, a manifest that overstates the version offers an update that does
not exist and one that understates it hides an update that does. So: nothing
about the current release is written by hand anywhere, and the CI gate refuses
a page that hard-codes an APK filename or a checksum.

`https://form.bevorasg.com/app/version.json` currently returns **404**
(checked). Devices running 1.2.0 will therefore find no update, silently,
until the controller deploys the staged directory — which is the correct
degraded state, not a failure.

### The download page reads the same file

`android/download-page/index.html` keeps the existing design and fills its
version label, download link, size, checksum, release note and `<title>` from
`version.json` at load time. It also applies the app's origin rule: an
`apkUrl` that is not on this server is refused. If the manifest is missing or
malformed the page **offers no download link at all** and says why — a
visibly broken page beats a stale link that hands someone the wrong binary and
looks fine doing it.

No browser extension was available, so the page's **real `<script>` block was
extracted from the real file and executed under Node against the real
generated manifest** (`scratchpad/page-check.mjs`, exit `0`):

```
=== HAPPY PATH — real generated version.json ===
eyebrow  : Version 1.2.0 · Ready to install
cta href : /app/bamform-1.2.0.apk
size     : <b>2.5 MB</b>
footer v : v1.2.0 (build 2)
footer sh: SHA-256 f1e94f87004661856b0a278414049f3913ec9e456f30d5bb95192357fcc985a3
title    : BamForm 1.2.0 for Android

=== FAILURE PATH — manifest missing (404) ===
eyebrow  : Release manifest unavailable       cta href : (none)   aria-disabled: true

=== HOSTILE PATH — apkUrl points off this server ===
eyebrow  : Release manifest unavailable       cta href : (none)   aria-disabled: true
```

That is *not* the same as rendering it in a browser; see §8.

---

## 3. The security design, and what it is defending against

### 3.1 The update origin is pinned and is NOT the configured content origin

`UpdateManifest.UPDATE_ORIGIN = "https://form.bevorasg.com"` is a compile-time
constant. It is deliberately **not** `ServerConfig.get(context)`.

The shell lets an admin point the WebView at any host, including a cleartext
plant IP — `network_security_config.xml` permits cleartext **globally** and
the README already tells provisioners to assume an on-path attacker can
rewrite every byte on such a LAN. If the update source followed that origin,
that same attacker (or a compromised plant server, or an admin) would choose
which APK a technician is invited to install. Serving pages and shipping code
are not the same privilege and must not share a control.

Layers:

1. `UPDATE_ORIGIN` / `MANIFEST_URL` are constants; there is no runtime setting.
2. `form.bevorasg.com` is pinned `cleartextTrafficPermitted="false"` in
   `network_security_config.xml`, so nothing downgrades it.
3. Both `fetchManifest()` and `download()` assert the connection is an
   `HttpsURLConnection` and set `instanceFollowRedirects = false` — a 30x is
   how a request pinned to an origin ends up elsewhere.
4. `isTrustedUpdateUrl()` re-derives the download target from the constants:
   authority-anchored prefix (`UPDATE_ORIGIN + "/app/"`, which is what rejects
   `https://form.bevorasg.com.attacker.example/app/…`), `scheme == https`,
   `host == UPDATE_HOST`, no userinfo, no `..`, no query/fragment, no
   backslash or `@`, path ends `.apk`.
5. `download()` re-checks that predicate **before** it opens a connection —
   `parse()` having checked it is not enough, because this is the last
   statement before an outbound request built from network-supplied text.

### 3.2 Two gates before the installer

`UpdateService.download()` only ever returns `DownloadOutcome.Ok(file)` after
both:

- **GATE 1 — SHA-256.** The stream is digested as it lands and compared to the
  manifest. Mismatch → the directory is deleted and `Refused` is returned.
  This catches truncation, a caching proxy serving a stale APK, and any
  substitution of the *file* alone.
- **GATE 2 — the signing certificate.** `getPackageArchiveInfo` reads the
  downloaded archive; the shell checks its `packageName` equals its own, its
  `versionCode` equals the manifest's, and that its signing certificate
  digests **intersect the running app's own**. Mismatch → deleted, `Refused`.

Gate 2 is the one that matters against a *forged manifest*: an attacker who
fully controls the web server can publish a manifest whose `sha256` honestly
describes their own APK, and gate 1 passes. Gate 2 does not, because
producing an APK that presents BamForm's certificate requires the release
keystore, not a foothold on a web server. **This is measured below, not
asserted.**

`UpdateController.launchInstaller()` sources its file from `verifiedApk`,
which is assigned only from `DownloadOutcome.Ok`. The
`application/vnd.android.package-archive` intent appears exactly **once** in
`android/app/src` (asserted by the gate).

### 3.3 No silent install, and no pretence of one

`FileProvider` + `ACTION_VIEW` + `FLAG_GRANT_READ_URI_PERMISSION`. The user
confirms in Android's own installer. `REQUEST_INSTALL_PACKAGES` grants the
right to *ask*; if the app-op is off, the shell says so and offers to open
`Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` rather than failing opaquely.
The download lives in the app-private cache under `updates/`, and that
directory is wiped before every download so a refused file is never left where
a later grant could reach it (verified on device: after both refusals the
directory is **gone**).

### 3.4 The bridge is untouched, and the page cannot drive any of this

No message type was added to `ShellBridge`. The origin allow-list
(`setOf(configuredOrigin)`) and the four `onPostMessage` guards are unchanged;
`assert-shell-protocol-contract.mjs` still passes unmodified (exit `0`), and
the new gate additionally fails if `ShellBridge.kt` so much as mentions the
update path. A page — or anything that reaches a page — cannot start a check,
a download or an install.

---

## 4. Throttle and failure behaviour

| | |
|---|---|
| When | posted **4 s** after `webView.loadUrl`, on a dedicated single-thread executor. Never on the main thread, never awaited |
| How often | once per **6 h**, persisted in `SharedPreferences("bamform_update")` as `last_check_at` |
| Clock | wall-clock, not `SystemClock` uptime — uptime resets on reboot, and a tablet rebooted every shift would check on every boot. A clock that moves *backwards* is treated as "due" rather than locking the device out |
| Prompt | a dismissible strip at the foot of the page. **Not a modal** — an update must never stand between a technician and the record they are filling in |
| "Not now" | records the dismissed `versionCode`; that version stops asking, the next release asks once |
| Already current | any earlier dismissal is cleared, so a future release prompts again |

Failure behaviour, by path:

| Path | Behaviour |
|---|---|
| offline / DNS / TLS / 404 / malformed JSON / manifest that fails validation | **nothing is shown at all.** The technician never learns a check happened |
| `apkUrl` off the pinned origin | manifest rejected wholesale → treated as "no update" → nothing shown |
| download fails (HTTP ≠ 200, socket error, too large) | one quiet line: what happened, "nothing was installed", Dismiss |
| user cancels | banner disappears, partial file deleted |
| **hash mismatch / signer mismatch / wrong package / wrong versionCode** | **loud**: "Update refused", the two digests, "it has been deleted and nothing was installed… tell IT". No auto-retry — retrying against a substituted file is just a slower way to be attacked |
| no installer / no permission | explained, with a route to the settings screen |

---

## 5. Emulator evidence

AVD `bamform-test`, Pixel 6, Android 14 / API 34 arm64, headless.

**Harness.** The update origin is a pinned HTTPS constant, so the honest way
to exercise it without weakening the code was to intercept the network rather
than special-case the app: `adb root` + `-writable-system`, a test CA
(`CN=BamForm Emulator Test CA`) installed into `/system/etc/security/cacerts`
**and** bind-mounted into `/apex/com.android.conscrypt/cacerts` in init's and
zygote's mount namespaces (Android 14 reads the APEX store), `10.0.2.2
form.bevorasg.com` in `/system/etc/hosts`, and an `iptables -t nat OUTPUT`
DNAT from `:443` to `:8443` where a local Node HTTPS server served a leaf cert
for `form.bevorasg.com`. **The APK under test was the unmodified signed
release build.** Nothing in the app was changed to make the test work.

**Harness cleaned up afterwards**: the test CA was removed from
`/system/etc/security/cacerts`, `/system/etc/hosts` restored, the DNAT rule
deleted, and the emulator killed. Note that `bamform-test` was started with
`-writable-system` and `adb remount` (dm-verity disabled, overlayfs on
`/system`); that overlay persists in the AVD directory and should be treated
as a modified test image — `-wipe-data` does not undo it.

Because two builds are needed to demonstrate an upgrade, the demo published a
`1.3.0` / `versionCode 3` release built from this same tree; the committed
release is `1.2.0` / `versionCode 2`, and the version bump was reverted before
the final build (§6).

### 5.1 Happy path — prompt → download → verify → install

```
18:31:16  app launched (versionCode 2 installed)
10:31:21  GET /app/version.json -> 200          ← ~5 s after launch, off the main thread
          banner: "BamForm 1.3.0 is available / You are running 1.2.0. Demo release: …"
                  [Not now] [Download update]                     shot1-prompt.png
10:31:44  GET /app/bamform-1.3.0.apk -> 200     (2,626,630 bytes)
          banner: "BamForm 1.3.0 is ready / Checksum verified (51796d5b8693…) and the
                   file is signed with this app's own key. Tap Install and confirm in
                   Android's installer."         [Not now] [Install]   shot3-verified.png
          cache: /data/data/com.bamform.shell/cache/updates/bamform-update.apk (2,626,630)
```

`51796d5b8693…` is the first 12 hex of the manifest's `sha256`
`51796d5b86933161cd97b05ce16ac7ad2719fe8b5b06b07c45827c18cfa4589a`, which is
what `shasum -a 256` reports for the served file.

Tapping **Install** with the app-op off produced the permission panel —
*"Android needs your permission … Open settings"* (`shot4-install.png`) — and
no intent. After `appops set com.bamform.shell REQUEST_INSTALL_PACKAGES allow`
the same tap reached the platform installer:

```
topResumedActivity=com.google.android.packageinstaller/…PackageInstallerActivity
dialog: "BamForm — Do you want to update this app?  [Cancel] [Update]"   shot6-installer.png
```

Confirming it:

```
$ adb shell dumpsys package com.bamform.shell | grep version
    versionCode=3 minSdk=26 targetSdk=34
    versionName=1.3.0
```

In-place upgrade, same keystore, no uninstall.

### 5.2 Refusal — deliberate wrong SHA-256

Published `1.4.0` / code 4 honestly, then edited **only the served manifest**
so the first 8 hex of `sha256` read `deadbeef` (the APK itself was genuine and
correctly signed — this is what a substituted or corrupted download looks like
from the device).

```
10:34:32  GET /app/version.json  -> 200
10:34:41  GET /app/bamform-1.4.0.apk -> 200      ← the bytes did arrive
banner: "Update refused
         The downloaded file does NOT match the checksum published for BamForm 1.4.0
         (expected deadbeefbe95…, got b390d420be95…). It has been deleted and nothing
         was installed. Retry later; if this happens again, tell IT — the download may
         have been altered in transit."          [Dismiss]      shot8-refused-hash.png

$ adb shell ls /data/data/com.bamform.shell/cache/updates/
ls: …/cache/updates/: No such file or directory      ← deleted
```

`b390d420…` is the real digest of the served APK. **No Install button was
ever offered.**

### 5.3 Refusal — forged manifest + differently-signed APK (gate 2)

The stronger attack: an attacker who controls the web server completely.
`1.5.0` / code 5 was built and signed with a throwaway keystore
(`CN=Not BamForm`, `apksigner` digest
`5a8bc9cbee82c23eebae6d98db6b618e9aab79ccd9bed1fcce9ee58f82c30323`), and the
manifest was generated **honestly** for it — `sha256`
`4c2dd58184cbf691f67305ca2bfd91ae69bcaa39b2c5a50c69429fe104476527`, exactly
what `shasum` reports for the served file. Gate 1 therefore *passes*.

```
10:36:07  GET /app/version.json      -> 200
10:36:17  GET /app/bamform-1.5.0.apk -> 200
banner: "Update refused
         The downloaded file is signed with a DIFFERENT key from this app
         (5a8bc9cbee82… vs 4d7af2bbfb31…). It has been deleted and nothing was
         installed. Do not install BamForm from anywhere else — tell IT."
                                                  [Dismiss]   shot9-refused-signer.png

$ adb shell ls /data/data/com.bamform.shell/cache/updates/
ls: …/cache/updates/: No such file or directory
```

`4d7af2bbfb31…` is BamForm's real signer digest. A correct hash of the wrong
binary is not enough to reach the installer.

### 5.4 Refusal — manifest pointing off the pinned origin

Manifest re-published as `1.6.0` / code 6 with
`apkUrl: "https://form.bevorasg.com.attacker.example/app/bamform-1.6.0.apk"`
— a host that *contains* the real one:

```
10:36:59  GET /app/version.json -> 200        ← the manifest was fetched
uiautomator dump: no update UI of any kind on screen
```

`isTrustedUpdateUrl` rejected the URL, `parse()` returned null, the check
degraded to "no update". Nothing was requested from the attacker host.

### 5.5 Throttle

Three consecutive launches (force-stopped between each, prefs left alone):

```
manifest GETs before=5 after=6  delta=1 across 3 launches
/data/data/com.bamform.shell/shared_prefs/bamform_update.xml
  <long name="last_check_at" value="1785235050073" />
```

### 5.6 Update host down

Server killed, throttle reset, app launched:

```
update UI found: []            ← nothing rendered
app still running: 1
prefs after failed check: last_check_at = 1785235097514   ← stamped anyway
```

The app booted and stayed usable. Note the stamp is written **before** the
fetch, so a failed check consumes the window — deliberate (a permanently
unreachable host otherwise means a request on every single launch), and called
out in §9.

---

## 6. Measured numbers, with exit codes

Exit codes captured directly (`; echo "X=$?"`), never through a pipe.
Node **v22.23.1** / npm **10.9.8**; JDK 17.0.20; Android SDK build-tools
34.0.0; Gradle 8.9 / AGP 8.5.2 / Kotlin 1.9.24.

| Gate | Result | Exit |
|---|---|---|
| `./gradlew --no-daemon clean assembleRelease lint` | BUILD SUCCESSFUL in 22 s, 75 tasks; `lint-results-debug.txt` = **"No issues found."** | `0` |
| `apksigner verify -v --print-certs` (final APK) | v1 `false`, **v2 `true`**, **v3 `true`**; `CN=BamForm`, RSA 4096 | `0` |
| `node scripts/ci/assert-shell-protocol-contract.mjs` | PASS, unchanged | `0` |
| `node scripts/ci/assert-shell-update-contract.mjs` | PASS | `0` |
| same, **29 mutations** | **29/29 red**; sources restored bit-identical (`shasum -c` 8/8 OK); gate green again | `1` ×29 |
| `npm run lint -- --max-warnings=0` | — | `0` |
| `npm run format:check` | — | `0` |
| `npm run typecheck` | — | `0` |
| `bash scripts/ci/assert-no-vite-secrets.sh` | — | `0` |
| `bash scripts/ci/assert-env-example-complete.sh` | — | `0` |
| `node scripts/ci/assert-compose-runtime-contract.mjs` | — | `0` |
| `node scratchpad/page-check.mjs` (download page, 3 paths) | as quoted in §2 | `0` |
| `git status --short -- web api` | **empty** | — |
| `git diff HEAD -- package-lock.json package.json '*/package.json'` | **empty — zero npm deps added, lockfile byte-identical** | — |

`git diff origin/main -- api/package.json` shows one line, but
`git diff HEAD -- api/package.json` is empty: `origin/main` has moved to
`b811f81` since this worktree branched from `bbbccec`. Not this slice's change.

**Gradle dependencies: unchanged.** No new Gradle dependency either — the
whole feature uses `java.net`, `java.security`, `org.json` and
`androidx.core`'s `FileProvider`, all already present.

### Fail-closed on a pristine checkout

Re-run against `git archive HEAD | tar -x` into a clean directory — exactly
what `actions/checkout` produces, i.e. **no `android/keystore/`, no
`android/local.properties`**, `ANDROID_HOME` only:

```
keystore present?  No such file or directory
local.properties?  No such file or directory
job-12 guard step                          : OK: no signing material in the checkout
node assert-shell-update-contract.mjs      : PASS                       exit 0
node assert-shell-protocol-contract.mjs    : PASS                       exit 0
./gradlew --no-daemon assembleDebug lint   : BUILD SUCCESSFUL in 22 s,
                                             48 actionable tasks: 48 executed   exit 0
lint-results-debug.txt                     : "No issues found."
app-debug.apk                              : 3,323,394 bytes
```

`assembleDebug` deliberately does **not** run the manifest task (the variant
selector is release-only), so CI job 12 still needs no signing material.

### New APK

- **Path**: `/Users/mavronesamuel/dev/wt-21-shell/android/app/build/dist/bamform-1.2.0.apk`
  (identical bytes to `app/build/outputs/apk/release/app-release.apk`;
  also staged, with `version.json` and `index.html`, at
  **`/Users/mavronesamuel/dev/bamform-app-dist/`** — that directory is the
  exact intended contents of `/var/www/form.bevorasg.com/app/`, **not
  deployed**)
- **SHA-256**: `f1e94f87004661856b0a278414049f3913ec9e456f30d5bb95192357fcc985a3`
- **Size**: 2,626,630 bytes (was 2,600,622 for versionCode 1)
- **versionCode 2, versionName 1.2.0**, minSdk 26, targetSdk 34
- **Signer certificate SHA-256
  `4d7af2bbfb31825c36ae30c9e5f00fa61cafa717e112c9f2b68b9ec85908feea`
  — identical to the currently published build**, so installed devices upgrade
  in place and keep their data. v2 **and** v3 both verify.

The keystore was copied into `android/keystore/` (gitignored) for the build
and is unchanged; `keystore.properties` was temporarily repointed at a
throwaway keystore to produce the §5.3 attack APK and **restored** — verified
by the final build carrying the real certificate digest above.

---

## 7. The CI gate

`scripts/ci/assert-shell-update-contract.mjs`, added to **job 1 · Static
analysis** beside the existing bridge gate. Pure Node, no Gradle, no SDK, no
network. Same house style: anchored extractions, comments stripped before any
code assertion, **a failed extraction is a failure**.

It asserts: `UPDATE_ORIGIN` is a bare `https://` origin and `UPDATE_HOST` /
`MANIFEST_URL` agree with it; the Gradle publisher writes `apkUrl`s on that
same origin; `isTrustedUpdateUrl` keeps its four rules; none of the three
update sources references `ServerConfig` / `configuredOrigin` /
`currentOrigin`; `download()` checks the URL **before** `openConnection`,
hashes and compares to `manifest.sha256`, calls `verifyApkIdentity`, and does
both **before** any `DownloadOutcome.Ok`, and deletes the directory on
failure; neither fetch follows redirects and both assert `HttpsURLConnection`;
`verifyApkIdentity` keeps its package and signer comparisons; the
package-archive MIME appears exactly once in `android/app/src` and
`launchInstaller` reads only `verifiedApk`, which is only assigned from
`outcome.file`; `ShellBridge.kt` mentions nothing about updates;
`REQUEST_INSTALL_PACKAGES` is declared; the update host stays HTTPS-pinned;
the download page hard-codes no APK filename and no 64-hex checksum and still
reads `version.json`; and the Gradle task still derives every field from the
built artefact with `finalizedBy` on `assembleRelease`.

**Mutation evidence — 29 mutations, 29 caught, 0 missed**, each applied to the
real source, gate run, source restored:

```
M1  UPDATE_ORIGIN downgraded to http://              M16 verifyApkIdentity: package check removed
M2  UPDATE_ORIGIN repointed at another host          M17 installer fed from an unverified file
M3  MANIFEST_URL moved off the pinned origin         M18 verifiedApk assigned from an unchecked source
M4  isTrustedUpdateUrl: prefix test deleted          M19 bridge grows an update message type
M5  isTrustedUpdateUrl: https check deleted          M20 REQUEST_INSTALL_PACKAGES undeclared
M6  isTrustedUpdateUrl: host check deleted           M21 update host no longer HTTPS-pinned
M7  isTrustedUpdateUrl: userinfo check deleted       M22 download page hard-codes an APK filename
M8  update source steered by ServerConfig            M23 download page hard-codes a checksum
M9  download: origin re-check removed                M24 download page stops reading version.json
M10 download: hash comparison removed                M25 Gradle publishes to a different origin
M11 download: verifyApkIdentity call removed         M26 manifest versionCode hand-supplied
M12 download: follows redirects                      M27 manifest sha256 no longer from the APK
M13 fetchManifest: follows redirects                 M28 assembleRelease no longer generates it
M14 download: refused file left on disk              M29 UpdateService.kt emptied (fail-closed)
M15 verifyApkIdentity: signer comparison removed
```

**What it does not do:** it is static text analysis. It proves the checks are
present and ordered; it does not execute them. A change that keeps the lines
but breaks their meaning (redefining `isTrustedUpdateUrl` to `return true`)
passes — assertion 3 pins that function's own body precisely because of that,
but the limitation is general. The runtime evidence is §5, and it is manual.

---

## 8. Deviations from the brief

1. **`sizeBytes` added to the manifest.** The brief listed six fields; this is
   a seventh, derived from the binary, used by the download page to show the
   size. The app's parser ignores it (and ignores any unknown key).
2. **A new CI gate + one `ci.yml` step**, which is outside "`android/` only".
   The brief says to keep `assert-shell-protocol-contract.mjs` honest; I did
   not touch the protocol, so that gate is unchanged and passing. But this
   slice adds a *code-delivery channel* whose entire safety is a handful of
   lines a compiler is happy without — the exact shape of hole R-1 found in
   the bridge. Leaving it ungated seemed worse than the scope deviation.
3. **`versionCode 1 → 2`, `versionName "1.0.0" → "1.2.0"`.** A version bump is
   needed for any installed device to see an update at all. `1.2.0` avoids
   colliding with the "v1.1" label the published page attached to
   `versionCode 1`.
4. **`android/download-page/index.html` is new.** No repo copy existed; I took
   the live page verbatim and made only the version-dependent parts
   manifest-driven, plus one new "Updating later" card. The live page is
   **not** modified — the staged copy is for the controller to deploy.
5. **`android/release-note.txt` is new** — the only hand-written manifest
   field, kept in the repo so it goes through review.
6. **One new lint suppression**: `tools:ignore="ButtonStyle"` on the banner's
   button row, justified at the site (borderless button-bar styling is a
   dialog convention; these must match the offline card and the PWA tokens).
   Lint is still **"No issues found."**
7. **The emulator harness required rooting the AVD** and installing a test CA,
   rather than pointing the app somewhere convenient. That was the choice that
   kept the *shipped* code identical to the code under test.

---

## 9. Honest concerns

- **Gate 2 leans on `getPackageArchiveInfo`.** It parses the archive and
  collects signing certificates — an unsigned or structurally corrupt APK
  yields null — and the platform verifies v3 signing blocks including the
  rotation lineage. I did **not** independently verify how much cryptographic
  verification it performs on every OS version, and I do not claim it is a
  re-implementation of the installer. The SHA-256 is the primary integrity
  check; gate 2 is a *binding* to our keystore, and the platform installer
  verifies again afterwards. I used `signingCertificateHistory` (falling back
  to `apkContentsSigners`) so a future v3 key rotation still upgrades; that
  accepts a lineage, and a lineage's trustworthiness is the platform parser's
  claim, not mine.
- **The throttle stamp is written before the fetch.** A device that is offline
  at every launch checks at most once per 6 h — but a *failed* check also
  consumes the window, so a device that is briefly offline at the wrong moment
  waits 6 h for the next attempt. The alternative (stamp on success) means a
  request on every launch whenever the host is unreachable, which is worse on
  a plant LAN. Judgement call.
- **The check only runs in `onCreate`.** An app that is never killed never
  re-checks. Given the shell is restarted constantly on shared tablets this is
  probably fine, but it is not a background job and does not pretend to be.
- **The banner overlays the bottom of the page** until dismissed. If the web
  app ever grows a fixed bottom bar, they will collide. I did not add insets
  to the WebView because that would reflow the PWA.
- **No resume, no retry, no backoff on the download.** A 2.6 MB file on a
  flaky plant network that drops at 90 % starts again from zero. Adding Range
  resumption interacts with the hash gate (you must hash the whole file after
  reassembly, which is fine) and with the "refuse loudly" rule (a resumed
  download that fails the hash is ambiguous between corruption and
  substitution). Deliberately not built.
- **A user who taps "Not now" is never asked again for that version.** There
  is no "remind me later", and no admin-side way to force an update. On a
  fleet where updates matter that is a real gap; it needs an MDM or a
  server-side minimum-version signal, neither of which exists.
- **Deleting the whole `updates/` directory on every download** means a
  concurrent second download would clobber the first. `downloading` guards the
  UI path, but nothing structural prevents it if the class grows a second
  entry point.
- **The manifest is fetched with no cache-busting.** An intermediary that
  caches `version.json` aggressively could hide a new release. Not an integrity
  problem (the hash still gates), but a liveness one.
- **`form.bevorasg.com/app/version.json` is currently 404**, so this build's
  own update check does nothing until the staged directory is deployed.
- **Signing material is present in `android/keystore/` in this worktree**
  (gitignored, never committed, and CI refuses to build if it appears in a
  checkout). It should be removed when the worktree is cleaned.
- **The 4 s delay and 6 h interval are guesses**, not measurements. They are
  constants in `UpdateController` and easy to change.

---

## 10. What only a physical device can confirm

- **The install-unknown-apps flow on a real OEM skin.** Samsung/Honeywell
  rugged tablets route `ACTION_MANAGE_UNKNOWN_APP_SOURCES` differently, and
  some MDM profiles disable `REQUEST_INSTALL_PACKAGES` outright — on such a
  fleet this feature degrades to "the banner explains, and nothing installs".
  I could not test that.
- **Whether an OEM package installer honours the FileProvider read grant** for
  a cache-dir URI. The AOSP installer did.
- **Real TLS against the real `form.bevorasg.com`.** The emulator used a test
  CA and a DNAT; certificate-chain behaviour, HSTS, and any CDN in front of
  the host are untested from a device.
- **A real flaky network**: partial reads, mid-download connectivity loss,
  captive portals returning 200 with HTML where an APK was expected (the hash
  gate would refuse it loudly — untested).
- **Storage pressure.** A nearly-full tablet failing mid-write hits
  `update_failed_storage`; not reproduced.
- **In-place upgrade preserving real data.** The emulator upgraded
  versionCode 2 → 3 in place, but I did not seed a real login and a populated
  IndexedDB outbox first, so "the unsent records survived" is inferred from
  the platform guarantee, not measured.
- **A device whose clock is badly wrong**, which affects both the throttle and
  TLS.
- Everything on the previous slice's physical-device list is unchanged.

---

Committed on `feat/slice-21-shell`. Not merged, not pushed, nothing deployed.
