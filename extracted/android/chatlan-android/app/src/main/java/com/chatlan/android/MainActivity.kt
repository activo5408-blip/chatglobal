package com.chatlan.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity() {
    lateinit var web: WebView
    private var pickDef: CompletableDeferred<Uri?>? = null
    private var saveDef: CompletableDeferred<Uri?>? = null
    private var pendingPerm: PermissionRequest? = null
    private var pageLoaded = false

    private val pickLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { pickDef?.complete(it) }
    private val saveLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { saveDef?.complete(it) }
    private val mediaPermsLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val req = pendingPerm; pendingPerm = null
        if (req != null) {
            val ok = req.resources.filter { grantedFor(it) }
            if (ok.isEmpty()) req.deny() else req.grant(ok.toTypedArray())
        }
    }

    private fun grantedFor(res: String): Boolean = when (res) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE ->
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        PermissionRequest.RESOURCE_VIDEO_CAPTURE ->
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        else -> false
    }

    private var micDef: CompletableDeferred<Boolean>? = null
    private val micLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { micDef?.complete(it) }
    private val notifLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifier.createChannels(this)
        ContextCompat.startForegroundService(this, Intent(this, ChatService::class.java))
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/cache/", WebViewAssetLoader.InternalStoragePathHandler(this, File(cacheDir, "chatlan_files").apply { mkdirs() }))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#0E1420"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // permite ws:// a un servidor propio en LAN
            addJavascriptInterface(Bridge(this@MainActivity, this), "AndroidBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                    loader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host != "appassets.androidplatform.net" &&
                        (request.url.scheme == "http" || request.url.scheme == "https")) {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    pageLoaded = true
                    view.postDelayed({ handleIntent(intent) }, 1500)
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    runOnUiThread {
                        val wanted = request.resources.filter {
                            it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE
                        }
                        if (wanted.isEmpty()) { request.deny(); return@runOnUiThread }
                        val need = ArrayList<String>()
                        if (wanted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !grantedFor(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                            need.add(Manifest.permission.RECORD_AUDIO)
                        if (wanted.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !grantedFor(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                            need.add(Manifest.permission.CAMERA)
                        if (need.isEmpty()) request.grant(wanted.toTypedArray())
                        else { pendingPerm?.deny(); pendingPerm = request; mediaPermsLauncher.launch(need.toTypedArray()) }
                    }
                }
            }
        }

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0E1420"))
            addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        setContentView(root)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsetsCompat.CONSUMED
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__androidBack && window.__androidBack()") { r ->
                    if (r != "true") moveTaskToBack(true)
                }
            }
        })

        web.loadUrl("https://appassets.androidplatform.net/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (pageLoaded) handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        val peerId = i?.getStringExtra("peerId") ?: return
        i.removeExtra("peerId")
        Notifier.cancel(peerId)
        emit("notif-open-chat", JSONObject().put("peerId", peerId).put("peerName", i.getStringExtra("peerName") ?: "").toString())
    }

    override fun onStart() { super.onStart(); Engine.appVisible = true }
    override fun onStop() { Engine.appVisible = false; super.onStop() }

    fun emit(name: String, payloadJson: String) {
        web.post { web.evaluateJavascript("window.__tauriEmit && window.__tauriEmit(${JSONObject.quote(name)}, $payloadJson)", null) }
    }

    // ---- utilidades que usa Bridge ----
    suspend fun ensureMic(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) return true
        val d = CompletableDeferred<Boolean>(); micDef = d
        withContext(Dispatchers.Main) { micLauncher.launch(Manifest.permission.RECORD_AUDIO) }
        return d.await()
    }

    suspend fun pick(types: Array<String>): Uri? {
        val d = CompletableDeferred<Uri?>(); pickDef = d
        withContext(Dispatchers.Main) { pickLauncher.launch(types) }
        return d.await()
    }

    suspend fun saveAs(source: File, name: String): Boolean {
        val d = CompletableDeferred<Uri?>(); saveDef = d
        withContext(Dispatchers.Main) { saveLauncher.launch(name) }
        val uri = d.await() ?: return false
        contentResolver.openOutputStream(uri)!!.use { o -> source.inputStream().use { it.copyTo(o) } }
        return true
    }

    fun queryName(uri: Uri): Pair<String, Long> {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val s = c.getColumnIndex(OpenableColumns.SIZE)
                return (if (n >= 0) c.getString(n) else "archivo") to (if (s >= 0) c.getLong(s) else 0L)
            }
        }
        return "archivo" to 0L
    }

    fun openFile(f: File) {
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "*/*"
        runOnUiThread {
            runCatching {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
            }
        }
    }

    suspend fun clipboardImageBytes(): ByteArray? {
        val uri = withContext(Dispatchers.Main) {
            val clip = (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            val item = if (clip != null && clip.itemCount > 0) clip.getItemAt(0) else null
            if (item == null || !item.text.isNullOrEmpty()) null
            else item.uri?.takeIf { contentResolver.getType(it)?.startsWith("image/") == true }
        } ?: return null
        return withContext(Dispatchers.IO) { contentResolver.openInputStream(uri)?.use { it.readBytes() } }
    }
}
