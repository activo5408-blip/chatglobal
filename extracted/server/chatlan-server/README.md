# ChatLAN Call Server

Servidor opcional que hace que ChatLAN (Windows y Android) funcione **como si todos estuvieran en la misma LAN, aunque no lo estén**:
lista de usuarios conectados, **chat** (texto, respuestas, reacciones, escribiendo…, leído, borrar), **archivos e imágenes**, **avatares**,
**llamadas, videollamadas y llamadas grupales**.
Sin servidor, las apps siguen siendo P2P por la red local. En la misma LAN todo sigue yendo directo (el servidor solo se usa con quien no está en tu red).

- Una única **API key** compartida por todas las apps. Sin registro de usuarios.
- Un solo WebSocket (`/ws`): presencia, retransmisión de mensajes (`relay`, sin interpretarlos ni guardarlos) y señalización de llamadas.
- **Un usuario = un ID**: si el mismo ID se conecta dos veces, la sesión nueva reemplaza a la anterior; nunca aparece duplicado. Las apps además fusionan LAN + servidor por ID.
- Archivos por el servidor: hasta 10 MB cada uno (por LAN no hay límite). No se almacena nada: si el destinatario no está conectado, el envío falla igual que en la LAN.
- Señalización por WebSocket (`/ws`). El audio/vídeo va **directo entre los equipos** (malla WebRTC, recomendado hasta 6 personas) o por **coturn** si lo activas.
- Sin dependencias: solo Node.js 18+.

## Arranque rápido
```bash
export API_KEY=$(openssl rand -hex 32)     # guárdala: es la que pondrás en las apps
node server.js                             # escucha en :8443 (ws://)
```
Con Docker: `cp .env.example .env`, rellena `API_KEY` (y `TURN_*` si quieres TURN) y `docker compose up -d --build`.

## TLS (recomendado, imprescindible fuera de tu LAN)
Pon un proxy con HTTPS delante. Si el dominio ya sirve otra cosa, reenvía solo `/ws` y `/health`:
```nginx
location /ws {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 3600s;
}
location = /health { proxy_pass http://127.0.0.1:8443; }
```
Caddy: `reverse_proxy 127.0.0.1:8443` (gestiona WebSocket y certificado solo). Con `TRUST_PROXY=1` se usa la IP del proxy para limitar abusos.
En una LAN/VPN sin internet puedes usar `ws://IP:8443` sin TLS (la API key viajaría sin cifrar).

## TURN (opcional)
Para llamadas entre redes con NAT estrictos: `TURN_SECRET` + `TURN_URLS` y coturn (incluido en `docker-compose.yml`, puertos 3478 y 49160-49200 UDP/TCP abiertos). El servidor reparte credenciales efímeras a las apps.

## Configurar las apps
Ajustes → "Servidor de llamadas": URL (`https://tu-dominio`), API key, interruptor activado → **Aplicar**. Verás `Conectado ✓` o la causa del error.

## Comprobar desde tu PC
```bash
node check.js https://tu-dominio TU_API_KEY      # Node >= 22
```
Prueba HTTP, WebSocket, API key y TURN, e indica qué falla.

## Seguridad
API key comparada en tiempo constante; el remitente de cada mensaje lo fija el servidor (no se puede suplantar); limitador de ritmo por conexión y corte de clientes lentos; bloqueo temporal tras 10 intentos fallidos por IP; límites de conexiones, tamaño de mensaje (64 KB), invitaciones y participantes por sala; ids validados. Rota la API key si se filtra (cámbiala aquí y en las apps).

## Pruebas
`npm test` (Node >= 22) levanta el servidor y ejecuta 20 comprobaciones de integración.
