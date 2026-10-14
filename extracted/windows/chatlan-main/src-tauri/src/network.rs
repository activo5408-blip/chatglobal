use crate::logging::log_line;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::Mutex;
use uuid::Uuid;

pub const TCP_PORT: u16 = 42345;
pub const UDP_PORT: u16 = 42346;
pub const PEER_TIMEOUT_SECS: u64 = 10;
/// How long we wait for a single TCP connect attempt before giving up on
/// that candidate address and trying the next one. Keep this short: on a
/// LAN a working connect finishes in a few ms, so a multi-second timeout
/// only matters for candidates that are dead (wrong interface, stale VPN
/// address, etc), and we don't want those to make sending feel frozen.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(200);
/// Cap on how many candidate addresses we remember per peer, so a machine
/// with many virtual adapters doesn't grow this unboundedly over time.
const MAX_ADDRS_PER_PEER: usize = 8;

#[cfg(target_os = "windows")]
pub fn local_idle_secs() -> u64 {
    #[repr(C)]
    struct LastInputInfo { cb_size: u32, dw_time: u32 }
    #[link(name = "user32")]
    extern "system" { fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32; }
    #[link(name = "kernel32")]
    extern "system" { fn GetTickCount() -> u32; }
    unsafe {
        let mut lii = LastInputInfo { cb_size: std::mem::size_of::<LastInputInfo>() as u32, dw_time: 0 };
        if GetLastInputInfo(&mut lii) == 0 { return 0; }
        GetTickCount().wrapping_sub(lii.dw_time) as u64 / 1000
    }
}

#[cfg(not(target_os = "windows"))]
pub fn local_idle_secs() -> u64 { 0 }

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// Best-known address right now (first entry of `addrs`), kept for
    /// display in the UI. Sending no longer trusts this alone — see
    /// `addrs` and `connect_best`.
    pub addr: String,
    /// All addresses we've seen this peer announce or connect from,
    /// most-recently-proven-working first. A multi-homed peer (VPN
    /// adapter + real LAN NIC, Wi-Fi + Ethernet, etc.) can have several
    /// valid addresses, and only some of them may actually be reachable
    /// from us depending on which of *our* interfaces shares a subnet
    /// with which of *theirs*. Trying them all beats guessing one.
    pub addrs: Vec<String>,
    pub online: bool,
    #[serde(default)]
    pub idle_secs: u64,
    #[serde(skip)]
    pub last_seen: Option<Instant>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "kind")]
