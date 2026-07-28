# BamForm Android shell

A minimal native wrapper around the BamForm PWA. The web app remains the
product; this APK adds exactly three things:

1. **An admin-configurable server address.** The shell boots straight into
   the WebView at the configured origin (default `https://form.bevorasg.com`,
   last-used origin persisted). The server is re-pointed from **inside the
   web app's sign-in screen**: the shell registers an **origin-scoped message
   channel** named `BamFormShell` (`WebViewCompat.addWebMessageListener`,
   allow-list = the configured origin only), and the sign-in card shows a
   collapsed "Server" disclosure **only when that channel exists** — in a
   normal browser the control is absent from the DOM entirely. Every switch
   is health-checked natively against `<url>/api/v1/healthz` before anything
   is persisted or loaded, so the app is never stranded on a dead origin, and
   switching away from a server whose offline outbox still holds unsent
   records requires an explicit confirmation that names the count.
2. **A WebView that runs the PWA faithfully** — service workers, IndexedDB
   (the offline outbox), persistent cookies (the HttpOnly refresh cookie is
   flushed to disk on stop, so restarts keep the session exactly like
   Chrome would), photo capture via the file chooser (camera intent wired,
   CAMERA runtime permission), back button walks WebView history, external
   links open in the system browser, renderer crashes recreate the activity,
   and an unreachable server — or one answering the main frame with an HTTP
   5xx, e.g. a proxy mid-deploy — shows a native card (Retry + server field;
   the error path needs a native field because the sign-in page that hosts
   the normal control is served by the very server that is unreachable).
3. **An in-app update check.** Every *web* change reaches devices on deploy;
   only a change to this shell needs a new APK, and without this the only
   route was walking to each tablet. The app polls
   `https://form.bevorasg.com/app/version.json` (throttled, never blocking
   startup), offers a dismissible prompt when a newer build exists, downloads
   it, **verifies the published SHA-256 and the signing certificate before
   the installer sees the file**, and lets the user confirm the install. See
   "In-app updates" below.

## What the shell does NOT do

- **No authorisation, no tokens.** Authz stays server-side. The shell
  stores exactly one string: the server origin. Session state lives in the
  WebView's own cookie jar / IndexedDB, as it would in any browser.
- **No offline logic of its own.** Offline behaviour is the PWA's service
  worker + outbox.
- **iOS is not covered.**

## Security notes — read before provisioning devices

### The JS channel is origin-scoped, and that is load-bearing

The first build of this shell used `addJavascriptInterface`. An adversarial
review demonstrated on an emulator that such an interface is injected into
**every frame** of the WebView and cannot express an origin rule: a
cross-origin `<iframe>` reached it with zero user interaction and
permanently re-pointed the app at an attacker's server, and a cross-origin
form **POST** did the same to the main frame (`shouldOverrideUrlLoading` is
not called for POST navigations, so navigation interception could never have
confined it).

The channel is now `WebViewCompat.addWebMessageListener` with an allow-list
of exactly one origin — the configured one, re-registered on every switch —
so the `window.BamFormShell` object is **created only in documents from that
origin**. The listener additionally refuses subframes (the allow-list is
origin-scoped, *not* frame-scoped: an attacker page that embeds the
configured origin in an `<iframe>` really does get a live
`window.BamFormShell` in that inner frame, and the subframe refusal is the
only thing that drops its messages) and re-checks the calling frame's origin.

**This boundary is the safety property. The navigation guard is not.**
Off-origin main-frame documents (POST or history navigations) are also
stopped in `onPageStarted` and bounced back to the configured origin — but
`onPageStarted` fires when the document *starts*, so whether the foreign
page has already executed script by then is a **race**, and it has been
observed going both ways on the same build. The guard reliably stops a
foreign page **staying**; it does not reliably stop it **running**. What
makes that safe is that the channel is origin-scoped, so a foreign document
has no bridge to reach whether its script ran or not. Do not read the guard
as a second lock on the bridge; it is anti-phishing, stopping a foreign page
from sitting full-screen inside the shell's chrome pretending to be BamForm.

