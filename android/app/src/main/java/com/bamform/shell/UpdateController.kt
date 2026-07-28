package com.bamform.shell

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * In-app APK update: check → prompt → download → verify → the user installs.
 *
 * Owner requirement (2026-07-28): *"key is check if the mobile apk is updated
 * and allow for update download from form.bevorasg.com/app"*. Web changes
 * reach every device on deploy; only a **shell** change needs a new APK, and
 * without this the only route was "someone walks to each tablet".
 *
 * ## Rules this class holds to
 *
 * - **It never blocks startup.** The check is posted [CHECK_DELAY_MS] after
 *   the WebView has already been told to load, and runs on its own executor.
 *   A slow or dead update host is invisible.
 * - **It is throttled** to one check per [CHECK_INTERVAL_MS], persisted, so a
 *   technician who restarts the app twenty times in a shift causes one
 *   request.
 * - **Every failure degrades to "carry on using the app."** A failed check
 *   shows nothing at all. A failed *download* — which the user asked for —
 *   says so and stops.
 * - **Refusals are loud.** A hash or signer mismatch is the one case that is
 *   spelled out rather than softened: benign corruption and deliberate
 *   substitution are indistinguishable from the device, so both are reported
 *   as "this was refused and deleted, tell IT if it repeats".
 * - **There is no silent install and no pretence of one.** The verified file
 *   is handed to the platform installer via [FileProvider] + `ACTION_VIEW`;
 *   the user confirms there, in Android's own UI. The shell holds no
 *   privileged install permission beyond `REQUEST_INSTALL_PACKAGES`, which
 *   only allows *asking*.
 * - **It cannot be triggered from the page.** No message type is added to
 *   `ShellBridge`; the web app has no way to start a check, a download or an
 *   install. The bridge's origin allow-list and four guards are untouched by
 *   this feature.
 */
class UpdateController(private val activity: MainActivity) {

    private lateinit var banner: View
    private lateinit var title: TextView
    private lateinit var detail: TextView
    private lateinit var progress: ProgressBar
    private lateinit var primary: Button
    private lateinit var secondary: Button

    private val mainHandler = Handler(Looper.getMainLooper())
    private var executor: ExecutorService? = null
    private val cancelled = AtomicBoolean(false)

    private var offered: UpdateManifest? = null
    private var verifiedApk: File? = null
    private var downloading = false

    // ------------------------------------------------------------ lifecycle

    fun onCreate(root: View) {
        banner = root.findViewById(R.id.updateBanner)
        title = root.findViewById(R.id.updateTitle)
        detail = root.findViewById(R.id.updateDetail)
        progress = root.findViewById(R.id.updateProgress)
        primary = root.findViewById(R.id.updatePrimary)
        secondary = root.findViewById(R.id.updateSecondary)
        executor = Executors.newSingleThreadExecutor()
        hide()
    }

    fun onDestroy() {
        cancelled.set(true)
        executor?.shutdownNow()
        executor = null
        mainHandler.removeCallbacksAndMessages(null)
    }

    /**
     * Called from `onCreate` **after** `webView.loadUrl`. The delay is not a
     * race guard — the work is on another thread either way — it is to keep
     * the first seconds of the app entirely about loading the page.
     */
    fun scheduleCheck() {
        mainHandler.postDelayed({ check() }, CHECK_DELAY_MS)
    }

    // ---------------------------------------------------------------- check

    private fun check() {
        if (activity.isFinishing || activity.isDestroyed) return
        val prefs = prefs(activity)
        val now = System.currentTimeMillis()
        val last = prefs.getLong(KEY_LAST_CHECK, 0L)
        // `now < last` catches a clock that moved backwards (manual set, NTP
        // correction): treat a nonsensical interval as due rather than
        // locking the device out of updates until the clock passes the stale
        // stamp.
        if (last != 0L && now >= last && now - last < CHECK_INTERVAL_MS) return
        prefs.edit().putLong(KEY_LAST_CHECK, now).apply()

        submit {
            val manifest = UpdateService.fetchManifest()
            mainHandler.post {
                if (activity.isFinishing || activity.isDestroyed) return@post
                if (manifest == null) return@post // silent: no update, or no answer
                onManifest(manifest)
            }
        }
    }

