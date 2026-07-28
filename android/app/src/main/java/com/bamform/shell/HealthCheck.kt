package com.bamform.shell

import android.content.Context
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Reachability probe against `<origin>/api/v1/healthz` (expects HTTP 200
 * with `{"status":"ok"}`). Used before every server switch — from the web
 * bridge and from the native offline card — so the shell never strands the
 * user on a dead origin. Call off the main thread.
 */
object HealthCheck {

    /** Returns null on success, otherwise a user-facing error message. */
    fun probe(context: Context, origin: String): String? {
        return try {
            val conn =
                URL(origin + ServerConfig.HEALTH_PATH).openConnection() as HttpURLConnection
            conn.connectTimeout = 7000
            conn.readTimeout = 7000
            conn.requestMethod = "GET"
            // Review A-6: HttpURLConnection follows redirects by default, so
            // one probe of a host the caller chose could be bounced onto a
            // second internal host the caller never named. A BamForm health
            // endpoint never redirects; anything that does is not one.
            conn.instanceFollowRedirects = false
            try {
                val code = conn.responseCode
                val body =
                    (if (code in 200..299) conn.inputStream else conn.errorStream)
                        ?.bufferedReader()
                        ?.use { it.readText().take(512) } ?: ""
                if (code == 200 && body.contains("\"status\"") && body.contains("ok")) {
                    null
                } else {
                    context.getString(R.string.err_bad_health, code)
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: SSLException) {
            context.getString(R.string.err_ssl, e.message ?: e.javaClass.simpleName)
        } catch (_: UnknownHostException) {
            context.getString(R.string.err_unknown_host)
        } catch (_: SocketTimeoutException) {
            context.getString(R.string.err_timeout)
        } catch (_: MalformedURLException) {
            context.getString(R.string.err_invalid_url)
        } catch (e: Exception) {
            context.getString(R.string.err_generic, e.message ?: e.javaClass.simpleName)
        }
    }
}