**If the device's WebView is older than v88** the feature is unavailable and
the shell installs **no channel at all** — it does not fall back to
`addJavascriptInterface`. The in-page Server field simply will not appear;
re-point such a device from the native card (which shows whenever the server
is unreachable). This is deliberate: no field is better than a hijackable one.

### Off-origin links leave the app with no tap

Any main-frame navigation away from the configured origin is handed to the
system browser (`Intent(ACTION_VIEW, uri)` — deliberately **not**
`Intent.parseUri`, so an `intent://` URL cannot be turned into an arbitrary
intent). That happens with **zero user interaction**: `location.href`, a
`<meta http-equiv=refresh>` and a 302 chain each move the technician into
Chrome at the target URL without a tap. This is pre-existing WebView shell
behaviour and is not a bridge issue — the bridge does not follow. But it
means a compromised or spoofed BamForm page can silently relocate a
technician to a browser, where the same phishing works without even the
shell's chrome to contradict it. Treat "the page the shell loads" as
security-relevant; it is the whole trust root (see the cleartext note below).

### The unreachable-server card gates on 5xx, not on content

When the configured server answers the main frame with an HTTP **5xx**, or
is unreachable at the socket level, the shell shows its native card
("… answered with HTTP 502 instead of the app", Retry, server field) instead
of a raw WebView error page. That covers the case that actually bites a
plant: a `docker compose up --build` window, or a misconfigured reverse
proxy.

It does **not** cover a server that answers **200 with the wrong content**.
A captive portal, a hotel/guest-Wi-Fi splash, or an ISP interception page
returning 200 renders inside the shell as if it were BamForm. Nothing is
persisted and no records move — the failure is visible and non-destructive,
and the technician sees a page that is obviously not BamForm — but the shell
will not tell them so. On a **cleartext plant LAN this is precisely the
on-path attacker's shape**, which is why it is written here and not only in
the build report: the person provisioning devices is the one who needs to
know. The better design gates the card on the native health probe rather
than on the HTTP status; that is a tracked follow-up, not what is built.

### The health probe is rate-limited

`setServerUrl` makes the *app* issue `GET <host>/api/v1/healthz` from the
device's network position, which page `fetch()` cannot do (CORS and Private
Network Access do not apply to `HttpURLConnection`). Response bodies are
never returned to JS, but reachability and timing are observable, which is a
port scanner. The probe is therefore capped at **one every 3 seconds**
whatever asks for it, and it does **not follow redirects**, so a probe
cannot be bounced onto a second internal host.

### Cleartext scope — the honest version

`network_security_config.xml` uses `<base-config
cleartextTrafficPermitted="true">`, which is **global**: cleartext is
permitted to *every* destination, not only to the address an admin typed.
There is no way to scope it, because the target set is supplied by a human
at runtime while Android resolves the config at build time. Do not read the
shell's ability to reach a LAN IP as a narrow exception — it is a blanket
one.

The one thing that *is* scoped: `form.bevorasg.com` is pinned to
**HTTPS-only** in a `domain-config`, so the production deployment can never
be downgraded to cleartext even if a stale preference says `http://`.

On a cleartext LAN, assume an on-path attacker can read and rewrite every
byte the shell loads, including the sign-in page.

### Unsent work does not follow a server switch

The offline outbox lives in IndexedDB, which is per-origin. Re-pointing the
shell does not migrate queued records — they stay in the old origin's
database, undrainable until the app is pointed back. The sign-in control
counts them and refuses to switch without an explicit confirmation naming
the number. **Before decommissioning a server, point each tablet at it once
and let it sync.**

## http:// targets (plant-internal IPs)

Cleartext HTTP is deliberately permitted (network_security_config) because
pointing the app at an internal IP is the whole point. **But:** browsers
only grant service workers to secure contexts, so over `http://` the PWA's
offline mode and installability are limited by the browser engine — the app
works online-only. The UI states this whenever an http address is entered
(sign-in disclosure and the native card both show the warning). Use HTTPS
for full offline support.

## Building

Requirements: JDK 17 and an Android SDK with `platforms;android-34` +
`build-tools;34.0.0` (macOS: `brew install openjdk@17`, and either
`brew install --cask android-commandlinetools` or tools in
`~/Library/Android/sdk`, then
`sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"`
and `yes | sdkmanager --licenses`).