    private fun onManifest(manifest: UpdateManifest) {
        val current = BuildConfig.VERSION_CODE.toLong()
        if (manifest.versionCode <= current) {
            // We are current (or ahead of) what is published. Forget any
            // earlier dismissal so a future release prompts again.
            prefs(activity).edit().remove(KEY_DISMISSED).apply()
            return
        }
        if (manifest.versionCode <= prefs(activity).getLong(KEY_DISMISSED, 0L)) return
        offered = manifest
        showPrompt(manifest)
    }

    // ------------------------------------------------------------------- UI

    private fun showPrompt(manifest: UpdateManifest) {
        title.text = activity.getString(R.string.update_title, manifest.versionName)
        detail.text =
            if (manifest.releaseNote.isEmpty()) {
                activity.getString(R.string.update_detail, BuildConfig.VERSION_NAME)
            } else {
                activity.getString(
                    R.string.update_detail_note,
                    BuildConfig.VERSION_NAME,
                    manifest.releaseNote,
                )
            }
        progress.visibility = View.GONE
        primary.visibility = View.VISIBLE
        primary.text = activity.getString(R.string.update_download)
        primary.isEnabled = true
        primary.setOnClickListener { startDownload(manifest) }
        secondary.visibility = View.VISIBLE
        secondary.text = activity.getString(R.string.update_not_now)
        secondary.setOnClickListener { dismissVersion(manifest) }
        banner.visibility = View.VISIBLE
    }

    private fun dismissVersion(manifest: UpdateManifest) {
        // Dismissal is per-version: this build stops nagging, the next
        // release asks once.
        prefs(activity).edit().putLong(KEY_DISMISSED, manifest.versionCode).apply()
        hide()
    }

    private fun hide() {
        banner.visibility = View.GONE
    }

    // -------------------------------------------------------------- download

    private fun startDownload(manifest: UpdateManifest) {
        if (downloading) return
        downloading = true
        cancelled.set(false)
        verifiedApk = null

        title.text = activity.getString(R.string.update_downloading_title, manifest.versionName)
        detail.text = activity.getString(R.string.update_downloading)
        progress.visibility = View.VISIBLE
        progress.isIndeterminate = true
        progress.progress = 0
        primary.visibility = View.GONE
        secondary.visibility = View.VISIBLE
        secondary.text = activity.getString(R.string.update_cancel)
        secondary.setOnClickListener {
            cancelled.set(true)
            secondary.isEnabled = false
        }
        secondary.isEnabled = true

        val submitted =
            submit {
                val outcome =
                    UpdateService.download(
                        activity,
                        manifest,
                        isCancelled = { cancelled.get() },
                        onProgress = { read, total -> postProgress(read, total) },
                    )
                mainHandler.post {
                    downloading = false
                    if (activity.isFinishing || activity.isDestroyed) return@post
                    onDownloadOutcome(manifest, outcome)
                }
            }
        if (!submitted) {
            downloading = false
            showTerminal(activity.getString(R.string.update_failed_storage), loud = false)
        }
    }

    private fun postProgress(read: Long, total: Long) {
        if (total <= 0L) return
        val pct = ((read * 100L) / total).toInt().coerceIn(0, 100)
        mainHandler.post {
            if (activity.isFinishing || activity.isDestroyed) return@post
            if (!downloading) return@post
            progress.isIndeterminate = false
            progress.progress = pct
            detail.text = activity.getString(R.string.update_downloading_pct, pct)
        }
    }

    private fun onDownloadOutcome(
        manifest: UpdateManifest,
        outcome: UpdateService.DownloadOutcome,
    ) {
        progress.visibility = View.GONE
        when (outcome) {
            is UpdateService.DownloadOutcome.Cancelled -> hide()

            is UpdateService.DownloadOutcome.Failed ->
                showTerminal(outcome.message, loud = false)

            // The refusal path. Deliberately not softened and deliberately
            // not auto-retried: a retry loop against a substituted file is
            // just a slower way to be attacked, and the person who needs to
            // know is IT, not the technician's patience.
            is UpdateService.DownloadOutcome.Refused ->
                showTerminal(outcome.message, loud = true)

            is UpdateService.DownloadOutcome.Ok -> {
                verifiedApk = outcome.file
                showReady(manifest)
            }
        }
    }