pub enum WireMessage {
    Hello { id: String, name: String, addrs: Vec<String>, #[serde(default)] idle_secs: u64 },
    Text { id: String, msg_id: String, from: String, body: String, ts: String, #[serde(default)] reply_to: Option<String>, #[serde(default)] reply_body: Option<String>, #[serde(default)] reply_from: Option<String> },
    /// `id` is a unique-per-transfer id (NOT the sender's peer id) so that
    /// two files/images sent close together never collide in the
    /// receiver's `file_receivers` map. `sender_id` carries the actual
    /// sending peer's id, used by the UI to attribute the file to the
    /// right contact.
    FileStart { id: String, sender_id: String, from: String, filename: String, size: u64 },
    FileChunk { id: String, offset: u64, data: Vec<u8> },
    FileEnd { id: String },
    FileReceived { id: String, sender_id: String, from: String, filename: String, size: u64, temp_path: String },
    AvatarUpdate { id: String, name: String, avatar_b64: String },
    Typing { id: String, from: String },
    Read { id: String, from: String },
    DeleteMessage { id: String, msg_id: String },
    Reaction { id: String, msg_id: String, emoji: String, action: String },
    /// Senalizacion de llamadas de voz/video (WebRTC). `op`: invite | accept | reject | end | sdp | ice.
    /// `data` lleva un JSON serializado (SDP o candidato ICE) segun `op`.
    Call { id: String, from: String, call_id: String, op: String, #[serde(default)] video: bool, #[serde(default)] data: String },
}

pub(crate) struct FileReceiver {
    filename: String,
    from: String,
    sender_id: String,
    id: String,
    size: u64,
    chunks: HashMap<u64, Vec<u8>>,
    bytes_received: u64,
}

pub struct NetState {
    pub peers: Mutex<HashMap<String, Peer>>,
    pub self_id: String,
    pub self_name: tokio::sync::Mutex<String>,
    pub pending_messages: Mutex<VecDeque<WireMessage>>,
    pub notify_tx: tokio::sync::mpsc::UnboundedSender<WireMessage>,
    pub file_receivers: Mutex<HashMap<String, FileReceiver>>,
    pub avatars: Mutex<HashMap<String, String>>,
}

pub fn local_ipv4_addrs() -> Vec<std::net::Ipv4Addr> {
    match if_addrs::get_if_addrs() {
        Ok(ifaces) => {
            let mut v: Vec<std::net::Ipv4Addr> = ifaces
                .into_iter()
                .filter(|i| !i.is_loopback())
                .filter_map(|i| match i.ip() {
                    IpAddr::V4(v4) => Some(v4),
                    IpAddr::V6(_) => None,
                })
                .collect();
            v.dedup();
            v
        }
        Err(_) => Vec::new(),
    }
}

/// Push `addr` to the front of the candidate list (most-trusted position),
/// removing any earlier occurrence, and cap the list length.
fn promote_addr(addrs: &mut Vec<String>, addr: String) {
    addrs.retain(|a| a != &addr);
    addrs.insert(0, addr);
    addrs.truncate(MAX_ADDRS_PER_PEER);
}

const OFFLINE_GRACE_SECS: u64 = 600;

pub fn prune_offline_peers(peers: &mut HashMap<String, Peer>, now: Instant) {
    peers.retain(|_, p| match p.last_seen {
        Some(ts) => now.duration_since(ts) < Duration::from_secs(OFFLINE_GRACE_SECS),
        None => true,
    });
}

pub fn avatar_dir() -> std::path::PathBuf {
    let mut p = crate::logging::app_base_dir();
    p.push("ChatLAN");
    p.push("avatars");
    p
}

pub async fn start_tcp_listener(state: Arc<NetState>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", TCP_PORT)).await?;
    log_line(&format!("[tcp] listener bindeado en 0.0.0.0:{TCP_PORT}"));
    loop {
        let (socket, addr) = listener.accept().await?;
        log_line(&format!("[tcp] aceptada conexion desde {addr}"));
        let state = state.clone();
        tokio::spawn(async move {
            let _ = handle_connection(socket, state).await;
        });
    }
}

async fn handle_connection(
    socket: TcpStream,
    state: Arc<NetState>,
) -> std::io::Result<()> {
    let peer_addr = socket.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    log_line(&format!("[recv] conexion desde {peer_addr}"));
    let mut reader = BufReader::new(socket);
    loop {
        let mut len_buf = [0u8; 4];
        if reader.read_exact(&mut len_buf).await.is_err() {
            log_line(&format!("[recv] conexion cerrada desde {peer_addr}"));
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 10 * 1024 * 1024 {
            log_line(&format!("[recv] payload demasiado grande ({len} bytes) desde {peer_addr}"));
            break;
        }
        let mut payload = vec![0u8; len];
        reader.read_exact(&mut payload).await?;
        match serde_json::from_slice::<WireMessage>(&payload) {
            Ok(msg) => {
                log_line(&format!("[recv] msg OK desde {peer_addr}: {:?}", std::mem::discriminant(&msg)));
                // Any TCP contact means this peer is alive — refresh last_seen
                // so list_peers() won't mark it offline while it's still talking.
                {
                    let source_ip = peer_addr.split(':').next().unwrap_or(&peer_addr);
                    let mut peers = state.peers.lock().await;
                    for p in peers.values_mut() {
                        if p.addrs.iter().any(|a| a == source_ip) || p.addr == source_ip {
                            p.last_seen = Some(std::time::Instant::now());
                            p.online = true;
                            break;
                        }
                    }
                }
                match &msg {
                    WireMessage::FileStart { id, sender_id, from, filename, size } => {
                        state.file_receivers.lock().await.insert(id.clone(), FileReceiver {
                            filename: filename.clone(),
                            from: from.clone(),
                            sender_id: sender_id.clone(),
                            id: id.clone(),
                            size: *size,
                            chunks: HashMap::new(),
                            bytes_received: 0,
                        });
                        log_line(&format!("[file] FileStart de '{from}': {filename} ({size} bytes)"));
                        let _ = state.notify_tx.send(msg.clone());
                        state.pending_messages.lock().await.push_back(msg);
                    }
                    WireMessage::FileChunk { id, offset, data } => {
                        let mut receivers = state.file_receivers.lock().await;
                        if let Some(receiver) = receivers.get_mut(id) {
                            receiver.bytes_received += data.len() as u64;
                            receiver.chunks.insert(*offset, data.clone());
                        }
                    }
                    WireMessage::FileEnd { id } => {
                        let receiver = state.file_receivers.lock().await.remove(id);
                        if let Some(receiver) = receiver {
                            let mut offsets: Vec<u64> = receiver.chunks.keys().cloned().collect();
                            offsets.sort();
                            let total: usize = offsets.iter().map(|o| receiver.chunks[o].len()).sum();
                            let mut all_bytes = Vec::with_capacity(total);
                            for offset in &offsets {
                                all_bytes.extend_from_slice(&receiver.chunks[offset]);
                            }
                            let temp_dir = std::env::temp_dir().join("chatlan_files");
                            let _ = std::fs::create_dir_all(&temp_dir);
                            let ext = receiver.filename.split('.').last().unwrap_or("bin");
                            let temp_path = temp_dir.join(format!("{}.{}", Uuid::new_v4(), ext));
                            if let Err(e) = std::fs::write(&temp_path, &all_bytes) {
                                log_line(&format!("[file] ERROR escribiendo: {e}"));
                            } else {
                                log_line(&format!("[file] FileEnd de {}: {} bytes -> {}", receiver.id, all_bytes.len(), temp_path.display()));
                            }
                            let file_received = WireMessage::FileReceived {
                                id: receiver.id,
                                sender_id: receiver.sender_id,
                                from: receiver.from,
                                filename: receiver.filename,
                                size: receiver.size,
                                temp_path: temp_path.to_string_lossy().to_string(),
                            };
                            let _ = state.notify_tx.send(file_received.clone());
                            state.pending_messages.lock().await.push_back(file_received);
                        }
                    }
                    WireMessage::AvatarUpdate { id, avatar_b64, .. } => {
                        let mut avatars = state.avatars.lock().await;
                        avatars.insert(id.clone(), avatar_b64.clone());
                        drop(avatars);
                        let avatar_dir = avatar_dir();
                        let _ = std::fs::create_dir_all(&avatar_dir);
                        if let Ok(data) = base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            avatar_b64.trim_start_matches("data:image/png;base64,"),
                        ) {
                            let _ = std::fs::write(avatar_dir.join(format!("{id}.png")), &data);
                        }
                        let _ = state.notify_tx.send(msg.clone());
                        state.pending_messages.lock().await.push_back(msg);
                    }
                    WireMessage::Typing { .. } | WireMessage::Read { .. } | WireMessage::DeleteMessage { .. } | WireMessage::Reaction { .. } | WireMessage::Call { .. } => {
                        state.pending_messages.lock().await.push_back(msg);
                    }
                    _ => {
                        let _ = state.notify_tx.send(msg.clone());
                        state.pending_messages.lock().await.push_back(msg);
                    }
                }
            }
            Err(e) => {
                let preview = String::from_utf8_lossy(&payload[..payload.len().min(200)]);
                log_line(&format!("[recv] DESER FAILED desde {peer_addr}: {e} | preview: {preview}"));
            }
        }
    }
    Ok(())
}

/// Try every candidate address in order, each with a short timeout, and
/// return a connected stream from the first one that works, along with
/// which address it was (so the caller can remember it for next time).
async fn connect_best(addrs: &[String]) -> std::io::Result<(TcpStream, String)> {
    if addrs.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no hay ninguna direccion conocida para este peer",
        ));
    }
    let mut last_err: Option<std::io::Error> = None;
    for candidate in addrs {
        let addr: SocketAddr = match format!("{candidate}:{TCP_PORT}").parse() {
            Ok(a) => a,
            Err(_) => continue,
        };
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => return Ok((stream, candidate.clone())),
            Ok(Err(e)) => last_err = Some(e),
            Err(_) => {
                last_err = Some(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("timeout conectando a {candidate}"),
                ))
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "no se pudo conectar con ninguna direccion")
    }))
}

