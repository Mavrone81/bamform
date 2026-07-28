package com.bamform.shell

import android.webkit.JavascriptInterface

/**
 * `window.BamFormShell` — the JS interface the sign-in page's Server
 * disclosure talks to. Kept deliberately tiny: the shell's only state is
 * the server origin.
 *
 * Hygiene:
 *  - only @JavascriptInterface-annotated methods are reachable from JS;
 *  - the WebView only ever renders documents from the configured origin
 *    (every off-origin main-frame navigation — including server redirects —
 *    is diverted to the system browser by MainActivity's WebViewClient), so
 *    the interface is never exposed to third-party pages;
 *  - every URL received here is untrusted: [MainActivity.requestServerSwitch]
 *    normalises it (http/https only, no userinfo, origin only) and health-
 *    checks it natively before anything is persisted or loaded.
 *
 * These methods run on a WebView-managed binder thread, not the UI thread.
 */
class ShellBridge(private val activity: MainActivity) {

    /** The currently configured server origin, e.g. "https://form.bevorasg.com". */
    @JavascriptInterface
    fun getServerUrl(): String = ServerConfig.get(activity)

    /**
     * Ask the shell to switch servers. Asynchronous: the shell validates and
     * probes `<url>/api/v1/healthz` off-thread, then either reloads the
     * WebView at the new origin or surfaces the failure as a native toast.
     * The current origin is never abandoned until the new one has passed.
     */
    @JavascriptInterface
    fun setServerUrl(url: String) {
        activity.requestServerSwitch(url, fromBridge = true)
    }
}
