# ChatLAN

Chat P2P y transferencia de archivos para red local. Backend en Rust (Tokio),
UI 100% custom-drawn (HTML/CSS empaquetado dentro del binario vía Tauri), sin
depender de los controles nativos de Windows — por eso se ve idéntico en
Windows 10 y Windows 11.

## Estructura

```
chatlan/
  src-tauri/        Backend Rust: red P2P, ventana, bandeja del sistema
    src/main.rs      Comandos Tauri, tray icon, menú contextual
    src/network.rs   Descubrimiento UDP multi-interfaz + transporte TCP/streaming
    Cargo.toml
    tauri.conf.json
  frontend/          UI (una sola SPA con 4 vistas: login, contactos, chat, respuesta rápida)
    index.html
    style.css
    app.js
```

## Requisitos previos

- Rust estable (`rustup update stable`)
- Node.js LTS + npm
- Tauri CLI: `cargo install tauri-cli --version "^2"`
- En Windows: "Desktop development with C++" (Visual Studio Build Tools) y WebView2
  Runtime (viene preinstalado en Win11; en Win10 el instalador de Tauri lo añade
  automáticamente si falta).

## Compilar el ejecutable único

```bash
cd chatlan
npm install         # si se añaden dependencias JS de build (opcional, no hay ninguna hoy)
cargo tauri build
```

El `.exe` final queda en:

```
src-tauri/target/release/chatlan.exe
```

y el instalador NSIS en `src-tauri/target/release/bundle/nsis/`.

## Reducir el tamaño (< 25 MB)

El `Cargo.toml` ya está configurado con:
- `opt-level = "z"` (optimiza por tamaño)
- `lto = true` + `codegen-units = 1`
- `panic = "abort"`
- `strip = true` (elimina símbolos de depuración)

Con WebView2 usando el runtime del sistema (no bundleado), el `.exe` de Tauri
suele quedar entre 4–10 MB. Si necesitas margen extra:

```bash
upx --best --lzma target/release/chatlan.exe
```

## Notas de implementación

- **Descubrimiento multired**: `network::local_bind_addrs()` enumera todas las
  interfaces IPv4 no-loopback (Wi-Fi, Ethernet, adaptadores virtuales) y hace
  broadcast UDP en el puerto 41235 desde cada una; el listener TCP hace bind
  en `0.0.0.0:41234`, así que acepta conexiones entrantes por cualquier interfaz.
- **Transferencia de archivos**: streaming por chunks de 256 KB sobre el mismo
  socket TCP (`FileStart` → N × `FileChunk` → `FileEnd`), sin límite de tamaño
  porque nunca se carga el archivo completo en memoria.
- **Portapapeles**: `chatInput` escucha el evento `paste` del navegador; si el
  contenido es una imagen, genera un thumbnail inline en la burbuja.
- **Notas de audio**: `MediaRecorder` nativo del WebView; se reproduce con un
  `<audio>` estándar dentro de la burbuja. El waveform en vivo (mientras se
  graba) se puede añadir con `AnalyserNode` + `<canvas>`; dejé el gancho listo
  en `micBtn` para conectarlo si lo necesitas.
- **Bandeja del sistema**: el menú contextual (`main.rs`) reproduce exactamente
  las 7 entradas solicitadas; los ítems que no son "Mostrar ventana"/"Salir"
  emiten un evento `tray-action` que el frontend interpreta.

## Lo que falta para producción

Este es un esqueleto funcional y compilable, no un producto terminado:
- Persistencia de historial de chats (hoy vive solo en memoria del frontend).
- Cifrado del canal (hoy el protocolo va en TCP plano; recomendable envolver
  con TLS autofirmado entre peers si va a salir de una LAN de confianza).
- Manejo de reconexión / peers que caen a mitad de una transferencia de archivo.
- Iconos reales (`icons/icon.ico`, `icons/tray.png`) — hoy son placeholders que
  debes reemplazar antes de compilar el bundle NSIS.
