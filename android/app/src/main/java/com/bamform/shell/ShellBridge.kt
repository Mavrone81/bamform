package com.bamform.shell

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * `window.BamFormShell` — the channel the sign-in page's Server disclosure
 * talks to. Kept deliberately tiny: the shell's only state is the server
 * origin.
 *
 * ## Why this is NOT `addJavascriptInterface`
 *
 * It used to be. The adversarial review of 2026-07-28 demonstrated, on an
 * emulator, two zero-interaction takeovers of that design:
 *
 *  - **A-1:** `addJavascriptInterface` injects into **every frame** of the
 *    WebView. A cross-origin `<iframe>` got a live `window.BamFormShell` and
 *    called `setServerUrl` with no user interaction at all. The old comment
 *    here claimed navigation interception confined the interface; it does
 *    not — `shouldOverrideUrlLoading` never sees a subframe load.
 *  - **A-2:** `shouldOverrideUrlLoading` is **not called for POST
 *    navigations**, so a cross-origin form POST took over the main frame
 *    inside the shell, interface intact.
 *
 * `addJavascriptInterface` cannot express an origin rule, so no amount of
 * care at the call site fixes either. `WebViewCompat.addWebMessageListener`
 * can: the injected object is created **only in documents whose origin
 * matches the allow-list**, and every message arrives stamped with the
 * calling frame's origin and whether it is the main frame.
 *
 * The allow-list here is exactly one entry — the configured origin — and
 * [MainActivity] re-registers the listener whenever that origin changes.
 * [onPostMessage] then re-checks `sourceOrigin` and refuses subframes, so a
 * future widening of the allow-list cannot silently widen the trust
 * boundary.
 *
 * ## Protocol (v1, mirrored in web/src/components/ShellServerControl.tsx)
 *
 * page → shell: `{"v":1,"id":"…","type":"getServerUrl"}`
 *               `{"v":1,"id":"…","type":"setServerUrl","url":"…"}`
 * shell → page: `{"v":1,"id":"…","type":"serverUrl","url":"…"}`
 *               `{"v":1,"id":"…","type":"switchResult","ok":false,"error":"…"}`
 *
 * Every URL received here is untrusted: [MainActivity.requestServerSwitch]
 * normalises it (http/https only, no userinfo, origin only), rate-limits the
 * probe and health-checks it natively before anything is persisted.
 */
class ShellBridge(private val activity: MainActivity) : WebViewCompat.WebMessageListener {

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        // Belt and braces over the allow-list. The control lives in the top
        // document; nothing legitimate speaks from a subframe.
        if (!isMainFrame) return
        if (!ServerConfig.sameOrigin(activity.currentOrigin(), sourceOrigin.toString())) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val text = message.data ?: return
        if (text.length > MAX_MESSAGE_CHARS) return

        val json = try { JSONObject(text) } catch (_: Exception) { return }
        if (json.optInt("v", -1) != PROTOCOL_VERSION) return
        val id = json.optString("id").takeIf { it.isNotEmpty() } ?: return

        when (json.optString("type")) {
            "getServerUrl" ->
                reply(
                    replyProxy,
                    JSONObject()
                        .put("v", PROTOCOL_VERSION)
                        .put("id", id)
                        .put("type", "serverUrl")
                        .put("url", ServerConfig.get(activity)),
                )

            "setServerUrl" -> {
                val url = json.optString("url")
                activity.requestServerSwitch(url, MainActivity.SwitchSource.BRIDGE) { error ->
                    // Success is not reported: the shell is already reloading
                    // this document from the new origin, and this reply proxy
                    // dies with it.
                    if (error != null) {
                        reply(
                            replyProxy,
                            JSONObject()
                                .put("v", PROTOCOL_VERSION)
                                .put("id", id)
                                .put("type", "switchResult")
                                .put("ok", false)
                                .put("error", error),
                        )
                    }
                }
            }
        }
    }

    private fun reply(replyProxy: JavaScriptReplyProxy, payload: JSONObject) {
        // A reply proxy cannot exist unless the listener was installed, which
        // already required WEB_MESSAGE_LISTENER — but lint cannot see that
        // across the callback, and re-asserting it costs nothing.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        // The document may already be gone (a switch reloads it); a dead
        // proxy must not take the app with it.
        try {
            replyProxy.postMessage(payload.toString())
        } catch (_: Exception) {
            // no-op
        }
    }

    companion object {
        /** The JS object name injected into allow-listed documents. */
        const val CHANNEL = "BamFormShell"
        const val PROTOCOL_VERSION = 1
        private const val MAX_MESSAGE_CHARS = 4096

        /**
         * True when this device's WebView supports origin-scoped message
         * listeners (WebView 88+, Jan 2021). If it does not, the shell
         * installs **no** channel at all rather than falling back to the
         * hijackable `addJavascriptInterface`: the in-page server field
         * simply never appears, and the native card remains the way to
         * re-point the device. Failing closed is the point.
         */
        fun isSupported(): Boolean =
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
    }
}