    private fun showReady(manifest: UpdateManifest) {
        title.text = activity.getString(R.string.update_verified_title, manifest.versionName)
        detail.text = activity.getString(R.string.update_verified, manifest.sha256.take(12))
        primary.visibility = View.VISIBLE
        primary.isEnabled = true
        primary.text = activity.getString(R.string.update_install)
        primary.setOnClickListener { launchInstaller() }
        secondary.visibility = View.VISIBLE
        secondary.isEnabled = true
        secondary.text = activity.getString(R.string.update_not_now)
        secondary.setOnClickListener { hide() }
        banner.visibility = View.VISIBLE
    }

    private fun showTerminal(message: String, loud: Boolean) {
        title.text =
            activity.getString(
                if (loud) R.string.update_refused_title else R.string.update_problem_title,
            )
        detail.text = message
        progress.visibility = View.GONE
        primary.visibility = View.GONE
        secondary.visibility = View.VISIBLE
        secondary.isEnabled = true
        secondary.text = activity.getString(R.string.update_dismiss)
        secondary.setOnClickListener { hide() }
        banner.visibility = View.VISIBLE
    }

    // --------------------------------------------------------------- install

    /**
     * Hands the **verified** file to the platform installer. Reached only
     * from [showReady], which is reached only from
     * [UpdateService.DownloadOutcome.Ok] — i.e. only after the SHA-256 and
     * signer-certificate gates in [UpdateService.download] have both passed.
     *
     * `ACTION_VIEW` with the package-archive MIME type is a *request*: the
     * system installer opens, shows the app being installed and requires the
     * user to confirm. There is no silent-install path here and none is
     * wanted — `REQUEST_INSTALL_PACKAGES` grants the right to ask, nothing
     * more.
     */
    private fun launchInstaller() {
        val file = verifiedApk ?: return
        if (!file.isFile) {
            showTerminal(activity.getString(R.string.update_failed_storage), loud = false)
            return
        }
        if (!activity.packageManager.canRequestPackageInstalls()) {
            showNeedsPermission()
            return
        }
        val uri =
            try {
                FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            } catch (_: IllegalArgumentException) {
                showTerminal(activity.getString(R.string.update_failed_storage), loud = false)
                return
            }
        val intent =
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        try {
            activity.startActivity(intent)
            hide()
        } catch (_: ActivityNotFoundException) {
            showTerminal(activity.getString(R.string.update_failed_no_installer), loud = false)
        }
    }

    private fun showNeedsPermission() {
        title.text = activity.getString(R.string.update_permission_title)
        detail.text = activity.getString(R.string.update_permission_detail)
        primary.visibility = View.VISIBLE
        primary.isEnabled = true
        primary.text = activity.getString(R.string.update_open_settings)
        primary.setOnClickListener {
            val intent =
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${activity.packageName}"),
                )
            try {
                activity.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                showTerminal(activity.getString(R.string.update_permission_detail), loud = false)
            }
        }
        secondary.visibility = View.VISIBLE
        secondary.isEnabled = true
        secondary.text = activity.getString(R.string.update_dismiss)
        secondary.setOnClickListener { hide() }
        banner.visibility = View.VISIBLE
    }

    // --------------------------------------------------------------- plumbing

    private fun submit(block: () -> Unit): Boolean {
        val ex = executor ?: return false
        return try {
            ex.execute(block)
            true
        } catch (_: RejectedExecutionException) {
            // Activity is going away; there is nothing to report to.
            false
        }
    }

    companion object {
        private const val PREFS = "bamform_update"
        private const val KEY_LAST_CHECK = "last_check_at"
        private const val KEY_DISMISSED = "dismissed_version_code"

        /**
         * One check per six hours, persisted across restarts.
         *
         * Wall-clock (`System.currentTimeMillis`), not `SystemClock` uptime:
         * uptime resets on reboot, so a tablet that is charged and rebooted
         * every shift would check on every boot — the throttle has to survive
         * exactly the event that makes it matter. The cost is that the clock
         * can move backwards, which [check] handles explicitly.
         */
        const val CHECK_INTERVAL_MS = 6L * 60L * 60L * 1000L

        /** Long enough that the WebView owns the first seconds of the app. */
        const val CHECK_DELAY_MS = 4_000L

        private fun prefs(context: Context) =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /**
         * Test/ops hook: force the next launch to check. Not wired to any UI —
         * `adb shell run-as` or clearing the prefs file is how a provisioner
         * re-arms it.
         */
        @Suppress("unused")
        fun resetThrottle(context: Context) {
            prefs(context).edit().remove(KEY_LAST_CHECK).apply()
        }
    }
}