/// Send one message to a peer, trying all known candidate addresses.
/// Returns the address that actually worked, so the caller can promote it
/// to the front of that peer's address list for faster future sends.
async fn send_message(addrs: &[String], msg: &WireMessage) -> std::io::Result<String> {
    let (mut stream, used_addr) = connect_best(addrs).await?;
    let payload = serde_json::to_vec(msg).unwrap();
    let len = (payload.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&payload).await?;
    stream.flush().await?;
    log_line(&format!("[send] OK {} bytes a {used_addr}", payload.len()));
    Ok(used_addr)
}

pub async fn send_text_to_peer(
    state: &Arc<NetState>,
    peer_id: &str,
    msg: &WireMessage,
) -> std::io::Result<()> {
    let addrs = {
        let peers = state.peers.lock().await;
        match peers.get(peer_id) {
            Some(p) => p.addrs.clone(),
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "peer desconocido (ya no esta en la lista de contactos)",
                ))
            }
        }
    };
    let used = send_message(&addrs, msg).await?;
    let mut peers = state.peers.lock().await;
    if let Some(p) = peers.get_mut(peer_id) {
        promote_addr(&mut p.addrs, used.clone());
        p.addr = used;
    }
    Ok(())
}

/// Write one length-prefixed WireMessage onto an already-open stream.
/// Used by `send_file_to_peer` so an entire transfer travels over a single
/// TCP connection, in order, instead of one connection per chunk.
async fn write_framed(stream: &mut TcpStream, msg: &WireMessage) -> std::io::Result<()> {
    let payload = serde_json::to_vec(msg).unwrap();
    let len = (payload.len() as u32).to_be_bytes();
    stream.write_all(&len).await?;
    stream.write_all(&payload).await?;
    Ok(())
}

