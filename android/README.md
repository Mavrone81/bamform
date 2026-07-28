# BamForm Android shell

A minimal native wrapper around the BamForm PWA. The web app remains the
product; this APK adds exactly two things:

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
origin**. The listener additionally refuses subframes and re-checks the
calling frame's origin. Off-origin main-frame documents (POST or history
navigations) are also stopped and bounced back to the configured origin, so
a foreign page cannot render full-screen inside the shell's chrome.

**If the device's WebView is older than v88** the feature is unavailable and
the shell installs **no channel at all** — it does not fall back to
`addJavascriptInterface`. The in-page Server field simply will not appear;
re-point such a device from the native card (which shows whenever the server
is unreachable). This is deliberate: no field is better than a hijackable one.

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

Updating: install the new APK over the old (same signing key) — data is
kept. `adb install -r app-release.apk` also works.
