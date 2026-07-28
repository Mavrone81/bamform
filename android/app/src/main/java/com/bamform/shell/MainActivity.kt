package com.bamform.shell

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.WebViewCompat
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The whole app: a WebView that boots straight into BamForm at the
 * configured origin (default https://form.bevorasg.com, last-used origin
 * persisted). The server is re-pointed from INSIDE the web app's sign-in
 * screen via [ShellBridge]; the native offline card below is the error path
 * only — it exists because an unreachable server cannot serve the page that
 * would otherwise host the server field.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var offlineCard: View
    private lateinit var offlineDetail: TextView
    private lateinit var serverField: EditText
    private lateinit var httpWarning: TextView
    private lateinit var connectButton: Button
    private lateinit var statusText: TextView

    private lateinit var executor: ExecutorService
    private val mainHandler = Handler(Looper.getMainLooper())

    private var configuredOrigin: String = ServerConfig.DEFAULT_URL
    private var switching = false

    /**
     * Set when the main frame failed (transport error, or an HTTP 5xx —
     * review A-4) and CONSUMED by the next `onPageFinished`, which is what
     * decides whether the card stays up.
     *
     * It is not a plain "did it fail" boolean cleared in `onPageStarted`,
     * because measurement (emulator, API 34, WebView 113) shows the callback
     * order for an HTTP error is:
     *   onReceivedHttpError → onPageStarted → onPageFinished
     * i.e. the START arrives AFTER the error. Clearing on start therefore
     * wiped the failure and `onPageFinished` hid the card again — exactly
     * the bug that let the reviewer's 502 through with no card at all.
     */
    private var pendingErrorDetail: String? = null

    private val shellBridge = ShellBridge(this)
    private var bridgeInstalled = false

    /** A-3: Back must not walk back onto the server we just left. */
    private var clearHistoryOnNextLoad = false

    /** A-7: set when the renderer crashed past its budget and the WebView is
     * gone; Retry then rebuilds the activity instead of touching it. */
    private var webViewDead = false

    /** A-6: the probe is a native, CORS-free request generator. Even with the
     * origin allow-list closing the hostile-caller case, it must not be
     * usable as a port scanner — one probe per [MIN_PROBE_INTERVAL_MS] is
     * far above any human's tapping speed and far below a scanner's. */
    private var lastProbeStartedAt = 0L

    enum class SwitchSource { BRIDGE, CARD }

    // ---- file chooser / camera state ----
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingChooserParams: WebChromeClient.FileChooserParams? = null
    private var cameraOutputUri: Uri? = null

    private val chooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            onChooserResult(result)
        }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            // Granted or not, show the chooser; the camera entry is simply
            // omitted when permission is missing (gallery/files still work).
            launchChooser()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configuredOrigin = ServerConfig.get(this)
        executor = Executors.newSingleThreadExecutor()

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)
        offlineCard = findViewById(R.id.offlineCard)
        offlineDetail = findViewById(R.id.offlineDetail)
        serverField = findViewById(R.id.serverField)
        httpWarning = findViewById(R.id.httpWarning)
        connectButton = findViewById(R.id.connectButton)
        statusText = findViewById(R.id.statusText)

        setUpWebView()
        wireOfflineCard()
        wireBack()

        webView.loadUrl(configuredOrigin)
    }

    // JS is the entire point of a WebView shell for a JS application; the
    // XSS surface belongs to the web app and its CSP, not this wrapper.
    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        with(webView.settings) {
            // The PWA needs the full storage stack: JS, localStorage,
            // IndexedDB (offline outbox) and WebSQL-era database flag.
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            // Hygiene: the shell never serves file:// content.
            allowFileAccess = false
            allowContentAccess = true
        }
        // Service workers are on by default in modern WebView when JS is
        // enabled — nothing to configure, and nothing here disables them.

        // The HttpOnly refresh cookie must survive app restarts, like Chrome.
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        // The sign-in page's Server disclosure talks to this, and ONLY from
        // the configured origin. See ShellBridge for why this is not
        // addJavascriptInterface.
        installBridge()

        webView.webViewClient =
            object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val url = request.url.toString()
                    val isHttp = url.startsWith("http://") || url.startsWith("https://")
                    if (isHttp && ServerConfig.sameOrigin(configuredOrigin, url)) {
                        return false // the app itself — stay in the WebView
                    }
                    // Anything else (external links, mailto:, tel:) goes to
                    // the system, never rendered inside the shell. This also
                    // keeps ShellBridge confined to the configured origin.
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, request.url))
                        true
                    } catch (_: ActivityNotFoundException) {
                        true // swallow rather than navigating the WebView away
                    }
                }

                override fun onPageStarted(
                    view: WebView,
                    url: String?,
                    favicon: android.graphics.Bitmap?,
                ) {
                    // Deliberately does NOT clear pendingErrorDetail — see
                    // the field's comment: for HTTP errors this callback
                    // arrives after the error, not before it. The flag is
                    // consumed in onPageFinished instead.
                    //
                    // A-2 / A-3, second layer. shouldOverrideUrlLoading is
                    // documented as NOT called for POST navigations, and is
                    // not called for history navigations either — the
                    // reviewer took the main frame off-origin both ways. By
                    // the time a main frame STARTS loading we can still stop
                    // it. The bridge is already origin-scoped, so this is not
                    // load-bearing for the JS trust boundary; it is here so
                    // an attacker page cannot render full-screen inside the
                    // shell's chrome and impersonate BamForm.
                    if (url != null && isOffOriginDocument(url)) {
                        view.stopLoading()
                        mainHandler.post { returnToConfiguredOrigin() }
                    }
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (request.isForMainFrame) {
                        failMainFrame(getString(R.string.offline_detail, configuredOrigin))
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: WebResourceResponse,
                ) {
                    // A-4. An HTTP 5xx is not a "load failure" to
                    // WebViewClient, so onReceivedError never fires and the
                    // user used to land on a raw nginx error page with no
                    // Retry and no server field — precisely the state of
                    // form.bevorasg.com during every `docker compose up
                    // --build` deploy window.
                    //
                    // Only 5xx and only the main frame. 401/403/404 are the
                    // SPA's own business (auth flows, deep links) and must
                    // not be hijacked by the native card; subresource errors
                    // are the page's problem, not the shell's.
                    if (!request.isForMainFrame) return
                    val status = errorResponse.statusCode
                    if (status < 500 || status > 599) return
                    // Stop before the error body paints: the technician must
                    // never see nginx's page, even for a frame.
                    view.stopLoading()
                    failMainFrame(
                        getString(R.string.offline_detail_http, configuredOrigin, status),
                    )
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    // Consume-once: a failure recorded for THIS navigation
                    // keeps the card up; anything else means the load
                    // succeeded and the card must go.
                    val failure = pendingErrorDetail
                    pendingErrorDetail = null
                    if (failure != null) showOfflineCard(failure) else hideOfflineCard()
                    if (clearHistoryOnNextLoad) {
                        // A-3: after a server switch, one Back press used to
                        // walk straight onto the PREVIOUS server's cached
                        // sign-in page, rendered inside the shell. An admin
                        // re-points a tablet away from a decommissioned or
                        // compromised server precisely so that cannot happen.
                        // Must run after the new page commits, or WebView
                        // keeps the entry.
                        clearHistoryOnNextLoad = false
                        view.clearHistory()
                    }
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail,
                ): Boolean {
                    // Renderer died (OOM/crash): tear the WebView down and
                    // rebuild the activity instead of dying with it.
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                    // A-7: recreate() reloads the same URL, so a page that
                    // reliably OOMs a low-memory tablet used to produce an
                    // unbounded crash/recreate loop. Budget the retries
                    // (statically — recreate() makes a NEW activity instance,
                    // so an instance field would reset every lap) and fall
                    // back to the card, which offers Retry and a different
                    // server.
                    val now = SystemClock.elapsedRealtime()
                    if (now - firstRendererCrashAt > CRASH_WINDOW_MS) {
                        firstRendererCrashAt = now
                        rendererCrashes = 0
                    }
                    rendererCrashes += 1
                    if (rendererCrashes <= MAX_RENDERER_CRASHES) {
                        recreate()
                    } else {
                        webViewDead = true
                        showOfflineCard(getString(R.string.offline_detail_crash))
                    }
                    return true
                }
            }

        webView.webChromeClient =
            object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = callback
                    pendingChooserParams = params
                    val wantsCamera =
                        params.isCaptureEnabled ||
                            params.acceptTypes.orEmpty().any {
                                it.isNullOrBlank() || it.startsWith("image")
                            }
                    if (wantsCamera && !hasCameraPermission()) {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    } else {
                        launchChooser()
                    }
                    return true
                }
            }
    }

    // ---- the JS channel (origin-scoped) ----

    /** The origin the shell is currently pointed at. Read by [ShellBridge]. */
    fun currentOrigin(): String = configuredOrigin

    /**
     * (Re)register the message listener so its allow-list contains exactly
     * the configured origin — which is why this must run again on every
     * switch, not once at startup.
     *
     * If the device's WebView is too old for origin-scoped listeners the
     * shell installs nothing. It does NOT fall back to
     * `addJavascriptInterface`: that is the hijackable design the review
     * rejected, and a missing in-page field (the native card still re-points
     * the device) is strictly better than a bridge any frame can reach.
     */
    private fun installBridge() {
        if (!ShellBridge.isSupported()) return
        if (bridgeInstalled) {
            WebViewCompat.removeWebMessageListener(webView, ShellBridge.CHANNEL)
            bridgeInstalled = false
        }
        try {
            WebViewCompat.addWebMessageListener(
                webView,
                ShellBridge.CHANNEL,
                setOf(configuredOrigin),
                shellBridge,
            )
            bridgeInstalled = true
        } catch (_: IllegalArgumentException) {
            // The allow-list rule was rejected (a normalised origin should
            // never be, but fail CLOSED if it ever is): no channel at all.
            bridgeInstalled = false
        }
    }

    // ---- server switching (bridge + offline card share this path) ----

    /**
     * Validate + rate-limit + health-check [raw]; only then persist and
     * reload. Called on the UI thread from either the message listener or
     * the card. [onResult] (bridge only) receives null on success or a
     * user-facing message on failure, so the web control can show the
     * failure INLINE rather than guessing with a timer (review W-2).
     * The WebView stays on the current origin unless the probe passes.
     */
    fun requestServerSwitch(
        raw: String,
        source: SwitchSource,
        onResult: ((String?) -> Unit)? = null,
    ) {
        val fromBridge = source == SwitchSource.BRIDGE
        val origin = ServerConfig.normalize(raw)
        if (origin == null) {
            reportSwitchResult(getString(R.string.err_invalid_url), fromBridge, onResult)
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (now - lastProbeStartedAt < MIN_PROBE_INTERVAL_MS) {
            // A-6: refuse to be a scanner. A human retyping an address never
            // hits this; a loop polling for open ports always does.
            reportSwitchResult(getString(R.string.err_too_fast), fromBridge, onResult)
            return
        }
        synchronized(this) {
            if (switching) return
            switching = true
        }
        lastProbeStartedAt = now
        if (!fromBridge) {
            connectButton.isEnabled = false
            showStatus(getString(R.string.server_checking), ok = null)
        }
        try {
            executor.execute {
                val error = HealthCheck.probe(this, origin)
                mainHandler.post {
                    switching = false
                    if (isFinishing || isDestroyed) return@post
                    connectButton.isEnabled = true
                    if (error == null) {
                        ServerConfig.set(this, origin)
                        configuredOrigin = origin
                        // The allow-list must follow the origin, or the new
                        // server gets no channel (and the OLD one would keep
                        // it).
                        installBridge()
                        if (fromBridge) {
                            Toast.makeText(this, R.string.server_switched, Toast.LENGTH_SHORT)
                                .show()
                        }
                        hideOfflineCard()
                        clearHistoryOnNextLoad = true
                        webView.loadUrl(configuredOrigin)
                        onResult?.invoke(null)
                    } else {
                        reportSwitchResult(error, fromBridge, onResult)
                    }
                }
            }
        } catch (_: RejectedExecutionException) {
            // A-8: onDestroy() has already shut the executor down. Releasing
            // the latch matters — it used to stay true forever.
            switching = false
            reportSwitchResult(getString(R.string.err_generic, "shutting down"), fromBridge, onResult)
        }
    }

    private fun reportSwitchResult(
        message: String,
        fromBridge: Boolean,
        onResult: ((String?) -> Unit)? = null,
    ) {
        mainHandler.post {
            if (isFinishing || isDestroyed) return@post
            onResult?.invoke(message)
            if (fromBridge) {
                // The web control shows this inline via onResult; a toast as
                // well would double-report. Toast only when there is no page
                // able to render it.
                if (offlineCard.visibility == View.VISIBLE) showStatus(message, ok = false)
            } else if (offlineCard.visibility == View.VISIBLE) {
                showStatus(message, ok = false)
            } else {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }
    }

    // ---- off-origin main-frame guard (POST / history navigations) ----

    private fun isOffOriginDocument(url: String): Boolean {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        return !ServerConfig.sameOrigin(configuredOrigin, url)
    }

    private fun returnToConfiguredOrigin() {
        if (isFinishing || isDestroyed || webViewDead) return
        Toast.makeText(this, R.string.err_offorigin_blocked, Toast.LENGTH_LONG).show()
        clearHistoryOnNextLoad = true
        webView.loadUrl(configuredOrigin)
    }

    // ---- native offline card (error path only) ----

    private fun wireOfflineCard() {
        findViewById<Button>(R.id.retryButton).setOnClickListener {
            if (webViewDead) {
                // A-7: the WebView was destroyed after repeated renderer
                // crashes. Rebuild the activity; the budget re-arms because
                // the crash window will have elapsed (or the user will see
                // this card again immediately, which is the honest answer).
                recreate()
                return@setOnClickListener
            }
            hideOfflineCard()
            val current = webView.url
            if (current != null) webView.reload() else webView.loadUrl(configuredOrigin)
        }
        serverField.addTextChangedListener(
            object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}

                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}

                override fun afterTextChanged(s: Editable?) = refreshHttpWarning()
            },
        )
        serverField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                requestServerSwitch(serverField.text.toString(), SwitchSource.CARD)
                true
            } else {
                false
            }
        }
        connectButton.setOnClickListener {
            requestServerSwitch(serverField.text.toString(), SwitchSource.CARD)
        }
    }

    private fun refreshHttpWarning() {
        val normalized = ServerConfig.normalize(serverField.text.toString())
        httpWarning.visibility =
            if (ServerConfig.isHttp(normalized)) View.VISIBLE else View.GONE
    }

    /** Record the failure for onPageFinished to consume, and show the card
     * now so the user is never looking at a blank or foreign page while the
     * navigation winds down. */
    private fun failMainFrame(detail: String) {
        pendingErrorDetail = detail
        showOfflineCard(detail)
    }

    private fun showOfflineCard(detail: String) {
        offlineDetail.text = detail
        serverField.setText(configuredOrigin)
        refreshHttpWarning()
        statusText.visibility = View.GONE
        offlineCard.visibility = View.VISIBLE
    }

    private fun hideOfflineCard() {
        offlineCard.visibility = View.GONE
    }

    private fun showStatus(message: String, ok: Boolean?) {
        statusText.visibility = View.VISIBLE
        statusText.text = message
        val color =
            when (ok) {
                true -> R.color.signal_good
                false -> R.color.destructive
                null -> R.color.ink_soft
            }
        statusText.setTextColor(ContextCompat.getColor(this, color))
    }

    // ---- back handling ----

    private fun wireBack() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (offlineCard.visibility != View.VISIBLE && webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            },
        )
    }

    // ---- lifecycle ----

    override fun onStop() {
        super.onStop()
        // Persist the WebView cookie jar (incl. the HttpOnly refresh cookie)
        // so a swipe-away or process death does not log the user out.
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::executor.isInitialized) executor.shutdownNow()
        if (::webView.isInitialized && !webViewDead) {
            if (bridgeInstalled && ShellBridge.isSupported()) {
                try {
                    WebViewCompat.removeWebMessageListener(webView, ShellBridge.CHANNEL)
                } catch (_: Exception) {
                    // Already gone with the WebView; nothing to unwind.
                }
                bridgeInstalled = false
            }
            webView.destroy()
        }
    }

    companion object {
        /** A-6: one health probe per this many ms, whatever asks for it. */
        private const val MIN_PROBE_INTERVAL_MS = 3_000L

        /** A-7: renderer-crash budget, static because recreate() replaces
         * the activity instance. */
        private const val MAX_RENDERER_CRASHES = 3
        private const val CRASH_WINDOW_MS = 60_000L

        @Volatile private var rendererCrashes = 0

        @Volatile private var firstRendererCrashAt = 0L
    }

    // ---- file chooser / camera ----

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    private fun launchChooser() {
        val params = pendingChooserParams
        val contentIntent =
            params?.createIntent()
                ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }

        cameraOutputUri = null
        val extraIntents = mutableListOf<Intent>()
        if (hasCameraPermission()) {
            try {
                val dir = File(cacheDir, "captures").apply { mkdirs() }
                val photo = File(dir, "capture-${System.currentTimeMillis()}.jpg")
                val uri =
                    FileProvider.getUriForFile(this, "$packageName.fileprovider", photo)
                val camera =
                    Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                        .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                        .addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                                Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                        )
                cameraOutputUri = uri
                extraIntents.add(camera)
            } catch (_: Exception) {
                // No camera app / provider issue: chooser still offers files.
            }
        }

        val chooser =
            Intent.createChooser(contentIntent, getString(R.string.chooser_title)).apply {
                if (extraIntents.isNotEmpty()) {
                    putExtra(Intent.EXTRA_INITIAL_INTENTS, extraIntents.toTypedArray())
                }
            }
        try {
            chooserLauncher.launch(chooser)
        } catch (_: ActivityNotFoundException) {
            filePathCallback?.onReceiveValue(null)
            filePathCallback = null
        }
    }

    private fun onChooserResult(result: ActivityResult) {
        val callback = filePathCallback ?: return
        filePathCallback = null
        val capturedUri = cameraOutputUri
        cameraOutputUri = null

        if (result.resultCode != RESULT_OK) {
            callback.onReceiveValue(null)
            return
        }

        val data = result.data
        val uris: Array<Uri>? =
            when {
                // Picker result (single or multiple)
                data?.data != null || data?.clipData != null ->
                    WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
                // Camera result: intent data is empty, the image is at
                // the EXTRA_OUTPUT uri we handed the camera app.
                capturedUri != null -> arrayOf(capturedUri)
                else -> null
            }
        callback.onReceiveValue(uris)
    }
}
