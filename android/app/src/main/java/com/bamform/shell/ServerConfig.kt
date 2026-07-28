package com.bamform.shell

import android.content.Context
import android.net.Uri

/**
 * The one piece of state this shell owns: which server hosts BamForm.
 *
 * Everything else (session, tokens, offline outbox) belongs to the web app
 * and lives in the WebView's own cookie jar / IndexedDB, exactly as it
 * would in Chrome.
 */
object ServerConfig {
    const val DEFAULT_URL = "https://form.bevorasg.com"
    const val HEALTH_PATH = "/api/v1/healthz"

    private const val PREFS = "bamform_shell"
    private const val KEY_URL = "server_url"

    /** The configured origin — the last one that passed a health check, or the default. */
    fun get(context: Context): String =
        context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_URL, null) ?: DEFAULT_URL

    fun set(context: Context, url: String) {
        context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_URL, url)
            .apply()
    }

    /**
     * Normalises raw input (from the web bridge or the offline card — both
     * untrusted) to an origin URL, or null if unusable. Rules:
     *  - scheme must be http or https; a bare host/IP gets http:// (plant-
     *    internal hosts rarely have TLS) and the UI shows the http warning
     *  - no userinfo (credentials-in-URL are rejected outright)
     *  - path/query/fragment are dropped: the shell always loads the origin
     *  - the host is lower-cased.
     *
     * The lower-casing is not cosmetic (review R-6). This function's output
     * is what [MainActivity.installBridge] hands to `addWebMessageListener`
     * as the origin allow-list, and that rule is matched against the
     * document's own origin, which the browser always reports lower-cased.
     * A `HOST.local` typed into the card would therefore produce a rule the
     * WebView never matches: the shell would install **no** channel and the
     * in-page Server field would simply never appear, with nothing anywhere
     * saying why. It fails closed either way — this makes it not fail at all.
     * `lowercase()` (not the deprecated `toLowerCase()`) is Locale.ROOT, so
     * a Turkish device locale cannot turn `I` into `ı` here.
     */
    fun normalize(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty() || s.length > 2000) return null
        if (!s.contains("://")) s = "http://$s"
        val uri = Uri.parse(s)
        if (uri.scheme != "http" && uri.scheme != "https") return null
        if (uri.userInfo != null) return null
        val host = uri.host?.lowercase()
        if (host.isNullOrBlank()) return null
        val port = if (uri.port != -1) ":${uri.port}" else ""
        return "${uri.scheme}://$host$port"
    }

    fun isHttp(url: String?): Boolean = url != null && url.startsWith("http://")

    /** True when [url] belongs to the configured origin (scheme+host+port). */
    fun sameOrigin(configured: String, url: String): Boolean {
        val a = Uri.parse(configured)
        val b = Uri.parse(url)
        fun portOf(u: Uri): Int =
            when {
                u.port != -1 -> u.port
                u.scheme == "https" -> 443
                else -> 80
            }
        return a.scheme == b.scheme &&
            (a.host ?: "").equals(b.host ?: "", ignoreCase = true) &&
            portOf(a) == portOf(b)
    }
}