```sh
cd android
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties   # or ANDROID_HOME
export JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || echo /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home)
./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

`./gradlew assembleDebug` needs no signing material. `./gradlew lint` is
kept clean (intentional suppressions are commented at the site).

### What CI checks, and what it does not

Two gates in `.github/workflows/ci.yml`, both blocking:

- **Job 12 · Android shell (Gradle)** runs `./gradlew assembleDebug lint` on
  every PR. Debug only, so it needs no keystore and no secrets; it refuses to
  run at all if signing material is found in the checkout.
- **Job 1** runs `scripts/ci/assert-shell-update-contract.mjs`, which pins the
  in-app update path: the update origin stays a pinned `https://` constant and
  is never derived from the configured content origin, `isTrustedUpdateUrl`
  keeps its four rules, `download()` checks the URL before connecting and
  verifies the SHA-256 *and* the signing certificate before it can return the
  file, neither fetch follows redirects, exactly one install intent exists and
  it is fed only from a verified download, the bridge exposes nothing, and the
  download page hard-codes no APK filename or checksum.
- **Job 1** runs `scripts/ci/assert-shell-protocol-contract.mjs`, which binds
  the Kotlin and TypeScript halves of the bridge (channel name, protocol
  version, message vocabulary in both directions) and pins the security
  invariants a compiler cannot see: the `addWebMessageListener` allow-list
  must stay `setOf(configuredOrigin)`, `onPostMessage` must keep all four of
  its guards ahead of the type dispatch, and `ServerConfig.normalize` must
  keep lower-casing the host.

**Neither gate runs the bridge.** `android/app/src` has no `test/` or
`androidTest/`: the protocol gate is static text analysis, so it proves the
guards are *present*, not that they still *work*. Behavioural coverage of
`ShellBridge.onPostMessage` (a Robolectric test on the four guards) is a
tracked follow-up; until it lands, the runtime evidence for the trust
boundary is the manual emulator attack suite recorded in
`.superpowers/sdd/android-shell-review.md`.

## In-app updates

### ⚠ AN UPDATE ONLY KEEPS THE DEVICE'S DATA IF IT IS SIGNED WITH THE SAME KEYSTORE

Android will install a new APK **over** the installed one — keeping cookies,
the login session, IndexedDB and **the offline outbox** — only when both are
signed by the same key. A differently-signed APK cannot be installed over the
old one at all: Android refuses with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and
the only way to proceed is to **uninstall first**.

**Uninstalling destroys the device's offline data, including records that have
been captured but not yet synced.** They are in the WebView's per-origin
IndexedDB, which goes with the app. There is no recovery and no warning from
Android — the uninstall dialog says nothing about maintenance records.

So, concretely:

- Every release must be signed from `keystore/bamform-release.keystore`. If
  that keystore is lost, there is no in-place upgrade path for **any** device
  ever again (see "Release signing" below).
- The app helps: it compares the downloaded APK's signing certificate to its
  own **before** offering it to the installer, and refuses with an explanation
  rather than letting a technician discover the problem as an opaque installer
  error. But it can only refuse — it cannot rescue a device that has already
  been uninstalled.
- **If a re-signed build is ever unavoidable**, point every tablet at its
  server and let the outbox drain to empty *before* uninstalling anything. The
  sign-in screen shows the pending count.

### How the check works

| | |
|---|---|
| Source | `https://form.bevorasg.com/app/version.json` — a **compile-time constant** (`UpdateManifest.UPDATE_ORIGIN`) |
| Frequency | once per 6 h, persisted in `bamform_update` prefs; wall-clock so a reboot does not re-arm it |
| Timing | posted 4 s after the WebView is told to load, on its own executor — a slow or dead update host is invisible |
| Prompt | a dismissible strip at the foot of the page, never a modal; "Not now" silences that version only |
| Verify | SHA-256 of the downloaded bytes vs the manifest, **then** the archive's package name, versionCode and signing certificate vs the running app |
| Install | `FileProvider` + `ACTION_VIEW`; the user confirms in Android's own installer. **No silent install** — `REQUEST_INSTALL_PACKAGES` grants only the right to ask |
| On failure | offline / 404 / timeout / cancel → the app carries on, nothing installed. Hash or signer mismatch → the file is deleted and the refusal is stated plainly |

