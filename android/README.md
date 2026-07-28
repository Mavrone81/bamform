# BamForm Android shell

A minimal native wrapper around the BamForm PWA. The web app remains the
product; this APK adds exactly two things:

1. **An admin-configurable server address.** The shell boots straight into
   the WebView at the configured origin (default `https://form.bevorasg.com`,
   last-used origin persisted). The server is re-pointed from **inside the
   web app's sign-in screen**: the shell injects `window.BamFormShell`
   (`getServerUrl()` / `setServerUrl(url)`), and the sign-in card shows a
   collapsed "Server" disclosure **only when that bridge exists** — in a
   normal browser the control is absent from the DOM entirely. Every switch
   is health-checked natively against `<url>/api/v1/healthz` before anything
   is persisted or loaded, so the app is never stranded on a dead origin.
2. **A WebView that runs the PWA faithfully** — service workers, IndexedDB
   (the offline outbox), persistent cookies (the HttpOnly refresh cookie is
   flushed to disk on stop, so restarts keep the session exactly like
   Chrome would), photo capture via the file chooser (camera intent wired,
   CAMERA runtime permission), back button walks WebView history, external
   links open in the system browser, renderer crashes recreate the activity,
   and an unreachable server shows a native card (Retry + server field —
   the error path needs a native field because the sign-in page that hosts
   the normal control is served by the very server that is unreachable).

## What the shell does NOT do

- **No authorisation, no tokens.** Authz stays server-side. The shell
  stores exactly one string: the server origin. Session state lives in the
  WebView's own cookie jar / IndexedDB, as it would in any browser.
- **No offline logic of its own.** Offline behaviour is the PWA's service
  worker + outbox.
- **iOS is not covered.**

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
