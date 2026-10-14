package com.chatlan.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebView
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.UUID

/** Implementa en Kotlin los comandos #[tauri::command] de main.rs, expuestos al frontend vía window.__TAURI__.core.invoke. */
class Bridge(private val act: MainActivity, private val web: WebView) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @JavascriptInterface
    fun invoke(id: Int, cmd: String, args: String) {
        scope.launch {
            try {
                val r = handle(cmd, JSONObject(args))
                resolve(id, true, r)
            } catch (e: Throwable) {
                resolve(id, false, JSONObject.quote(e.message ?: e.toString()))
            }
        }
    }

    @JavascriptInterface fun moveToBack() { act.runOnUiThread { act.moveTaskToBack(true) } }
    @JavascriptInterface fun cacheDir(): String = Engine.tempDir("chatlan_files").absolutePath

    private fun resolve(id: Int, ok: Boolean, json: String) {
        web.post { web.evaluateJavascript("window.__tauriResolve($id,$ok,$json)", null) }
    }

    private fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k)
    private fun JSONArray.bytes(): ByteArray = ByteArray(length()) { getInt(it).toByte() }
    private fun q(s: String?) = if (s == null) "null" else JSONObject.quote(s)

    /** Solo se permite tocar archivos dentro del almacenamiento privado de la app. */
    private fun safe(path: String): File {
        val f = File(path).canonicalFile
        val ok = listOf(Engine.ctx.cacheDir, Engine.ctx.filesDir).any { f.path.startsWith(it.canonicalPath + File.separator) }
        if (!ok) throw IOException("ruta no permitida")
        return f
    }

    private fun mimeOf(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return when (ext) {
            "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"
            "webp" -> "image/webp"; "bmp" -> "image/bmp"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        }
    }

    private fun dataFile(name: String) = File(Engine.dataDir, name)

    private suspend fun handle(cmd: String, a: JSONObject): String = when (cmd) {
        "get_self_name" -> q(Engine.selfName)
        "set_self_name" -> { a.optString("name").trim().takeIf { it.isNotEmpty() }?.let { Engine.selfName = it }; "null" }
        "get_self_id" -> q(Engine.selfId)
        "list_peers" -> Engine.listPeers().toString()
        "poll_messages" -> Engine.drain().toString()
        "start_discovery" -> { Engine.startDiscovery(); "null" }
        "re_announce" -> { Engine.reAnnounce(); "null" }

        "send_text" -> {
            val msgId = UUID.randomUUID().toString()
            val m = JSONObject().put("kind", "Text").put("id", Engine.selfId).put("msg_id", msgId)
                .put("from", Engine.selfName).put("body", a.optString("body")).put("ts", Engine.nowTs())
                .put("reply_to", a.str("replyTo") ?: JSONObject.NULL)
                .put("reply_body", a.str("replyBody") ?: JSONObject.NULL)
                .put("reply_from", a.str("replyFrom") ?: JSONObject.NULL)
            Engine.sendToPeer(a.getString("peerId"), m)
            q(msgId)
        }
        "send_reply_from_notif" -> {
            val msgId = UUID.randomUUID().toString(); val ts = Engine.nowTs()
            val m = JSONObject().put("kind", "Text").put("id", Engine.selfId).put("msg_id", msgId)
                .put("from", Engine.selfName).put("body", a.optString("body")).put("ts", ts)
                .put("reply_to", a.str("replyTo") ?: JSONObject.NULL)
                .put("reply_body", a.str("replyBody") ?: JSONObject.NULL)
                .put("reply_from", a.str("replyFrom") ?: JSONObject.NULL)
            Engine.sendToPeer(a.getString("peerId"), m)
            act.emit("notif-reply-echo", JSONObject().put("peerId", a.getString("peerId"))
                .put("body", a.optString("body")).put("ts", ts).put("msgId", msgId).toString())
            "null"
        }
        "send_typing" -> { Engine.sendToPeer(a.getString("peerId"), JSONObject().put("kind", "Typing").put("id", Engine.selfId).put("from", Engine.selfName)); "null" }
        "send_read_receipt" -> { Engine.sendToPeer(a.getString("peerId"), JSONObject().put("kind", "Read").put("id", Engine.selfId).put("from", Engine.selfName)); "null" }
        "send_delete_message" -> { Engine.sendToPeer(a.getString("peerId"), JSONObject().put("kind", "DeleteMessage").put("id", Engine.selfId).put("msg_id", a.getString("msgId"))); "null" }
        "send_reaction" -> {
            Engine.sendToPeer(a.getString("peerId"), JSONObject().put("kind", "Reaction").put("id", Engine.selfId)
                .put("msg_id", a.getString("msgId")).put("emoji", a.getString("emoji")).put("action", a.getString("action")))
            "null"
        }

        "send_file_path" -> { Engine.sendFile(a.getString("peerId"), safe(a.getString("path")).path); "null" }
        "send_clipboard_image" -> {
            val f = File(Engine.tempDir("chatlan_images"), "${UUID.randomUUID()}.png")
            f.writeBytes(a.getJSONArray("data").bytes())
            try { Engine.sendFile(a.getString("peerId"), f.path) } finally { f.delete() }
            "null"
        }
        "read_clipboard_image" -> act.clipboardImageBytes()?.let { b ->
            val sb = StringBuilder(b.size * 4 + 2).append('[')
            for (i in b.indices) { if (i > 0) sb.append(','); sb.append(b[i].toInt() and 0xFF) }
            sb.append(']').toString()
        } ?: "null"
        "save_temp_image" -> q(File(Engine.tempDir("chatlan_images"), "${UUID.randomUUID()}.${a.optString("ext", "png").filter { it.isLetterOrDigit() }}")
            .also { it.writeBytes(a.getJSONArray("data").bytes()) }.absolutePath)
        "save_temp_file" -> q(File(Engine.tempDir("chatlan_files"), "${UUID.randomUUID()}.${a.optString("ext", "bin").filter { it.isLetterOrDigit() }}")
            .also { it.writeBytes(a.getJSONArray("data").bytes()) }.absolutePath)
        "delete_temp_file" -> { runCatching { safe(a.getString("path")).delete() }; "null" }
        "get_file_size" -> safe(a.getString("path")).length().toString()
        "read_file_as_base64" -> {
            val f = safe(a.getString("path"))
            q("data:${mimeOf(f.name)};base64," + Base64.encodeToString(f.readBytes(), Base64.NO_WRAP))
        }

        "open_file_dialog" -> {
            val uri = act.pick(arrayOf("*/*"))
            if (uri == null) "null" else {
                val (name, _) = act.queryName(uri)
                val dir = File(Engine.tempDir("chatlan_picked"), UUID.randomUUID().toString()).apply { mkdirs() }
                val dest = File(dir, name.replace(Regex("[\\\\/:*?\"<>|]"), "_"))
                act.contentResolver.openInputStream(uri)!!.use { i -> dest.outputStream().use { o -> i.copyTo(o) } }
                JSONObject().put("path", dest.absolutePath).put("size", dest.length()).toString()
            }
        }
        "open_image" -> { act.openFile(safe(a.getString("path"))); "null" }
        "save_as_dialog" -> act.saveAs(safe(a.getString("sourcePath")), a.optString("defaultName", "archivo")).toString()

        "save_avatar" -> {
            val uri = act.pick(arrayOf("image/*"))
            if (uri == null) "null" else {
                val png = scaleToPng(act.contentResolver.openInputStream(uri)!!.use { it.readBytes() }, 256)
                dataFile("avatar.png").writeBytes(png)
                q("data:image/png;base64," + Base64.encodeToString(png, Base64.NO_WRAP))
            }
        }
        "load_avatar" -> dataFile("avatar.png").takeIf { it.exists() }
            ?.let { q("data:image/png;base64," + Base64.encodeToString(it.readBytes(), Base64.NO_WRAP)) } ?: "null"
        "clear_avatar" -> { dataFile("avatar.png").delete(); "null" }
        "get_avatars" -> JSONObject().also { o -> Engine.avatars.forEach { (k, v) -> o.put(k, v) } }.toString()
        "broadcast_avatar" -> {
            val b64 = a.optString("avatarB64")
            Engine.avatars[Engine.selfId] = b64
            val m = Engine.avatarMsg(b64)
            Engine.peerIds().forEach { runCatching { Engine.sendToPeer(it, m) } }
            "null"
        }

        "send_call" -> {
            Engine.sendCall(a.getString("peerId"), a.optString("callId"), a.optString("op"),
                a.optBoolean("video"), a.optString("data")); "null"
        }
        "call_fgs" -> {
            runCatching {
                androidx.core.content.ContextCompat.startForegroundService(Engine.ctx,
                    android.content.Intent(Engine.ctx, ChatService::class.java).setAction(if (a.optBoolean("on")) "mic_on" else "mic_off"))
            }
            "null"
        }
        "call_audio" -> {
            val am = Engine.ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            val on = a.optBoolean("on")
            am.mode = if (on) android.media.AudioManager.MODE_IN_COMMUNICATION else android.media.AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION") am.isSpeakerphoneOn = on && a.optBoolean("speaker")
            "null"
        }
        "call_speaker" -> {
            val am = Engine.ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            @Suppress("DEPRECATION") am.isSpeakerphoneOn = a.optBoolean("on")
            "null"
        }
        "relay_notify" -> {   // mensajes/llamadas llegados por el servidor: mismas notificaciones que los de la LAN
            val m = a.getJSONObject("msg")
            when (m.optString("kind")) {
                "Text" -> if (!Engine.appVisible) Notifier.message(m.optString("id"), m.optString("from"), m.optString("body"))
                "FileStart" -> if (!Engine.appVisible) Notifier.message(m.optString("sender_id"), m.optString("from"), "Archivo: ${m.optString("filename")}")
                "Call" -> when (m.optString("op")) {
                    "invite" -> if (!Engine.appVisible) Notifier.call(m.optString("id"), m.optString("from"), m.optBoolean("video"))
                    "end", "reject" -> Notifier.cancel(m.optString("id"))
                }
            }
            "null"
        }
        "show_notification" -> "null" // las notificaciones las emite Engine/Notifier aunque la UI esté en segundo plano
        "save_history" -> { dataFile("history.json").writeText(a.optString("data")); "null" }
        "load_history" -> q(dataFile("history.json").takeIf { it.exists() }?.readText() ?: "")
        "save_nick" -> { dataFile("nick.txt").writeText(a.optString("name")); "null" }
        "load_nick" -> q(dataFile("nick.txt").takeIf { it.exists() }?.readText()?.trim() ?: "")
        "save_settings" -> {
            dataFile("settings.json").writeText(JSONObject().put("sound_enabled", a.optBoolean("soundEnabled"))
                .put("audio_device", a.optString("audioDevice")).put("font_size", a.optInt("fontSize", 14))
                .put("emoji_size", a.optInt("emojiSize", 20)).toString())
            "null"
        }
        "load_settings" -> dataFile("settings.json").takeIf { it.exists() }?.readText()
            ?: JSONObject().put("sound_enabled", false).put("audio_device", "").put("font_size", 14).put("emoji_size", 20).toString()
        "save_window_state", "set_always_on_top", "show_about" -> "null"
        "load_window_state" -> """{"x":null,"y":null,"w":null,"h":null}"""
        else -> throw IOException("comando no soportado en Android: $cmd")
    }

    private fun scaleToPng(src: ByteArray, maxSide: Int): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(src, 0, src.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) sample *= 2
        val bmp = BitmapFactory.decodeByteArray(src, 0, src.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IOException("imagen no valida")
        val k = minOf(1f, maxSide.toFloat() / maxOf(bmp.width, bmp.height))
        val scaled = Bitmap.createScaledBitmap(bmp, maxOf(1, (bmp.width * k).toInt()), maxOf(1, (bmp.height * k).toInt()), true)
        return ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
}
