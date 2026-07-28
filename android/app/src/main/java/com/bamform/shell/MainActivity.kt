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
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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
    private var mainFrameFailed = false
    private var switching = false

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

        // The sign-in page's Server disclosure talks to this. See ShellBridge
        // for the origin-confinement reasoning.
        webView.addJavascriptInterface(ShellBridge(this), "BamFormShell")

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
                    mainFrameFailed = false
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    if (request.isForMainFrame) {
                        mainFrameFailed = true
                        showOfflineCard()
                    }
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    if (!mainFrameFailed) hideOfflineCard()
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail,
                ): Boolean {
                    // Renderer died (OOM/crash): tear the WebView down and
                    // rebuild the activity instead of dying with it.
                    (view.parent as? ViewGroup)?.removeView(view)
                    view.destroy()
                    recreate()
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

    // ---- server switching (bridge + offline card share this path) ----

    /**
     * Validate + health-check [raw]; only then persist and reload. Called
     * from the ShellBridge binder thread or the UI thread — both safe.
     * Failures surface as a toast ([fromBridge]) or in the card's status
     * line, and the WebView stays on the current origin.
     */
    fun requestServerSwitch(raw: String, fromBridge: Boolean) {
        val origin = ServerConfig.normalize(raw)
        if (origin == null) {
            reportSwitchResult(getString(R.string.err_invalid_url), fromBridge)
            return
        }
        synchronized(this) {
            if (switching) return
            switching = true
        }
        if (!fromBridge) {
            mainHandler.post {
                connectButton.isEnabled = false
                showStatus(getString(R.string.server_checking), ok = null)
            }
        }
        executor.execute {
            val error = HealthCheck.probe(this, origin)
            mainHandler.post {
                switching = false
                if (isFinishing || isDestroyed) return@post
                connectButton.isEnabled = true
                if (error == null) {
                    ServerConfig.set(this, origin)
                    configuredOrigin = origin
                    if (fromBridge) {
                        Toast.makeText(this, R.string.server_switched, Toast.LENGTH_SHORT)
                            .show()
                    }
                    hideOfflineCard()
                    webView.loadUrl(configuredOrigin)
                } else {
                    reportSwitchResult(error, fromBridge)
                }
            }
        }
    }

    private fun reportSwitchResult(message: String, fromBridge: Boolean) {
        mainHandler.post {
            if (isFinishing || isDestroyed) return@post
            if (fromBridge || offlineCard.visibility != View.VISIBLE) {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            } else {
                showStatus(message, ok = false)
            }
        }
    }

    // ---- native offline card (error path only) ----

    private fun wireOfflineCard() {
        findViewById<Button>(R.id.retryButton).setOnClickListener {
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
                requestServerSwitch(serverField.text.toString(), fromBridge = false)
                true
            } else {
                false
            }
        }
        connectButton.setOnClickListener {
            requestServerSwitch(serverField.text.toString(), fromBridge = false)
        }
    }

    private fun refreshHttpWarning() {
        val normalized = ServerConfig.normalize(serverField.text.toString())
        httpWarning.visibility =
            if (ServerConfig.isHttp(normalized)) View.VISIBLE else View.GONE
    }

    private fun showOfflineCard() {
        offlineDetail.text = getString(R.string.offline_detail, configuredOrigin)
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
        if (::webView.isInitialized) webView.destroy()
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
