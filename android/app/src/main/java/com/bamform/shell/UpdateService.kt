package com.bamform.shell

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/**
 * The network + verification half of the in-app update path. No UI, no state:
 * every function here is called from a background thread and returns a value.
 *
 * ## The rule this file exists to enforce
 *
 * **Nothing reaches the package installer that has not first matched the
 * published SHA-256 *and* been proved to carry the same signing certificate
 * as the running app.** Both checks happen here, before the caller is handed
 * a [DownloadOutcome.Ok]; a failure deletes the file and returns
 * [DownloadOutcome.Refused], which the UI reports loudly rather than
 * retrying.
 *
 * The two checks answer different questions and neither replaces the other:
 *
 *  - the **hash** proves the bytes are the ones the publisher measured, so a
 *    truncated download, a caching proxy serving a stale APK, or a corrupted
 *    write cannot be installed;
 *  - the **signer certificate** proves the archive was built with BamForm's
 *    release keystore, so even a completely forged manifest — one whose
 *    `sha256` honestly describes an attacker's APK — cannot get that APK in
 *    front of the installer. Forging an update then requires the keystore,
 *    not merely a foothold on the web server.
 *
 * That last property is why the signer check is not "belt and braces": TLS
 * and the pinned origin protect the *transport*, and the signer check
 * protects against the *publisher* being wrong.
 */
object UpdateService {

    /** The shell is ~2.6 MB; nothing legitimate is close to this. */
    private const val MAX_APK_BYTES = 64L * 1024 * 1024

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val BUFFER = 32 * 1024

    /** Downloaded APKs live here, app-private, and the directory is wiped
     * before every download so a refused file is never left behind. */
    private const val CACHE_SUBDIR = "updates"
    private const val APK_FILENAME = "bamform-update.apk"

    sealed class DownloadOutcome {
        /** Verified: hash matched AND the archive is signed by our key. */
        data class Ok(val file: File) : DownloadOutcome()

        /** The user cancelled; nothing to say and nothing left on disk. */
        object Cancelled : DownloadOutcome()

        /** Transport-level failure (offline, 404, timeout). Quiet. */
        data class Failed(val message: String) : DownloadOutcome()

        /**
         * The bytes arrived but did not verify. NOT the same as [Failed]:
         * this is the one failure the user must be told about plainly,
         * because the benign explanations (corruption, a stale proxy) and the
         * malign one (substitution) look identical from the device.
         */
        data class Refused(val message: String) : DownloadOutcome()
    }

    // ---------------------------------------------------------------- check

    /**
     * Fetch and parse the manifest from the pinned origin. Returns null for
     * every failure — offline, DNS, TLS, 404, malformed JSON, a manifest that
     * fails validation. The check must be invisible when it fails; the
     * technician is using the app.
     */
    fun fetchManifest(): UpdateManifest? {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL(UpdateManifest.MANIFEST_URL)
            val opened = url.openConnection()
            // The URL is a compile-time https:// constant, so this can only
            // fail if someone edits that constant. Fail closed if they do.
            if (opened !is HttpsURLConnection) return null
            conn = opened
            opened.connectTimeout = CONNECT_TIMEOUT_MS
            opened.readTimeout = READ_TIMEOUT_MS
            opened.requestMethod = "GET"
            // A redirect is how a manifest fetch would leave the pinned
            // origin. It never legitimately does.
            opened.instanceFollowRedirects = false
            opened.setRequestProperty("Accept", "application/json")
            if (opened.responseCode != 200) return null
            val text =
                opened.inputStream.use { readCapped(it, UpdateManifest.MAX_MANIFEST_BYTES) }
                    ?: return null
            UpdateManifest.parse(text)
        } catch (_: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /** Reads at most [max] bytes; returns null if the stream is longer. */
    private fun readCapped(input: InputStream, max: Int): String? {
        val buf = ByteArray(max + 1)
        var n = 0
        while (n <= max) {
            val r = input.read(buf, n, buf.size - n)
            if (r <= 0) break
            n += r
        }
        if (n > max) return null
        return String(buf, 0, n, Charsets.UTF_8)
    }

    // ------------------------------------------------------------- download

    /**
     * Download [manifest]'s APK, hash it as it lands, and verify it. The
     * caller only ever receives a file that passed both checks.
     *
     * @param isCancelled polled between chunks so a cancel is prompt.
     * @param onProgress (bytesRead, totalBytesOrMinusOne), off the main thread.
     */
    fun download(
        context: Context,
        manifest: UpdateManifest,
        isCancelled: () -> Boolean,
        onProgress: (Long, Long) -> Unit,
    ): DownloadOutcome {
        // Re-assert the origin rule at the point of use. UpdateManifest.parse
        // already refused anything else, but this is the last statement before
        // an outbound request built from network-supplied text, and a future
        // caller that skips parse() must not silently skip the origin rule
        // with it.
        if (!UpdateManifest.isTrustedUpdateUrl(manifest.apkUrl)) {
            return DownloadOutcome.Refused(context.getString(R.string.update_refused_origin))
        }

        val dir = File(context.cacheDir, CACHE_SUBDIR)
        dir.deleteRecursively()
        if (!dir.mkdirs() && !dir.isDirectory) {
            return DownloadOutcome.Failed(context.getString(R.string.update_failed_storage))
        }
        val target = File(dir, APK_FILENAME)

        var conn: HttpURLConnection? = null
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            val opened = URL(manifest.apkUrl).openConnection()
            if (opened !is HttpsURLConnection) {
                return DownloadOutcome.Refused(context.getString(R.string.update_refused_origin))
            }
            conn = opened
            opened.connectTimeout = CONNECT_TIMEOUT_MS
            opened.readTimeout = READ_TIMEOUT_MS
            opened.requestMethod = "GET"
            // Same reasoning as the manifest fetch: a redirect is the way off
            // the pinned origin, and there is no legitimate one.
            opened.instanceFollowRedirects = false
            val code = opened.responseCode
            if (code != 200) {
                target.delete()
                return DownloadOutcome.Failed(
                    context.getString(R.string.update_failed_http, code),
                )
            }
            val declared = opened.contentLengthLong
            if (declared > MAX_APK_BYTES) {
                target.delete()
                return DownloadOutcome.Failed(context.getString(R.string.update_failed_too_big))
            }

            var total = 0L
            opened.inputStream.use { input ->
                target.outputStream().use { out ->
                    val buf = ByteArray(BUFFER)
                    while (true) {
                        if (isCancelled()) {
                            dir.deleteRecursively()
                            return DownloadOutcome.Cancelled
                        }
                        val r = input.read(buf)
                        if (r < 0) break
                        total += r
                        // Cap the stream itself, not just the declared length:
                        // Content-Length is a claim, not a guarantee.
                        if (total > MAX_APK_BYTES) {
                            dir.deleteRecursively()
                            return DownloadOutcome.Failed(
                                context.getString(R.string.update_failed_too_big),
                            )
                        }
                        out.write(buf, 0, r)
                        digest.update(buf, 0, r)
                        onProgress(total, declared)
                    }
                    out.flush()
                }
            }
        } catch (e: IOException) {
            dir.deleteRecursively()
            return DownloadOutcome.Failed(
                context.getString(R.string.update_failed_network, e.javaClass.simpleName),
            )
        } catch (e: Exception) {
            dir.deleteRecursively()
            return DownloadOutcome.Failed(
                context.getString(R.string.update_failed_network, e.javaClass.simpleName),
            )
        } finally {
            conn?.disconnect()
        }

        // ---- GATE 1: the bytes are the published bytes ----
        val actual = toHex(digest.digest())
        if (actual != manifest.sha256) {
            dir.deleteRecursively()
            return DownloadOutcome.Refused(
                context.getString(
                    R.string.update_refused_hash,
                    manifest.versionName,
                    manifest.sha256.take(12),
                    actual.take(12),
                ),
            )
        }

        // ---- GATE 2: the archive carries our signing certificate ----
        val identityProblem = verifyApkIdentity(context, target, manifest)
        if (identityProblem != null) {
            dir.deleteRecursively()
            return DownloadOutcome.Refused(identityProblem)
        }

        return DownloadOutcome.Ok(target)
    }

