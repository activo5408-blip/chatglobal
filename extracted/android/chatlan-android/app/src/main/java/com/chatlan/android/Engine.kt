package com.chatlan.android

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.*
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

class Peer(
    val id: String,
    var name: String,
    var addr: String,
    val addrs: MutableList<String>,
    var online: Boolean = true,
    var idleSecs: Long = 0,
    var lastSeen: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("name", name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")).put("addr", addr)
        .put("addrs", JSONArray(addrs)).put("online", online).put("idle_secs", idleSecs)
}

private class FileRx(
    val id: String, val filename: String, val from: String, val senderId: String,
    val size: Long, val file: File, val raf: RandomAccessFile,
)

/** Port a Kotlin de network.rs: mismo protocolo en el cable (puertos 42345/42346, JSON con campo "kind"). */
object Engine {
    const val TCP_PORT = 42345
    const val UDP_PORT = 42346
    private const val PEER_TIMEOUT_MS = 10_000L
    private const val OFFLINE_GRACE_MS = 600_000L
    private const val CONNECT_TIMEOUT_MS = 400
    private const val MAX_ADDRS = 8
    private const val MAX_FRAME = 10 * 1024 * 1024
    private const val MAX_PENDING = 5000

    lateinit var ctx: Context
    lateinit var dataDir: File
    lateinit var selfId: String
    @Volatile var selfName: String = Build.MODEL ?: "Android"
    @Volatile var appVisible = false

    private val peers = LinkedHashMap<String, Peer>()
    private val pending = ArrayDeque<JSONObject>()
    val avatars = ConcurrentHashMap<String, String>()
    private val receivers = ConcurrentHashMap<String, FileRx>()
    private val tcpStarted = AtomicBoolean(false)
    private val udpStarted = AtomicBoolean(false)
    private var initialized = false

    fun init(c: Context) {
        if (initialized) return
        initialized = true
        ctx = c.applicationContext
        dataDir = File(ctx.filesDir, "ChatLAN").apply { mkdirs() }
        val idFile = File(dataDir, "peer_id.txt")
        selfId = idFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotEmpty() }
            ?: UUID.randomUUID().toString().also { idFile.writeText(it) }
        File(dataDir, "nick.txt").takeIf { it.exists() }?.readText()?.trim()
            ?.takeIf { it.isNotEmpty() }?.let { selfName = it }
    }

    fun tempDir(name: String): File = File(ctx.cacheDir, name).apply { mkdirs() }
    fun nowTs(): String = SimpleDateFormat("hh:mm a", Locale.US).format(Date())

    // ---------- cola de mensajes entrantes (poll_messages) ----------
    private fun enqueue(m: JSONObject) {
        synchronized(pending) {
            if (pending.size >= MAX_PENDING) pending.removeFirst()
            pending.addLast(m)
        }
    }

    fun drain(): JSONArray {
        val out = JSONArray()
        synchronized(pending) { while (pending.isNotEmpty()) out.put(sanitize(pending.removeFirst())) }
        return out
    }

    /** El frontend pinta estos campos con innerHTML: se neutraliza HTML enviado por otro peer de la LAN. */
    private fun sanitize(m: JSONObject): JSONObject {
        for (k in listOf("body", "filename", "from", "name", "reply_body", "reply_from", "emoji")) {
            if (m.has(k) && !m.isNull(k)) {
                val v = m.optString(k)
                m.put(k, v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            }
        }
        return m
    }

    // ---------- pares ----------
    private fun promote(addrs: MutableList<String>, a: String) {
        addrs.remove(a); addrs.add(0, a)
        while (addrs.size > MAX_ADDRS) addrs.removeAt(addrs.size - 1)
    }

    fun listPeers(): JSONArray {
        val now = System.currentTimeMillis()
        val out = JSONArray()
        synchronized(peers) {
            peers.values.forEach { it.online = now - it.lastSeen < PEER_TIMEOUT_MS }
            peers.values.removeAll { now - it.lastSeen >= OFFLINE_GRACE_MS }
            peers.values.forEach { out.put(it.toJson()) }
        }
        return out
    }

    fun peerIds(): List<String> = synchronized(peers) { peers.keys.toList() }
    fun peerAddr(id: String): String? = synchronized(peers) { peers[id]?.addr }
    fun peerName(id: String): String? = synchronized(peers) { peers[id]?.name }

    // ---------- TCP ----------
    fun startTcp() {
        if (!tcpStarted.compareAndSet(false, true)) return
        thread(isDaemon = true, name = "chatlan-tcp") {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(TCP_PORT))
                while (true) {
                    val s = ss.accept()
                    thread(isDaemon = true, name = "chatlan-conn") { handleConnection(s) }
                }
            } catch (e: Exception) {
                tcpStarted.set(false)
            }
        }
    }

    private fun handleConnection(sock: Socket) {
        val ip = sock.inetAddress?.hostAddress ?: ""
        val owned = HashSet<String>()
        try {
            val inp = DataInputStream(BufferedInputStream(sock.getInputStream(), 64 * 1024))
            while (true) {
                val len = try { inp.readInt() } catch (e: EOFException) { break }
                if (len < 0 || len > MAX_FRAME) break
                val payload = ByteArray(len)
                inp.readFully(payload)
                val msg = try { JSONObject(String(payload, Charsets.UTF_8)) } catch (e: Exception) { continue }
                touchPeer(ip)
                process(msg, owned)
            }
        } catch (_: Exception) {
        } finally {
            // transferencias cortadas a medias: no dejar basura
            owned.forEach { id -> receivers.remove(id)?.let { runCatching { it.raf.close(); it.file.delete() } } }
            runCatching { sock.close() }
        }
    }

    private fun touchPeer(ip: String) {
        synchronized(peers) {
            peers.values.firstOrNull { it.addr == ip || it.addrs.contains(ip) }?.let {
                it.lastSeen = System.currentTimeMillis(); it.online = true
            }
        }
    }

    private fun process(msg: JSONObject, owned: MutableSet<String>) {
        when (msg.optString("kind")) {
            "FileStart" -> {
                val id = msg.getString("id")
                val filename = msg.optString("filename", "archivo")
                val ext = filename.substringAfterLast('.', "bin").filter { it.isLetterOrDigit() }.take(10).ifEmpty { "bin" }
                val f = File(tempDir("chatlan_files"), "${UUID.randomUUID()}.$ext")
                receivers[id] = FileRx(id, filename, msg.optString("from"), msg.optString("sender_id"),
                    msg.optLong("size"), f, RandomAccessFile(f, "rw"))
                owned.add(id)
                enqueue(msg)
            }
            "FileChunk" -> {
                val rx = receivers[msg.optString("id")] ?: return
                val arr = msg.getJSONArray("data")
                val bytes = ByteArray(arr.length()) { arr.getInt(it).toByte() }
                synchronized(rx) { rx.raf.seek(msg.optLong("offset")); rx.raf.write(bytes) }
            }
            "FileEnd" -> {
                val id = msg.optString("id")
                val rx = receivers.remove(id) ?: return
                owned.remove(id)
                runCatching { rx.raf.close() }
                val done = JSONObject().put("kind", "FileReceived").put("id", rx.id)
                    .put("sender_id", rx.senderId).put("from", rx.from)
                    .put("filename", rx.filename).put("size", rx.size).put("temp_path", rx.file.absolutePath)
                enqueue(done)
                if (!appVisible) Notifier.message(rx.senderId, rx.from, "Archivo: ${rx.filename}")
            }
            "AvatarUpdate" -> {
                val id = msg.optString("id")
                val b64 = msg.optString("avatar_b64")
                avatars[id] = b64
                enqueue(msg)
            }
            "Text" -> {
                enqueue(msg)
                if (!appVisible) Notifier.message(msg.optString("id"), msg.optString("from"), msg.optString("body"))
            }
            "Call" -> {
                enqueue(msg)
                when (msg.optString("op")) {
                    "invite" -> if (!appVisible) Notifier.call(msg.optString("id"), msg.optString("from"), msg.optBoolean("video"))
                    "end", "reject" -> Notifier.cancel(msg.optString("id"))
                }
            }
            else -> enqueue(msg) // Typing, Read, DeleteMessage, Reaction, Hello...
        }
    }

    // ---------- envío ----------
    private fun connectBest(addrs: List<String>): Pair<Socket, String> {
        if (addrs.isEmpty()) throw IOException("no hay ninguna direccion conocida para este peer")
        var last: Exception? = null
        for (a in addrs) {
            val s = Socket()
            try {
                s.tcpNoDelay = true
                s.connect(InetSocketAddress(a, TCP_PORT), CONNECT_TIMEOUT_MS)
                return s to a
            } catch (e: Exception) { last = e; runCatching { s.close() } }
        }
        throw IOException(last?.message ?: "no se pudo conectar con ninguna direccion")
    }

    private fun writeFramed(out: OutputStream, json: String) {
        val b = json.toByteArray(Charsets.UTF_8)
        out.write(byteArrayOf((b.size ushr 24).toByte(), (b.size ushr 16).toByte(), (b.size ushr 8).toByte(), b.size.toByte()))
        out.write(b)
    }

    private fun addrsOf(peerId: String): List<String> = synchronized(peers) {
        peers[peerId]?.addrs?.toList() ?: throw IOException("peer desconocido (ya no esta en la lista de contactos)")
    }

    private fun remember(peerId: String, used: String) = synchronized(peers) {
        peers[peerId]?.let { promote(it.addrs, used); it.addr = used }
    }

    fun sendToPeer(peerId: String, msg: JSONObject) {
        val (s, used) = connectBest(addrsOf(peerId))
        s.use {
            val out = BufferedOutputStream(it.getOutputStream())
            writeFramed(out, msg.toString()); out.flush()
        }
        remember(peerId, used)
    }

    fun sendFile(peerId: String, path: String) {
        val f = File(path)
        if (!f.isFile) throw IOException("archivo no encontrado")
        val tid = UUID.randomUUID().toString()
        val (s, used) = connectBest(addrsOf(peerId))
        s.use {
            val out = BufferedOutputStream(it.getOutputStream(), 128 * 1024)
            writeFramed(out, JSONObject().put("kind", "FileStart").put("id", tid).put("sender_id", selfId)
                .put("from", selfName).put("filename", f.name).put("size", f.length()).toString())
            val q = JSONObject.quote(tid)
            FileInputStream(f).use { fin ->
                val buf = ByteArray(64 * 1024)
                var off = 0L
                while (true) {
                    val n = fin.read(buf); if (n <= 0) break
                    val sb = StringBuilder(n * 4 + 80)
                    sb.append("{\"kind\":\"FileChunk\",\"id\":").append(q).append(",\"offset\":").append(off).append(",\"data\":[")
                    for (i in 0 until n) { if (i > 0) sb.append(','); sb.append(buf[i].toInt() and 0xFF) }
                    sb.append("]}")
                    writeFramed(out, sb.toString())
                    off += n
                }
            }
            writeFramed(out, JSONObject().put("kind", "FileEnd").put("id", tid).toString())
            out.flush()
        }
        remember(peerId, used)
    }

    // ---------- UDP discovery ----------
    private fun localIfaces(): List<Pair<Inet4Address, InetAddress?>> {
        val out = ArrayList<Pair<Inet4Address, InetAddress?>>()
        val en = try { NetworkInterface.getNetworkInterfaces() } catch (e: Exception) { null } ?: return out
        for (ni in en) {
            if (!ni.isUp || ni.isLoopback) continue
            if (ni.name.startsWith("rmnet") || ni.name.startsWith("ccmni") || ni.name.startsWith("dummy")) continue
            for (ia in ni.interfaceAddresses) {
                val a = ia.address
                if (a is Inet4Address) out.add(a to ia.broadcast)
            }
        }
        return out
    }

    private fun helloJson(addrs: List<String>): JSONObject = JSONObject().put("kind", "Hello").put("id", selfId)
        .put("name", selfName).put("addrs", JSONArray(addrs)).put("idle_secs", 0)

    fun startDiscovery() {
        if (!udpStarted.compareAndSet(false, true)) return
        startTcp()
        thread(isDaemon = true, name = "chatlan-udp-announce") {
            while (true) {
                try {
                    val ifs = localIfaces()
                    val payload = helloJson(ifs.map { it.first.hostAddress ?: "" }).toString().toByteArray()
                    for ((ip, bc) in ifs) {
                        try {
                            DatagramSocket(0, ip).use { ds ->
                                ds.broadcast = true
                                ds.send(DatagramPacket(payload, payload.size, InetAddress.getByName("255.255.255.255"), UDP_PORT))
                                if (bc != null) ds.send(DatagramPacket(payload, payload.size, bc, UDP_PORT))
                            }
                        } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}
                Thread.sleep(3000)
            }
        }
        thread(isDaemon = true, name = "chatlan-udp-listen") {
            try {
                val ds = DatagramSocket(null)
                ds.reuseAddress = true
                ds.broadcast = true
                ds.bind(InetSocketAddress(UDP_PORT))
                val buf = ByteArray(4096)
                while (true) {
                    val p = DatagramPacket(buf, buf.size)
                    ds.receive(p)
                    val m = try { JSONObject(String(p.data, 0, p.length, Charsets.UTF_8)) } catch (e: Exception) { continue }
                    if (m.optString("kind") != "Hello") continue
                    onHello(m, p.address.hostAddress ?: continue)
                }
            } catch (e: Exception) {
                udpStarted.set(false)
            }
        }
    }

    private fun onHello(m: JSONObject, srcIp: String) {
        val id = m.optString("id")
        if (id.isEmpty() || id == selfId) return
        val name = m.optString("name")
        val theirAddrs = m.optJSONArray("addrs")?.let { a -> List(a.length()) { a.getString(it) } } ?: emptyList()
        val isNew = synchronized(peers) {
            // peer reiniciado = id nuevo con el MISMO nombre e IP de origen: se elimina el fantasma.
            // (Compartir una IP virtual -VirtualBox, Docker, VPN- ya no borra contactos distintos.)
            peers.entries.removeAll { (oldId, p) ->
                oldId != id && p.name == name && (p.addr == srcIp || p.addrs.contains(srcIp))
            }
            val fresh = !peers.containsKey(id)
            val e = peers.getOrPut(id) { Peer(id, name, srcIp, mutableListOf()) }
            e.name = name; e.online = true; e.idleSecs = m.optLong("idle_secs"); e.lastSeen = System.currentTimeMillis()
            promote(e.addrs, srcIp)
            theirAddrs.forEach { if (!e.addrs.contains(it)) e.addrs.add(it) }
            while (e.addrs.size > MAX_ADDRS) e.addrs.removeAt(e.addrs.size - 1)
            e.addr = e.addrs[0]
            fresh
        }
        if (isNew) {
            val av = avatars[selfId]
            if (!av.isNullOrEmpty()) thread(isDaemon = true) {
                runCatching { sendToPeer(id, avatarMsg(av)) }
            }
        }
    }

    fun avatarMsg(b64: String): JSONObject =
        JSONObject().put("kind", "AvatarUpdate").put("id", selfId).put("name", selfName).put("avatar_b64", b64)

    fun sendCall(peerId: String, callId: String, op: String, video: Boolean, data: String) {
        sendToPeer(peerId, JSONObject().put("kind", "Call").put("id", selfId).put("from", selfName)
            .put("call_id", callId).put("op", op).put("video", video).put("data", data))
    }

    fun reAnnounce() {
        val msg = helloJson(localIfaces().map { it.first.hostAddress ?: "" })
        peerIds().forEach { runCatching { sendToPeer(it, msg) } }
    }
}
