package com.chatlan.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object Notifier {
    const val CH_MSG = "messages"
    const val CH_SVC = "service"
    const val CH_CALL = "calls"

    fun createChannels(c: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_MSG, "Mensajes", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_CALL, "Llamadas", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_SVC, "Servicio de red", NotificationManager.IMPORTANCE_MIN))
    }

    fun message(peerId: String, from: String, body: String) {
        val c = Engine.ctx
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val i = Intent(c, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("peerId", peerId); putExtra("peerName", from)
        }
        val pi = PendingIntent.getActivity(c, peerId.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(c, CH_MSG)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(from).setContentText(body)
            .setAutoCancel(true).setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_HIGH).build()
        NotificationManagerCompat.from(c).notify(peerId.hashCode(), n)
    }

    fun call(peerId: String, name: String, video: Boolean = false) {
        val c = Engine.ctx
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val i = Intent(c, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("peerId", peerId); putExtra("peerName", name)
        }
        val pi = PendingIntent.getActivity(c, peerId.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(c, CH_CALL)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle(if (video) "Videollamada entrante" else "Llamada entrante").setContentText(name)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true).setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_MAX).build()
        NotificationManagerCompat.from(c).notify(peerId.hashCode(), n)
    }

    fun cancel(peerId: String) = NotificationManagerCompat.from(Engine.ctx).cancel(peerId.hashCode())
}