pub async fn send_file_to_peer(
    state: &Arc<NetState>,
    peer_id: &str,
    transfer_id: &str,
    sender_id: &str,
    from: &str,
    path: &std::path::Path,
) -> std::io::Result<()> {
    let meta = tokio::fs::metadata(path).await?;
    let filename = path.file_name().unwrap().to_string_lossy().to_string();

    let addrs = {
        let peers = state.peers.lock().await;
        match peers.get(peer_id) {
            Some(p) => p.addrs.clone(),
            None => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "peer desconocido (ya no esta en la lista de contactos)",
                ))
            }
        }
    };

    // IMPORTANT: open ONE connection and keep it for FileStart + every
    // FileChunk + FileEnd. Previously each of these was sent as its own
    // TCP connection; the receiver accepts each connection on its own
    // spawned task, so there was no guarantee chunks (or FileEnd) would be
    // *processed* in the order they were sent, which corrupted files and
    // pasted images. A single connection preserves TCP's in-order
    // delivery for the whole transfer.
    let (mut stream, used_addr) = connect_best(&addrs).await?;

    write_framed(
        &mut stream,
        &WireMessage::FileStart {
            id: transfer_id.to_string(),
            sender_id: sender_id.to_string(),
            from: from.to_string(),
            filename,
            size: meta.len(),
        },
    )
    .await?;

    let mut file = tokio::fs::File::open(path).await?;
    let mut offset: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        write_framed(
            &mut stream,
            &WireMessage::FileChunk {
                id: transfer_id.to_string(),
                offset,
                data: buf[..n].to_vec(),
            },
        )
        .await?;
        offset += n as u64;
    }

    write_framed(&mut stream, &WireMessage::FileEnd { id: transfer_id.to_string() }).await?;
    stream.flush().await?;
    log_line(&format!("[send] archivo completo ({} bytes) a {used_addr}", meta.len()));

    let mut peers = state.peers.lock().await;
    if let Some(p) = peers.get_mut(peer_id) {
        promote_addr(&mut p.addrs, used_addr.clone());
        p.addr = used_addr;
    }
    Ok(())
}