    // --------------------------------------------------------- verification

    /**
     * Returns null when [file] is genuinely a newer build of *this* app
     * signed by *this* keystore; otherwise a user-facing refusal message.
     *
     * `getPackageArchiveInfo` parses the archive and collects its signing
     * certificates, so an unsigned or structurally-corrupt APK yields null
     * here. It is not claimed to be a full re-implementation of the platform
     * installer's verification on every OS version — the SHA-256 gate above
     * is the primary integrity check, and the installer itself verifies the
     * signature again before it installs. What this adds is the *binding*: a
     * different signing key is rejected on the device, with an explanation,
     * instead of surfacing minutes later as an opaque
     * `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
     */
    fun verifyApkIdentity(context: Context, file: File, manifest: UpdateManifest): String? {
        val pm = context.packageManager
        val archive =
            pm.getPackageArchiveInfo(file.absolutePath, signatureFlags())
                ?: return context.getString(R.string.update_refused_unreadable)

        if (archive.packageName != context.packageName) {
            return context.getString(
                R.string.update_refused_package,
                archive.packageName ?: "?",
                context.packageName,
            )
        }

        val archiveCode = versionCodeOf(archive)
        if (archiveCode != manifest.versionCode) {
            return context.getString(
                R.string.update_refused_versioncode,
                manifest.versionCode,
                archiveCode,
            )
        }

        val installed =
            try {
                pm.getPackageInfo(context.packageName, signatureFlags())
            } catch (_: PackageManager.NameNotFoundException) {
                null
            } ?: return context.getString(R.string.update_refused_unreadable)

        val downloadedSigners = signerDigests(archive)
        val installedSigners = signerDigests(installed)
        if (downloadedSigners.isEmpty() || installedSigners.isEmpty()) {
            return context.getString(R.string.update_refused_unsigned)
        }
        if (downloadedSigners.intersect(installedSigners).isEmpty()) {
            return context.getString(
                R.string.update_refused_signer,
                downloadedSigners.first().take(12),
                installedSigners.first().take(12),
            )
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun signatureFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }

    @Suppress("DEPRECATION")
    private fun versionCodeOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }

    /** SHA-256 of every signing certificate the package presents, lower hex. */
    @Suppress("DEPRECATION")
    private fun signerDigests(info: PackageInfo): Set<String> {
        val raw =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val si = info.signingInfo
                when {
                    si == null -> emptyArray()
                    si.hasMultipleSigners() -> si.apkContentsSigners
                    // Includes the current signer plus any it was rotated
                    // from, so a v3-rotated key still matches an older
                    // install. Rotation is why enableV3Signing is on.
                    else -> si.signingCertificateHistory ?: si.apkContentsSigners
                }
            } else {
                info.signatures ?: emptyArray()
            }
        return raw.filterNotNull()
            .map { toHex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }
            .toSet()
    }

    private fun toHex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            out.append("0123456789abcdef"[v ushr 4])
            out.append("0123456789abcdef"[v and 0x0F])
        }
        return out.toString()
    }
}
