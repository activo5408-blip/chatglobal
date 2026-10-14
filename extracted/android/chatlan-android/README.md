# ChatLAN para Android (Kotlin)

Port de ChatLAN (Tauri/Rust) a Android. Es compatible en el cable con la versión de escritorio
(UDP 42346 para descubrimiento, TCP 42345 para mensajes y archivos, mismo JSON con campo `kind`),
así que el móvil y el PC se ven entre sí en la misma red Wi-Fi.

- Backend: Kotlin nativo (`Engine.kt` = `network.rs`, `Bridge.kt` = comandos de `main.rs`).
- UI: el mismo frontend HTML/CSS/JS dentro de un WebView (`app/src/main/assets`), con un shim
  (`android-shim.js`) que reemplaza `window.__TAURI__`.
- Servicio en primer plano para mantener sockets y multicast lock con la pantalla apagada.

## Obtener el APK (sin instalar nada)
1. Sube esta carpeta a un repositorio de GitHub (privado vale).
2. Pestaña **Actions → Build APK → Run workflow** (también corre solo al hacer push).
3. Descarga el artefacto `chatlan-debug-apk` → `app-debug.apk`, cópialo al móvil e instálalo
   (permite "instalar apps desconocidas").

## Compilar en tu PC
Android Studio (Ladybug o superior): *Open* esta carpeta → Build → Build APK(s).
Por línea de comandos, con JDK 17 y Android SDK 35: `gradle :app:assembleDebug`
→ `app/build/outputs/apk/debug/app-debug.apk`.

## Cambios respecto a escritorio
- Se quitaron la barra de título y la bandeja del sistema; el botón Atrás vuelve a contactos.
- Notificaciones: nativas de Android (no la ventana emergente). Responder desde la notificación
  no está implementado; al tocarla abre el chat.
- Archivos recibidos: se escriben a disco por trozos (no se acumulan en RAM).
- Avatar: se reduce a 256 px antes de enviarse.
- Seguridad: el frontend original inserta texto de otros peers con `innerHTML` sin escapar;
  en Android el puente escapa `< > &` en cuerpo/nombres de archivo/nombres, y los comandos de
  archivos solo operan dentro del almacenamiento privado de la app. Lo correcto a largo plazo
  es arreglar el escapado en `app.js`.

## Estado
Este código se escribió sin poder compilarlo ni probarlo en un dispositivo. Si Gradle da algún
error de compilación, pásamelo y lo corrijo.