pub async fn start_udp_discovery(self_id: String, _self_name: String, state: Arc<NetState>) -> std::io::Result<()> {
    let listen_sock = UdpSocket::bind(("0.0.0.0", UDP_PORT)).await?;
    listen_sock.set_broadcast(true).ok();
    log_line(&format!("[udp] discovery bindeado en 0.0.0.0:{UDP_PORT}, self_id={self_id}"));

    // Broadcast periodically instead of re-broadcasting on every received Hello.
    // Re-broadcasting on receive creates a feedback loop (broadcast storm) that
    // floods the network and starves the CPU (DPC latency), causing system-wide
    // audio stutter and freezing. A fixed-interval announce avoids that.
    //
    // Send the announcement from EVERY local IPv4 interface (not just the OS's
    // default-route pick), and embed the full list of our own local addresses
    // in the Hello payload. Between "broadcast from every interface" and
    // "tell the receiver all our addresses", the receiver ends up with every
    // viable candidate address for us, regardless of which single interface
    // actually carried this particular packet.
    let announce_id = self_id.clone();
    let state_clone = state.clone();
    tokio::spawn(async move {
        loop {
            let current_name = state_clone.self_name.lock().await.clone();
            let ifaces = local_ipv4_addrs();
            let addrs_str: Vec<String> = ifaces.iter().map(|ip| ip.to_string()).collect();
            let announce = WireMessage::Hello {
                id: announce_id.clone(),
                name: current_name.clone(),
                addrs: addrs_str.clone(),
                idle_secs: local_idle_secs(),
            };
            log_line(&format!("[udp] broadcast Hello name='{current_name}' addrs={addrs_str:?}"));
            let payload = serde_json::to_vec(&announce).unwrap();

            if ifaces.is_empty() {
                // Fallback: let the OS pick, better than sending nothing.
                if let Ok(sock) = UdpSocket::bind(("0.0.0.0", 0)).await {
                    sock.set_broadcast(true).ok();
                    let _ = sock.send_to(&payload, ("255.255.255.255", UDP_PORT)).await;
                }
            } else {
                for ip in &ifaces {
                    if let Ok(sock) = UdpSocket::bind((IpAddr::V4(*ip), 0)).await {
                        sock.set_broadcast(true).ok();
                        let _ = sock.send_to(&payload, ("255.255.255.255", UDP_PORT)).await;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });

    let mut buf = [0u8; 4096];
    loop {
        if let Ok((n, addr)) = listen_sock.recv_from(&mut buf).await {
            if let Ok(WireMessage::Hello { id, name, addrs, idle_secs }) = serde_json::from_slice(&buf[..n]) {
                if id != self_id {
                    let source_ip = addr.ip().to_string();
                    log_line(&format!("[udp] Hello de '{name}' id={id} desde {source_ip}, addrs={:?}, idle={idle_secs}s", addrs));
                    let mut peers = state.peers.lock().await;
                    // Fix ghost duplication: if a peer restarts quickly it gets a new id
                    // but same IP/addrs. Remove old ghost entry that shares an addr.
                    // This prevents "duplicado" and the case where activePeer stays
                    // bound to the old id that will never receive messages again.
                    let dup_ids: Vec<String> = peers
                        .iter()
                        .filter_map(|(old_id, p)| {
                            if old_id == &id {
                                return None;
                            }
                            // Fantasma = MISMO nombre y la misma IP de origen. Antes bastaba con compartir
                            // cualquier direccion (p.ej. 192.168.56.1 de VirtualBox, 172.17.0.1 de Docker o una VPN),
                            // lo que borraba contactos legitimos y provocaba parpadeos/duplicados.
                            let addr_match = p.name == name
                                && (p.addr == source_ip || p.addrs.iter().any(|a| *a == source_ip));
                            if addr_match {
                                Some(old_id.clone())
                            } else {
                                None
                            }
                        })
                        .collect();
                    for dup in dup_ids {
                        if let Some(removed) = peers.remove(&dup) {
                            log_line(&format!(
                                "[udp] dedup: ghost '{}' id={} eliminado, reemplazado por id={} IP={}",
                                removed.name, removed.id, id, source_ip
                            ));
                        }
                    }
                    let is_new_peer = !peers.contains_key(&id);
                    let entry = peers.entry(id.clone()).or_insert(Peer {
                        id: id.clone(),
                        name: name.clone(),
                        addr: source_ip.clone(),
                        addrs: Vec::new(),
                        online: true,
                        idle_secs: 0,
                        last_seen: Some(Instant::now()),
                    });
                    entry.name = name.clone();
                    entry.online = true;
                    entry.idle_secs = idle_secs;
                    entry.last_seen = Some(Instant::now());
                    // The address this very packet arrived from is live,
                    // proven-reachable right now, so it goes first. The
                    // rest of the sender's self-reported addresses go in
                    // afterwards as fallback candidates for send_message
                    // to try if the primary one stops working (e.g. Wi-Fi
                    // drops, DHCP renews, VPN reconnects).
                    promote_addr(&mut entry.addrs, source_ip.clone());
                    for a in addrs {
                        if !entry.addrs.contains(&a) {
                            entry.addrs.push(a);
                        }
                    }
                    entry.addrs.truncate(MAX_ADDRS_PER_PEER);
                    entry.addr = entry.addrs[0].clone();
                    drop(peers);

                    // Previously an avatar was only pushed to peers that were
                    // *already known* at the moment the user changed it, so
                    // anyone who connected later (or was offline at the time)
                    // was stuck seeing initials forever. Fix: as soon as we
                    // discover a peer for the first time, proactively send
                    // them our current avatar, if we have one set.
                    if is_new_peer {
                        let state2 = state.clone();
                        let self_id2 = self_id.clone();
                        let peer_id2 = id.clone();
                        tokio::spawn(async move {
                            let avatar_b64 = state2.avatars.lock().await.get(&self_id2).cloned();
                            if let Some(avatar_b64) = avatar_b64 {
                                if !avatar_b64.is_empty() {
                                    let name = state2.self_name.lock().await.clone();
                                    let msg = WireMessage::AvatarUpdate {
                                        id: self_id2.clone(),
                                        name,
                                        avatar_b64,
                                    };
                                    if let Err(e) = send_text_to_peer(&state2, &peer_id2, &msg).await {
                                        log_line(&format!("[avatar] no se pudo enviar avatar a nuevo peer {peer_id2}: {e}"));
                                    } else {
                                        log_line(&format!("[avatar] avatar propio enviado a nuevo peer {peer_id2}"));
                                    }
                                }
                            }
                        });
                    }
                }
            }
        }
    }
}
