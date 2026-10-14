package com.chatlan.android

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** Mantiene vivos los sockets y el multicast lock con la app en segundo plano. */
class ChatService : Service() {
    private var multicast: WifiManager.MulticastLock? = null
    private var wifi: WifiManager.WifiLock? = null
    private var notif: Notification? = null

    override fun onCreate() {
        super.onCreate()
        Engine.init(this)
        Notifier.createChannels(this)
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, Notifier.CH_SVC)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("ChatLAN activo").setContentText("Escuchando en el puerto ${Engine.TCP_PORT}")
            .setOngoing(true).setContentIntent(pi).build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        notif = n
        ServiceCompat.startForeground(this, 1, n, type)
        val wm = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        multicast = wm.createMulticastLock("chatlan-multicast").apply { setReferenceCounted(false); acquire() }
        wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "chatlan-wifi").apply { setReferenceCounted(false); acquire() }
        Engine.startTcp()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = notif
        if (n != null && Build.VERSION.SDK_INT >= 30) {
            when (intent?.action) {
                "mic_on" -> runCatching {
                    val t = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        (if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
                    ServiceCompat.startForeground(this, 1, n, t)
                }
                "mic_off" -> runCatching {
                    val t = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
                    ServiceCompat.startForeground(this, 1, n, t)
                }
            }
        }
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        runCatching { multicast?.release(); wifi?.release() }
        super.onDestroy()
    }
}
