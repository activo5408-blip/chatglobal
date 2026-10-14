package com.chatlan.android

import android.app.Application

class ChatApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Engine.init(this)
    }
}