### The update origin is NOT the configured server, deliberately

The Server disclosure lets an admin point the shell at any host, including a
cleartext plant IP. The update channel does **not** follow it: a shell pointed
at `http://192.168.1.50:8080` still fetches its updates from
`https://form.bevorasg.com`, and refuses any `apkUrl` that is not on that
origin.

That is a deliberate separation of privilege. *Serving BamForm's pages* is a
much smaller thing than *shipping code to the tablets*, and on a cleartext LAN
the shell already assumes an on-path attacker can rewrite every byte it loads.
If the update source followed the configured origin, that same attacker would
choose which APK the technician is invited to install. `form.bevorasg.com` is
additionally pinned to HTTPS-only in `network_security_config.xml`, so nothing
can downgrade it.

**Consequence for a plant running its own instance:** its devices still need
reachability to `form.bevorasg.com` for updates, or they get none — the check
fails silently and the app keeps working. Changing the update origin means
editing `UpdateManifest.UPDATE_ORIGIN` and rebuilding; it is not a runtime
setting, and it should not become one without re-running the review's attack
suite.

### Publishing a release

`assembleRelease` **generates** the manifest — it is not written by hand:

```sh
cd android
./gradlew assembleRelease
# → app/build/dist/
#     bamform-<versionName>.apk
#     version.json      generated FROM that APK (versionCode, versionName, sha256, size)
#     index.html        the download page, copied from android/download-page/
```

Bump `versionCode` (and `versionName`) in `app/build.gradle.kts` first —
`versionCode` is what installed devices compare against. Edit
`android/release-note.txt` for the one human-written line in the manifest;
everything else comes out of the binary.

Then copy the whole of `app/build/dist/` to `/var/www/form.bevorasg.com/app/`
on the host. The download page reads `version.json` at load time, so the page
and the app can never disagree about the current release — and the page
refuses to offer a download at all if the manifest is missing.

Why this is mechanised: the previously published page linked to
`bamform-1.1.apk` with a footer reading "v1.1", while that binary carried
`versionName 1.0.0` / `versionCode 1`. Two hand-maintained descriptions of one
artefact had already drifted. Once an installed app decides whether to
download new code from that description, drift stops being cosmetic.
`scripts/ci/assert-shell-update-contract.mjs` keeps it mechanised.

### What the update path is not

- **Not reachable from the web app.** No bridge message type was added; a page
  cannot start a check, a download or an install. The bridge's origin
  allow-list and its four `onPostMessage` guards are untouched by this feature,
  and the contract gate still pins them.
- **Not automatic.** Nothing installs without two taps and Android's own
  confirmation.
- **Not a substitute for the signature rule above.** Verification refuses a
  wrongly-signed APK; it does not make one installable.

## Release signing — READ THIS BEFORE LOSING ANYTHING

Release builds are signed from `keystore/keystore.properties`
(`storeFile` / `storePassword` / `keyAlias` / `keyPassword`). The keystore
directory is **gitignored — the keystore and passwords are NOT in git**.
They were handed to the owner in the build report; keep both somewhere
durable (password manager + offline copy).

**If the keystore is lost, no future APK can upgrade the installed app in
place.** Android requires every update to be signed by the same key; a
rebuilt keystore means uninstalling the app on every device (losing its
local WebView state) before installing the new build. Treat
`bamform-release.keystore` like a production credential.

## Sideloading (no Play Store)

1. Copy `app-release.apk` to the device (USB, MDM, file share).
2. Open it. Android will ask to allow installs from that source:
   **Settings → Apps → Special app access → Install unknown apps** → allow
   for the browser/file manager being used.
3. Install. On first photo capture the app asks for the Camera permission.
4. To re-point a device: sign-in screen → the small "Server: …" disclosure
   under the Sign in button → enter address → **Connect to this server**.
   The switch only happens after the shell has verified the new server's
   health endpoint.

Updating: from 1.2.0 onward the app offers updates itself (see "In-app
updates" above). Manually, install the new APK over the old — **same signing
key, or the device's unsent records are destroyed** — or
`adb install -r app-release.apk`.
