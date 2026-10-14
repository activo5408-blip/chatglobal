const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const ICO_MIC = `<svg class="ico input-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
const ICO_PAUSE = `<svg class="ico input-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg>`;
const ICO_FILE = `<svg class="ico file-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;

let typingTimeout = null;
const peerTypingTimers = {};
let isDragging = false;
let replyingTo = null;
let selfId = "";
let reactionTargetMsg = null;

const win = getCurrentWindow();
document.getElementById("minBtn").onclick = (e) => { e.stopPropagation(); win.minimize(); };
document.getElementById("closeBtn").onclick = async (e) => {
  e.stopPropagation();
  try {
    const pos = await win.outerPosition();
    const size = await win.outerSize();
    await invoke("save_window_state", { x: pos.x, y: pos.y, w: size.width, h: size.height });
  } catch (e) {}
  win.hide();
};

const titleArea = document.querySelector(".titlebar-title-area");
if (titleArea) {
  titleArea.addEventListener("mousedown", async (e) => {
    if (e.target.closest(".titlebar-controls")) return;
    try { await win.startDragging(); } catch (err) {}
  });
}

const views = {
  login: document.getElementById("view-login"),
  contacts: document.getElementById("view-contacts"),
  chat: document.getElementById("view-chat"),
  quickreply: document.getElementById("view-quickreply"),
  settings: document.getElementById("view-settings"),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.remove("active"));
  views[name].classList.add("active");
}

let peers = [];
let activePeer = null;
let chatHistory = {};
const unreadCounts = {};
const peerAvatars = {};
const peerNameCache = {};

let saveHistoryTimer = null;
function scheduleSaveHistory() {
  if (saveHistoryTimer) return;
  saveHistoryTimer = setTimeout(async () => {
    saveHistoryTimer = null;
    try {
      // Avoid saving transient receiving placeholders
      const clean = {};
      for (const [pid, arr] of Object.entries(chatHistory)) {
        clean[pid] = arr.filter(m => m.type !== "image-receiving" && m.type !== "file-receiving");
        // For image messages, url may be huge blob URL; keep as is if dataUrl, drop blob: URLs
        // We persist dataUrl (data:...) but not object URLs that won't survive restart
        for (const mm of clean[pid]) {
          if (mm.type === "audio" && mm.url && mm.url.startsWith("blob:")) {
            // blob URLs die on reload; keep tempPath if any, otherwise mark
            mm.url = "";
          }
        }
      }
      await invoke("save_history", { data: JSON.stringify(clean) });
    } catch (e) { console.error("[history] save failed", e); }
  }, 400);
}
async function persistHistoryNow() { scheduleSaveHistory(); }
async function loadPersistedHistory() {
  try {
    const raw = await invoke("load_history");
    if (raw && raw.trim().length > 2) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        chatHistory = parsed;
        console.log("[history] loaded", Object.keys(chatHistory).length, "peers");
      }
    }
  } catch (e) { console.error("[history] load failed", e); }
}
function maybeMergeOrphanHistory(newId, newName) {
  // If a peer restarted (new id, same name) we may have history under the old ghost id.
  // Merge it so chat doesn't look empty and we don't keep talking to the ghost.
  if (chatHistory[newId] && chatHistory[newId].length > 0) return;
  for (const oldId of Object.keys(chatHistory)) {
    if (oldId === newId) continue;
    if (peers.find(p => p.id === oldId)) continue; // still a live peer, don't steal
    const cached = peerNameCache[oldId];
    if (cached && cached === newName) {
      console.log(`[ghost] merging orphan history ${oldId} (${cached}) -> ${newId}`);
      chatHistory[newId] = chatHistory[oldId];
      delete chatHistory[oldId];
      if (unreadCounts[oldId]) {
        unreadCounts[newId] = (unreadCounts[newId] || 0) + unreadCounts[oldId];
        delete unreadCounts[oldId];
      }
      scheduleSaveHistory();
      if (activePeer && activePeer.id === oldId) {
        const cand = peers.find(p => p.id === newId);
        if (cand) { activePeer = cand; renderMessages(true); }
      }
      break;
    }
  }
}

function findOrCreatePeer(id, name) {
  // opportunistic orphan merge on any contact from that peer
  maybeMergeOrphanHistory(id, name);
  return peers.find(p => p.id === id) || { id, name, addr: "", online: true };
}

function sendTyping() {
  if (!activePeer) return;
  if (typingTimeout) return;
  typingTimeout = setTimeout(() => { typingTimeout = null; }, 500);
  invoke("send_typing", { peerId: activePeer.id }).catch(() => {});
}

function sendReadReceipt() {
  if (!activePeer) return;
  invoke("send_read_receipt", { peerId: activePeer.id }).catch(() => {});
}

async function setAlwaysOnTop(enabled) {
  try { await invoke("set_always_on_top", { enabled }); } catch (e) {}
}

async function init() {
  await loadPersistedHistory();
  const savedNick = await invoke("load_nick");
  if (savedNick) {
    document.getElementById("loginName").value = savedNick;
    await invoke("set_self_name", { name: savedNick });
  } else {
    const name = await invoke("get_self_name");
    document.getElementById("loginName").value = name;
  }

  try {
    const ws = await invoke("load_window_state");
    if (ws.x !== null && ws.y !== null) {
      await win.setPosition({ type: "Physical", x: Math.round(ws.x), y: Math.round(ws.y) });
    }
    if (ws.w !== null && ws.h !== null) {
      await win.setSize({ type: "Physical", width: Math.round(ws.w), height: Math.round(ws.h) });
    }
  } catch (e) {}

  let saveTimeout = null;
  function scheduleSave() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(async () => {
      saveTimeout = null;
      try {
        const pos = await win.outerPosition();
        const size = await win.outerSize();
        await invoke("save_window_state", { x: pos.x, y: pos.y, w: size.width, h: size.height });
      } catch (e) {}
    }, 500);
  }

  await win.listen("move", scheduleSave);
  await win.listen("resized", scheduleSave);
  document.getElementById("statusAddr").textContent = `Escuchando en puerto 42345`;

  if (window.Notification && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  await loadSettings();

  listen("tray-action", (event) => {
    if (event.payload === "contacts") { showView("contacts"); win.show(); }
    if (event.payload === "quick_reply") { showView("quickreply"); win.show(); }
  });

  try {
    selfId = await invoke("get_self_id");
  } catch (e) {
    console.error("[ChatLAN] get_self_id error:", e);
  }

  await initDragDrop();
  initEmojiPicker();
  initReactionPickers();
  initContextMenu();

  setInterval(async () => {
    try {
      const msgs = await invoke("poll_messages");
      for (const msg of msgs) {
        handleIncoming(msg);
      }
    } catch (e) {
      console.error("[ChatLAN] poll error:", e);
    }
  }, 100);
}

async function applyNick() {
  const nick = document.getElementById("loginName").value.trim();
  if (nick) {
    try {
      await invoke("set_self_name", { name: nick });
      await invoke("save_nick", { name: nick });
    } catch (e) { console.error(e); }
  }
}

document.getElementById("connectBtn").onclick = async () => {
  await applyNick();
  await invoke("start_discovery");
  showView("contacts");
  refreshPeers();
  setInterval(refreshPeers, 3000);
};
document.getElementById("guestBtn").onclick = async () => {
  await applyNick();
  await invoke("start_discovery");
  showView("contacts");
  refreshPeers();
  setInterval(refreshPeers, 3000);
};

document.getElementById("loginName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("connectBtn").click();
});

function peerStatusText(p) {
  if (!p.online) return "Desconectado";
  return (p.idle_secs || 0) >= 600 ? "Ausente" : "En línea";
}
function peerStatusClass(p) {
  if (!p.online) return "off";
  return (p.idle_secs || 0) >= 600 ? "away" : "";
}
function peerStatusColor(p) {
  if (!p.online) return "var(--text-dim)";
  return (p.idle_secs || 0) >= 600 ? "var(--away)" : "var(--online)";
}

async function refreshPeers() {
  peers = await invoke("list_peers");
  // keep name cache for ghost history merging (peer restarted with new id but same name)
  peers.forEach(p => { peerNameCache[p.id] = p.name; });
  const selfName = document.getElementById("loginName").value.trim();
  document.getElementById("userHeaderName").textContent = selfName;
  updateAvatarDisplay();
  document.getElementById("contactsCount").textContent = `En Línea (${peers.length})`;
  const list = document.getElementById("contactsList");
  list.innerHTML = "";
  peers.forEach(p => {
    const li = document.createElement("li");
    li.className = "contact-item";
    const count = unreadCounts[p.id] || 0;
    const badge = count > 0 ? `<span class="unread-badge">${count}</span>` : "";
    const avatarContent = peerAvatars[p.id]
      ? `<img src="${peerAvatars[p.id]}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
      : p.name.slice(0, 2).toUpperCase();
    li.innerHTML = `
      <div class="avatar">${avatarContent}</div>
      <div>
        <div class="contact-name">${p.name}${badge}</div>
        <div class="contact-status"><span class="dot ${peerStatusClass(p)}"></span>${peerStatusText(p)}</div>
      </div>`;
    li.onclick = () => openChat(p);
    list.appendChild(li);
  });
  if (activePeer) {
    let fresh = peers.find(p => p.id === activePeer.id);
    if (!fresh) {
      // Ghost detection: peer closed and reopened quickly, old id lingers as ghost
      // Try to auto-migrate to the new id with same name (or same addr if renamed)
      const candidate = peers.find(p => p.name === activePeer.name)
        || peers.find(p => p.addr === activePeer.addr && activePeer.addr);
      if (candidate) {
        console.log(`[ghost] migrando activePeer ${activePeer.id} -> ${candidate.id} (${candidate.name})`);
        // Merge history: move messages from ghost id to new id
        if (chatHistory[activePeer.id]) {
          const ghostHist = chatHistory[activePeer.id];
          if (!chatHistory[candidate.id]) chatHistory[candidate.id] = [];
          // Deduplicate by wireId to avoid double messages
          const existingIds = new Set(chatHistory[candidate.id].map(m => m.wireId).filter(Boolean));
          for (const m of ghostHist) {
            if (m.wireId && existingIds.has(m.wireId)) continue;
            chatHistory[candidate.id].push(m);
          }
          delete chatHistory[activePeer.id];
          if (unreadCounts[activePeer.id]) {
            unreadCounts[candidate.id] = (unreadCounts[candidate.id] || 0) + unreadCounts[activePeer.id];
            delete unreadCounts[activePeer.id];
          }
          scheduleSaveHistory();
        }
        activePeer = candidate;
        fresh = candidate;
        renderedCount = 0;
        document.getElementById("chatPeerName").textContent = `Chat con ${candidate.name}`;
        updateChatPeerAvatar(candidate);
        renderMessages(true);
      }
    } else {
      activePeer = fresh;
      updateChatPeerAvatar(activePeer);
    }
    const dot = document.getElementById("onlineDot");
    if (dot) {
      dot.textContent = fresh ? peerStatusText(fresh) : "Desconectado";
      dot.style.color = fresh ? peerStatusColor(fresh) : "var(--text-dim)";
    }
  }
}

function refreshContactsBadges() {
  const items = document.querySelectorAll("#contactsList .contact-item");
  peers.forEach((p, i) => {
    if (items[i]) {
      const count = unreadCounts[p.id] || 0;
      const nameEl = items[i].querySelector(".contact-name");
      if (nameEl) {
        const badge = count > 0 ? `<span class="unread-badge">${count}</span>` : "";
        nameEl.innerHTML = `${p.name}${badge}`;
      }
    }
  });
}

function openChat(peer) {
  activePeer = peer;
  renderedCount = 0;
  unreadCounts[peer.id] = 0;
  document.getElementById("chatPeerName").textContent = `Chat con ${peer.name}`;
  updateChatPeerAvatar(peer);
  const dot = document.getElementById("onlineDot");
  if (dot) {
    dot.textContent = peerStatusText(peer);
    dot.style.color = peerStatusColor(peer);
  }
  renderMessages();
  refreshContactsBadges();
  showView("chat");
  setAlwaysOnTop(true);
  setTimeout(sendReadReceipt, 300);
}

function updateChatPeerAvatar(peer) {
  const el = document.getElementById("chatPeerAvatar");
  if (!el) return;
  if (peerAvatars[peer.id]) {
    el.innerHTML = `<img src="${peerAvatars[peer.id]}" />`;
  } else {
    el.textContent = peer.name.slice(0, 2).toUpperCase();
  }
}
document.getElementById("backBtn").onclick = () => {
  showView("contacts");
  refreshContactsBadges();
  setAlwaysOnTop(false);
  replyingTo = null;
  showReplyPreview();
  const ti = document.getElementById("typingIndicator");
  if (ti) { ti.classList.remove("active"); ti.innerHTML = ""; }
};
document.getElementById("settingsBtn").onclick = () => {
  document.getElementById("settingsNick").value = document.getElementById("loginName").value;
  populateAudioDevices();
  updateAvatarDisplay();
  showView("settings");
};

let renderedCount = 0;

function renderMessages(force) {
  const box = document.getElementById("messages");
  const msgs = chatHistory[activePeer?.id] || [];
  const total = msgs.length;
  if (force || renderedCount > total) { box.innerHTML = ""; renderedCount = 0; }
  if (total === 0) { box.innerHTML = ""; renderedCount = 0; return; }
  for (let i = renderedCount; i < total; i++) {
    try {
      const el = renderBubble(msgs[i], i);
      if (el) {
        if (!force) el.classList.add("bubble-new");
        box.appendChild(el);
      }
    } catch (e) {
      console.error("[ChatLAN] renderBubble error:", e, msgs[i]);
    }
  }
  renderedCount = total;
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const box = document.getElementById("messages");
  box.scrollTop = box.scrollHeight;
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
function wrapEmojis(text) {
  return text.replace(EMOJI_RE, (m) => `<span class="emoji-char">${m}</span>`);
}

function renderBubbleReactions(m) {
  if (!m || !m.reactions) return null;
  const emojis = Object.keys(m.reactions);
  if (emojis.length === 0) return null;

  const container = document.createElement("div");
  container.className = "bubble-reactions";

  for (const emoji of emojis) {
    const users = m.reactions[emoji];
    if (!users || users.length === 0) continue;
    const count = users.length;
    const isMine = selfId && users.includes(selfId);

    const pill = document.createElement("button");
    pill.className = `reaction-pill${isMine ? " mine" : ""}`;
    pill.dataset.emoji = emoji;

    let names = [];
    if (isMine) names.push("Tú");
    if (activePeer && users.includes(activePeer.id)) names.push(activePeer.name);
    pill.title = names.length > 0 ? `${names.join(", ")} reaccionó con ${emoji}` : `${count} reacción`;

    pill.innerHTML = `<span class="rx-emoji">${emoji}</span>${count > 1 ? `<span class="rx-count">${count}</span>` : ""}`;
    pill.onclick = (e) => {
      e.stopPropagation();
      if (!activePeer) return;
      toggleReaction(activePeer.id, m, emoji);
    };
    container.appendChild(pill);
  }

  if (container.children.length === 0) return null;
  return container;
}

function attachBubbleActions(div, m) {
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "bubble-actions";

  const reactBtn = document.createElement("button");
  reactBtn.className = "bubble-action-btn bubble-react-btn";
  reactBtn.title = "Reaccionar con emoji";
  reactBtn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>`;
  reactBtn.onclick = (e) => {
    e.stopPropagation();
    openFloatingReactions(m, reactBtn);
  };
  actionsDiv.appendChild(reactBtn);

  if (!m.mine && m.type === "text" && m.body) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "bubble-action-btn bubble-copy-btn";
    copyBtn.title = "Copiar texto";
    copyBtn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(m.body).catch(() => {});
      copyBtn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      setTimeout(() => {
        copyBtn.innerHTML = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
      }, 1500);
    };
    actionsDiv.appendChild(copyBtn);
  }

  div.appendChild(actionsDiv);
}

function renderBubble(m, msgIdx) {
  const check = m.mine ? (m.read ? " ✓✓" : " ✓") : "";
  if (m.type === "image") {
    const div = document.createElement("div");
    div.className = `bubble ${m.mine ? "mine" : "theirs"}`;
    div.dataset.msgIdx = msgIdx;
    div.dataset.wireId = m.wireId || m.id || "";
    div.style.cursor = "pointer";
    const img = document.createElement("img");
    img.src = m.url;
    img.style.cssText = "max-width:200px;border-radius:8px;display:block;";
    img.onerror = () => { img.style.display = "none"; div.textContent = `[imagen: ${m.filename || "error"}]`; };
    img.onclick = () => { if (m.filePath) invoke("open_image", { path: m.filePath }).catch(() => {}); };
    div.appendChild(img);
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = `${m.ts}${check}`;
    div.appendChild(ts);
    const rx = renderBubbleReactions(m);
    if (rx) div.appendChild(rx);
    attachBubbleActions(div, m);
    return div;
  }
  if (m.type === "image-receiving") {
    const div = document.createElement("div");
    div.className = "bubble theirs";
    div.dataset.msgIdx = msgIdx;
    div.dataset.wireId = m.wireId || m.id || "";
    div.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:12px;">Recibiendo imagen: ${m.filename}...</div>`;
    return div;
  }
  if (m.type === "file-receiving") {
    const div = document.createElement("div");
    div.className = "file-bubble";
    div.dataset.msgIdx = msgIdx;
    div.dataset.wireId = m.wireId || m.id || "";
    div.innerHTML = `${ICO_FILE}
      <div><div class="file-name">${m.filename}</div>
      <div class="file-size">Recibiendo...</div></div>`;
    return div;
  }
  if (m.type === "file") {
    const div = document.createElement("div");
    div.className = "file-bubble";
    div.dataset.msgIdx = msgIdx;
    div.dataset.wireId = m.wireId || m.id || "";
    if (!m.mine && m.tempPath) {
      div.style.cursor = "pointer";
      div.onclick = async () => {
        try {
          const saved = await invoke("save_as_dialog", { sourcePath: m.tempPath, defaultName: m.filename });
          if (saved) {
            await invoke("delete_temp_file", { path: m.tempPath });
            m.tempPath = null;
            renderMessages(true);
          }
        } catch (e) {
          console.error("[ChatLAN] save_as error:", e);
        }
      };
    }
    const sizeStr = m.size > 0 ? (m.size / 1024 / 1024).toFixed(1) + " MB" : "";
    const hint = !m.mine && m.tempPath ? " — Click para guardar" : "";
    div.innerHTML = `${ICO_FILE}
      <div><div class="file-name">${m.filename}</div>
      <div class="file-size">${sizeStr}${sizeStr && m.ts ? " · " : ""}${m.ts}${hint}</div></div>`;
    const rx = renderBubbleReactions(m);
    if (rx) div.appendChild(rx);
    attachBubbleActions(div, m);
    return div;
  }
  if (m.type === "audio") {
    const div = document.createElement("div");
    div.className = `bubble ${m.mine ? "mine" : "theirs"}`;
    div.dataset.msgIdx = msgIdx;
    div.dataset.wireId = m.wireId || m.id || "";
    const audioSrc = m.url || (m.tempPath ? window.__TAURI__.core.convertFileSrc(m.tempPath) : "");
    if (audioSrc) {
      div.innerHTML = `<audio controls src="${audioSrc}" style="width:200px;"></audio><span class="ts">${m.ts}${check}</span>`;
    } else {
      div.innerHTML = `<span style="opacity:0.6;">[audio]</span><span class="ts">${m.ts}${check}</span>`;
    }
    const rx = renderBubbleReactions(m);
    if (rx) div.appendChild(rx);
    attachBubbleActions(div, m);
    return div;
  }
  const div = document.createElement("div");
  div.className = `bubble ${m.mine ? "mine" : "theirs"}`;
  div.dataset.msgIdx = msgIdx;
  div.dataset.wireId = m.wireId || m.id || "";
  let quoteHtml = "";
  if (m.replyBody) {
    const refName = m.replyFrom || "";
    quoteHtml = `<div class="bubble-quote"><span class="bubble-quote-name">${refName}</span><span class="bubble-quote-text">${m.replyBody}</span></div>`;
  }
  div.innerHTML = `${quoteHtml}${wrapEmojis(m.body)}<span class="ts">${m.ts}${check}</span>`;

  // Double-click to reply/quote
  div.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (!activePeer) return;
    replyingTo = {
      id: m.wireId || m.id,
      from: m.mine ? "Tú" : activePeer.name,
      body: m.body || "",
    };
    showReplyPreview();
    document.getElementById("chatInput").focus();
  });

  const rx = renderBubbleReactions(m);
  if (rx) div.appendChild(rx);
  attachBubbleActions(div, m);
  return div;
}

function pushMessage(peerId, msg) {
  if (!chatHistory[peerId]) chatHistory[peerId] = [];
  chatHistory[peerId].push(msg);
  scheduleSaveHistory();
  if (activePeer && activePeer.id === peerId) renderMessages();
}

document.getElementById("sendBtn").onclick = sendChatMessage;

const chatInputEl = document.getElementById("chatInput");
function autogrow() {
  chatInputEl.style.height = "auto";
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + "px";
  chatInputEl.style.overflowY = chatInputEl.scrollHeight > 120 ? "auto" : "hidden";
}
chatInputEl.addEventListener("input", autogrow);

chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  else if (e.key === "Escape") { replyingTo = null; showReplyPreview(); }
  else sendTyping();
});

document.getElementById("attachBtn").onclick = async () => {
  if (!activePeer) return;
  try {
    const result = await invoke("open_file_dialog");
    if (result && result.path) {
      const filename = result.path.split(/[/\\]/).pop();
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
      pushMessage(activePeer.id, { type: "file", filename, size: result.size, ts, mine: true });
      await invoke("send_file_path", { peerId: activePeer.id, path: result.path });
    }
  } catch (e) {
    console.error("[ChatLAN] open_file_dialog error:", e);
  }
};

async function sendChatMessage() {
  const input = document.getElementById("chatInput");
  const body = input.value.trim();
  if (!body || !activePeer) return;
  input.value = "";
  autogrow();
  const replyTo = replyingTo ? replyingTo.id : null;
  const replyBody = replyingTo ? replyingTo.body : null;
  const replyFrom = replyingTo ? replyingTo.from : null;
  replyingTo = null;
  showReplyPreview();
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  try {
    const msgId = await invoke("send_text", { peerId: activePeer.id, body, replyTo, replyBody, replyFrom });
    pushMessage(activePeer.id, { type: "text", body, ts, mine: true, replyTo, replyBody, replyFrom, wireId: msgId });
  } catch (e) {
    console.error(e);
    pushMessage(activePeer.id, { type: "text", body: `⚠ No se pudo enviar: ${e}`, ts, mine: true });
    renderMessages();
  }
}

function handleIncoming(msg) {
  console.log("[ChatLAN] handleIncoming kind=" + msg.kind + " id=" + msg.id);
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  if (msg.kind === "Text") {
    const peer = findOrCreatePeer(msg.id, msg.from);
    pushMessage(peer.id, { type: "text", body: msg.body, ts: msg.ts, mine: false, replyTo: msg.reply_to || null, replyBody: msg.reply_body || null, replyFrom: msg.reply_from || null, wireId: msg.msg_id || msg.id });
    if (activePeer && activePeer.id === peer.id) {
      sendReadReceipt();
    } else {
      unreadCounts[peer.id] = (unreadCounts[peer.id] || 0) + 1;
      refreshContactsBadges();
      showNotifOverlay(msg.from, msg.body, peer);
    }
  }
  if (msg.kind === "FileStart") {
    const peer = findOrCreatePeer(msg.sender_id, msg.from);
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(msg.filename);
    const fileKey = msg.id;
    if (isImage) {
      pushMessage(peer.id, { type: "image-receiving", fileKey, filename: msg.filename, ts, mine: false });
    } else {
      pushMessage(peer.id, { type: "file-receiving", fileKey, filename: msg.filename, size: msg.size, ts, mine: false });
    }
  }
  if (msg.kind === "FileReceived") {
    const peer = findOrCreatePeer(msg.sender_id, msg.from);
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(msg.filename);
    const isAudio = /\.(wav|mp3|webm|ogg|m4a)$/i.test(msg.filename);
    const fileKey = msg.id;
    if (isImage) {
      invoke("read_file_as_base64", { path: msg.temp_path }).then(dataUrl => {
        replaceReceivingImage(peer.id, fileKey, dataUrl, msg.temp_path);
      }).catch(e => {
        console.error("[ChatLAN] read_file_as_base64 error:", e);
        replaceReceivingImage(peer.id, fileKey, null, null);
      });
    } else if (isAudio) {
      replaceReceivingAudio(peer.id, fileKey, msg.temp_path, ts);
    } else {
      replaceReceivingFile(peer.id, fileKey, msg.temp_path, msg.filename, msg.size, ts);
    }
  }
  if (msg.kind === "AvatarUpdate") {
    peerAvatars[msg.id] = msg.avatar_b64;
    refreshPeers();
    if (activePeer && activePeer.id === msg.id) {
      updateChatPeerAvatar(activePeer);
    }
  }
  if (msg.kind === "Typing") {
    const ti = document.getElementById("typingIndicator");
    if (activePeer && activePeer.id === msg.id) {
      ti.classList.add("active");
      ti.innerHTML = `Escribiendo<span class="typing-dots"><span></span><span></span><span></span></span>`;
      const dot = document.getElementById("onlineDot");
      if (dot) dot.style.display = "none";
    }
    if (peerTypingTimers[msg.id]) clearTimeout(peerTypingTimers[msg.id]);
    peerTypingTimers[msg.id] = setTimeout(() => {
      if (activePeer && activePeer.id === msg.id) {
        ti.classList.remove("active");
        ti.innerHTML = "";
        const dot = document.getElementById("onlineDot");
        if (dot) dot.style.display = "";
      }
      delete peerTypingTimers[msg.id];
    }, 3000);
  }
  if (msg.kind === "Read") {
    if (chatHistory[msg.id]) {
      for (const m of chatHistory[msg.id]) {
        if (m.mine) m.read = true;
      }
      scheduleSaveHistory();
      if (activePeer && activePeer.id === msg.id) renderMessages(true);
    }
  }
  if (msg.kind === "DeleteMessage") {
    const hist = chatHistory[msg.id];
    if (hist) {
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].wireId === msg.msg_id) {
          hist.splice(i, 1);
          break;
        }
      }
      scheduleSaveHistory();
      if (activePeer && activePeer.id === msg.id) renderMessages(true);
    }
  }
  if (msg.kind === "Reaction") {
    const reactions = applyReactionData(msg.id, msg.msg_id, msg.emoji, msg.id, msg.action || "add");
    scheduleSaveHistory();
    if (activePeer && activePeer.id === msg.id) {
      updateBubbleReactionsInDom(msg.msg_id, reactions);
    }
  }
}

// Clipboard image paste (Ctrl+V)
document.getElementById("chatInput").addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const blob = item.getAsFile();
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.slice(i, i + chunk));
      }
      const b64 = btoa(binary);
      const mime = blob.type || "image/png";
      const dataUrl = `data:${mime};base64,${b64}`;
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
      pushMessage(activePeer.id, { type: "image", url: dataUrl, ts, mine: true, filename: "clipboard.png" });
      try {
        const tempPath = await invoke("save_temp_image", { data: Array.from(bytes), ext: "png" });
        const lastMsg = chatHistory[activePeer.id]?.slice(-1)[0];
        if (lastMsg && lastMsg.type === "image") { lastMsg.filePath = tempPath; scheduleSaveHistory(); }
        await invoke("send_clipboard_image", { peerId: activePeer.id, data: Array.from(bytes) });
      } catch (err) {
        console.error("[ChatLAN] send image error:", err);
        pushMessage(activePeer.id, { type: "text", body: `⚠ Error enviando imagen: ${err}`, ts, mine: true });
        renderMessages();
      }
      return;
    }
  }
});

function replaceReceivingImage(peerId, fileKey, url, filePath) {
  if (!chatHistory[peerId]) return;
  for (let i = chatHistory[peerId].length - 1; i >= 0; i--) {
    const m = chatHistory[peerId][i];
    if (m.type === "image-receiving" && m.fileKey === fileKey) {
      chatHistory[peerId][i] = { type: "image", url, ts: m.ts, mine: false, filePath: filePath || null };
      scheduleSaveHistory();
      if (activePeer && activePeer.id === peerId) renderMessages(true);
      return;
    }
  }
}

function replaceReceivingFile(peerId, fileKey, tempPath, filename, size, ts) {
  if (!chatHistory[peerId]) return;
  for (let i = chatHistory[peerId].length - 1; i >= 0; i--) {
    const m = chatHistory[peerId][i];
    if (m.type === "file-receiving" && m.fileKey === fileKey) {
      chatHistory[peerId][i] = { type: "file", filename, size, ts, mine: false, tempPath };
      scheduleSaveHistory();
      if (activePeer && activePeer.id === peerId) renderMessages(true);
      return;
    }
  }
}

function replaceReceivingAudio(peerId, fileKey, tempPath, ts) {
  if (!chatHistory[peerId]) return;
  for (let i = chatHistory[peerId].length - 1; i >= 0; i--) {
    const m = chatHistory[peerId][i];
    if (m.type === "file-receiving" && m.fileKey === fileKey) {
      chatHistory[peerId][i] = { type: "audio", tempPath, ts, mine: false };
      scheduleSaveHistory();
      if (activePeer && activePeer.id === peerId) renderMessages(true);
      return;
    }
  }
}

async function showNotifOverlay(sender, body, peer) {
  try {
    await invoke("show_notification", { sender, body, peerId: peer.id });
  } catch (e) {
    console.error("[ChatLAN] show_notification error:", e);
  }
}

listen("notif-reply-echo", (e) => {
  const { peerId, body, ts, msgId } = e.payload;
  pushMessage(peerId, { type: "text", body, ts, mine: true, wireId: msgId });
});

listen("notif-open-chat", (e) => {
  const { peerId, peerName } = e.payload;
  const peer = peers.find(p => p.id === peerId) || { id: peerId, name: peerName, addr: "", online: true };
  openChat(peer);
});

const resizeHandle = document.getElementById("resizeHandle");
if (resizeHandle) {
  resizeHandle.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    try { await win.startResizeDragging("BottomRight"); } catch (err) {}
  });
}

// Audio notes
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;

document.getElementById("micBtn").onclick = async () => {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    try {
      const constraints = { audio: true };
      if (userSettings.audio_device) {
        constraints.audio = { deviceId: { exact: userSettings.audio_device } };
      }
      audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      let mimeType = "";
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        mimeType = "audio/webm";
      } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
        mimeType = "audio/ogg;codecs=opus";
      }
      const opts = mimeType ? { mimeType } : {};
      mediaRecorder = new MediaRecorder(audioStream, opts);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null; }
        const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
        if (audioChunks.length === 0 || !activePeer) return;
        const blob = new Blob(audioChunks, { type: mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        pushMessage(activePeer.id, { type: "audio", url, ts, mine: true });
        renderMessages();
        (async () => {
          try {
            const arr = new Uint8Array(await blob.arrayBuffer());
            const ext = (mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
            const tempPath = await invoke("save_temp_file", { data: Array.from(arr), ext });
            const lastMsg = chatHistory[activePeer.id]?.slice(-1)[0];
            if (lastMsg && lastMsg.type === "audio") { lastMsg.tempPath = tempPath; scheduleSaveHistory(); }
            await invoke("send_file_path", { peerId: activePeer.id, path: tempPath });
          } catch (e) {
            console.error("[ChatLAN] audio send error:", e);
          }
        })();
      };
      mediaRecorder.start(100);
      document.getElementById("micBtn").innerHTML = ICO_PAUSE;
    } catch (e) {
      console.error("[ChatLAN] audio start error:", e);
    }
  } else {
    mediaRecorder.stop();
    mediaRecorder = null;
    document.getElementById("micBtn").innerHTML = ICO_MIC;
  }
};

// Quick reply popup
document.getElementById("qrCloseBtn").onclick = () => win.hide();
document.getElementById("qrSendBtn").onclick = async () => {
  const input = document.getElementById("qrInput");
  const body = input.value.trim();
  if (!body || !activePeer) return;
  await invoke("send_text", { peerId: activePeer.id, body, replyTo: null, replyBody: null, replyFrom: null });
  input.value = "";
  win.hide();
};

// Settings
let userSettings = { sound_enabled: true, audio_device: "", font_size: 14, emoji_size: 20 };
let userAvatarDataUrl = null;

function applyFontSizes() {
  document.documentElement.style.setProperty("--bubble-font", userSettings.font_size + "px");
  const chatView = document.getElementById("view-chat");
  if (chatView) chatView.style.setProperty("--emoji-font", userSettings.emoji_size + "px");
}

async function loadSettings() {
  try {
    userSettings = await invoke("load_settings");
    if (!userSettings.font_size) userSettings.font_size = 14;
    if (!userSettings.emoji_size) userSettings.emoji_size = 20;
  } catch (e) {
    userSettings = { sound_enabled: true, audio_device: "", font_size: 14, emoji_size: 20 };
  }
  document.getElementById("settingsNick").value = document.getElementById("loginName").value;
  document.getElementById("settingsSoundToggle").checked = userSettings.sound_enabled;
  document.getElementById("settingsFontSize").value = userSettings.font_size;
  document.getElementById("fontSizeVal").textContent = userSettings.font_size;
  document.getElementById("settingsEmojiSize").value = userSettings.emoji_size;
  document.getElementById("emojiSizeVal").textContent = userSettings.emoji_size;
  applyFontSizes();
  populateAudioDevices();
  await loadAvatar();
  await loadPeerAvatars();
}

async function loadAvatar() {
  try {
    userAvatarDataUrl = await invoke("load_avatar");
  } catch (e) {
    userAvatarDataUrl = null;
  }
  updateAvatarDisplay();
}

async function loadPeerAvatars() {
  try {
    const avatars = await invoke("get_avatars");
    Object.assign(peerAvatars, avatars);
    refreshPeers();
  } catch (e) {}
}

function updateAvatarDisplay() {
  const headerAvatar = document.getElementById("userAvatar");
  const settingsPreview = document.getElementById("settingsAvatarPreview");
  const nick = document.getElementById("loginName").value.trim();
  const initials = nick.slice(0, 2).toUpperCase();
  if (userAvatarDataUrl) {
    headerAvatar.innerHTML = `<img src="${userAvatarDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    settingsPreview.innerHTML = `<img src="${userAvatarDataUrl}" />`;
  } else {
    headerAvatar.textContent = initials;
    settingsPreview.innerHTML = `<span>${initials}</span>`;
  }
}

document.getElementById("settingsAvatarPreview").onclick = async () => {
  try {
    const dataUrl = await invoke("save_avatar");
    if (dataUrl) {
      userAvatarDataUrl = dataUrl;
      updateAvatarDisplay();
      await invoke("broadcast_avatar", { avatarB64: dataUrl });
    }
  } catch (e) {
    console.error("[ChatLAN] save_avatar error:", e);
  }
};

document.getElementById("settingsClearAvatar").onclick = async () => {
  try {
    await invoke("clear_avatar");
    userAvatarDataUrl = null;
    updateAvatarDisplay();
    await invoke("broadcast_avatar", { avatarB64: "" });
  } catch (e) {
    console.error("[ChatLAN] clear_avatar error:", e);
  }
};

async function populateAudioDevices() {
  const select = document.getElementById("settingsAudioDevice");
  select.innerHTML = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === "audioinput");
    audioInputs.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Micrófono ${select.children.length + 1}`;
      if (d.deviceId === userSettings.audio_device) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (e) {
    console.error("[ChatLAN] enumerateDevices error:", e);
  }
}

document.getElementById("settingsBackBtn").onclick = () => showView("contacts");

document.getElementById("settingsApplyBtn").onclick = async () => {
  const nick = document.getElementById("settingsNick").value.trim();
  if (!nick) return;
  await invoke("set_self_name", { name: nick });
  await invoke("save_nick", { name: nick });
  await invoke("re_announce");
  document.getElementById("loginName").value = nick;
  userSettings.sound_enabled = document.getElementById("settingsSoundToggle").checked;
  userSettings.audio_device = document.getElementById("settingsAudioDevice").value;
  userSettings.font_size = parseInt(document.getElementById("settingsFontSize").value, 10);
  userSettings.emoji_size = parseInt(document.getElementById("settingsEmojiSize").value, 10);
  await invoke("save_settings", { soundEnabled: userSettings.sound_enabled, audioDevice: userSettings.audio_device, fontSize: userSettings.font_size, emojiSize: userSettings.emoji_size });
  applyFontSizes();
  updateAvatarDisplay();
  showView("contacts");
};

document.getElementById("settingsFontSize").addEventListener("input", (e) => {
  document.getElementById("fontSizeVal").textContent = e.target.value;
});
document.getElementById("settingsEmojiSize").addEventListener("input", (e) => {
  document.getElementById("emojiSizeVal").textContent = e.target.value;
});

async function initDragDrop() {
  try {
    await getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const overlay = document.getElementById("dragOverlay");
        overlay.classList.remove("active");
        isDragging = false;
        for (const path of event.payload.paths) {
          sendDroppedFile(path);
        }
      } else if (event.payload.type === "over") {
        if (views.chat.classList.contains("active")) {
          const overlay = document.getElementById("dragOverlay");
          overlay.classList.add("active");
          isDragging = true;
        }
      } else if (event.payload.type === "leave") {
        const overlay = document.getElementById("dragOverlay");
        overlay.classList.remove("active");
        isDragging = false;
      }
    });
  } catch (e) {}
}

const EMOJI_DATA = [
  // Smileys & Emotion
  { emoji: "😀", name: "sonrisa feliz sonriente alegre contento grin grinning smile happy" },
  { emoji: "😃", name: "sonrisa feliz alegre grande smile happy grinning big" },
  { emoji: "😄", name: "risa sonriente feliz contento laugh smile happy laughing" },
  { emoji: "😁", name: "dientes mueca feliz contento beaming smile grin teeth" },
  { emoji: "😆", name: "carcajada risa ojos cerrados laughing squint haha" },
  { emoji: "😅", name: "sudor risa alivio sudando nervioso sweat smile nervous" },
  { emoji: "🤣", name: "carcajada suelo rodar risa rofl laughing rolling floor" },
  { emoji: "😂", name: "risa llorar risa lagrimas joy tears laugh lol haha" },
  { emoji: "🙂", name: "sonrisa leve cara sonriente slightly smiling face" },
  { emoji: "😉", name: "guiño ojo winking wink flirtear flirt" },
  { emoji: "😊", name: "sonrojado rubor tierno feliz contento blush smiling happy" },
  { emoji: "😍", name: "ojos corazon enamorado amor love heart eyes romantic" },
  { emoji: "🤩", name: "estrellas ojos emocionado genial star struck excited amazed" },
  { emoji: "😘", name: "beso amor corazon blowing kiss love affection" },
  { emoji: "😋", name: "delicioso sabroso comida rico yummy delicious tongue savoring" },
  { emoji: "😛", name: "lengua broma chiste tongue playful joke" },
  { emoji: "😜", name: "lengua guiño loco broma winking tongue crazy playful" },
  { emoji: "🤪", name: "loco chiflado payaso alocado zany goofy crazy wild" },
  { emoji: "😝", name: "lengua ojos cerrados squinting tongue" },
  { emoji: "🤑", name: "dinero plata rico ojos dinero money rich dollar cash" },
  { emoji: "🤗", name: "abrazo carinoso abrazar hug hugging loving affectionate" },
  { emoji: "🤭", name: "mano boca risita secreto oops giggling hand over mouth" },
  { emoji: "🤫", name: "silencio callar secreto shh shushing quiet secret" },
  { emoji: "🤔", name: "pensando duda pensar reflexion que thinking ponder question" },
  { emoji: "😐", name: "neutral cara seria neutral face blank" },
  { emoji: "😑", name: "inexpresivo cansado fastidio expressionless straight face" },
  { emoji: "😶", name: "sin boca silencio mudo speechless face without mouth" },
  { emoji: "😏", name: "sonrisa picara ironica pillo smirk smug suggestive" },
  { emoji: "😒", name: "aburrido desaprobacion desgano unamused annoyed side eye" },
  { emoji: "🙄", name: "ojos en blanco fastidio cansancio rolling eyes bored whatever" },
  { emoji: "😬", name: "mueca incomodo verguenza oops grimacing awkward cringe" },
  { emoji: "😮", name: "sorpresa boca abierta asombro open mouth surprise wow" },
  { emoji: "😯", name: "sorprendido wow oh hushed surprised gasp" },
  { emoji: "😲", name: "asombrado impactado atonito astonished shocked stunned" },
  { emoji: "😳", name: "sonrojado verguenza sorprendido flushed shy embarrassed wide eyes" },
  { emoji: "🥺", name: "por favor tierno suplica carita pleading puppy eyes beg please cute" },
  { emoji: "😢", name: "triste lagrima llorar pena crying tear sad unhappy" },
  { emoji: "😭", name: "llorar llorando llanto desconsuelo sob loud crying sad" },
  { emoji: "😤", name: "humo nariz triunfo rabia huffing triumph angry annoyed" },
  { emoji: "😠", name: "enojado bravo enfadado molesto angry mad grr" },
  { emoji: "😡", name: "furia muy enojado furioso rabia rage angry pouting" },
  { emoji: "🤬", name: "insulto maldicion groseria censura swearing symbols cursing toxic" },
  { emoji: "😈", name: "diablillo diablo travieso picaro smiling devil evil naughty" },
  { emoji: "👿", name: "diablo enojado furioso imp devil demon evil" },
  { emoji: "💀", name: "calavera muerte muerto esqueleto skull dead death skeleton lol" },
  { emoji: "☠️", name: "calavera peligro pirata muerte pirate skull crossbones danger" },
  { emoji: "💩", name: "caca popo mierda poop pile excrement" },
  { emoji: "🤡", name: "payaso clown circo bizarro clown face" },
  { emoji: "👹", name: "ogro mascara demonio ogre japanese monster mask" },
  { emoji: "👺", name: "duende goblin tengu mascara roja red mask" },
  { emoji: "👻", name: "fantasma buu susto halloween ghost spooky boo" },
  { emoji: "👽", name: "alien extraterrestre ovni marciano ufo extraterrestrial" },
  { emoji: "👾", name: "monstruo pixel videojuego retro arcade space invader monster game" },
  { emoji: "🤖", name: "robot tecnologia bot androide bot tech machine" },
  { emoji: "😺", name: "gato sonrisa feliz smiling cat" },
  { emoji: "😸", name: "gato risa ojos sonrientes grinning cat smiling" },
  { emoji: "😹", name: "gato llorando risa cat joy tears laugh" },
  { emoji: "😻", name: "gato enamorado ojos corazon cat heart eyes love" },
  { emoji: "😼", name: "gato ironico picaro smirk cat" },
  { emoji: "😽", name: "gato beso kissing cat" },

  // Gestures & Body
  { emoji: "👍", name: "pulgar arriba me gusta bien ok si de acuerdo like thumbs up approve yes" },
  { emoji: "👎", name: "pulgar abajo no me gusta mal no dislike thumbs down disapprove" },
  { emoji: "👊", name: "puno punetazo choque punos fist punch brofist" },
  { emoji: "✊", name: "puno arriba fuerza poder lucha raised fist power solidarity" },
  { emoji: "🤛", name: "puno izquierda left facing fist bump" },
  { emoji: "🤜", name: "puno derecha right facing fist bump" },
  { emoji: "🤝", name: "apreton manos acuerdo trato sociedad handshake deal agreement partnership" },
  { emoji: "👏", name: "aplauso aplausos felicidades bravo clapping hands applause bravo" },
  { emoji: "🙌", name: "manos arriba celebracion aleluya hurra raising hands celebrate hooray" },
  { emoji: "🤲", name: "manos juntas oracion palmas abiertas palms together praying" },
  { emoji: "🙏", name: "rezar oracion por favor gracias plegaria bendicion pray please thanks bless" },
  { emoji: "✌️", name: "paz victoria dos victory peace fingers two" },
  { emoji: "🤞", name: "dedos cruzados suerte ojala crossed fingers luck hopeful" },
  { emoji: "🤟", name: "te quiero te amo amor rock love you gesture sign" },
  { emoji: "🤘", name: "rock cuernos heavy metal musica horns rock on sign" },
  { emoji: "🤙", name: "llamame shaka surfer onda call me hang loose" },
  { emoji: "👈", name: "senalar izquierda point left hand" },
  { emoji: "👉", name: "senalar derecha point right hand" },
  { emoji: "👆", name: "senalar arriba point up index" },
  { emoji: "👇", name: "senalar abajo point down index" },

  // Hearts & Celebrations & Badges
  { emoji: "❤️", name: "corazon rojo amor te amo te quiero me encanta red heart love passion" },
  { emoji: "🧡", name: "corazon naranja orange heart" },
  { emoji: "💛", name: "corazon amarillo amistad yellow heart friendship" },
  { emoji: "💚", name: "corazon verde green heart nature" },
  { emoji: "💙", name: "corazon azul blue heart loyalty" },
  { emoji: "💜", name: "corazon morado purpura purple heart" },
  { emoji: "🖤", name: "corazon negro luto black heart dark" },
  { emoji: "🤍", name: "corazon blanco paz pureza white heart peace" },
  { emoji: "🤎", name: "corazon marron cafe brown heart" },
  { emoji: "💯", name: "cien perfecto nota 100 hundred points perfect score top" },
  { emoji: "🔥", name: "fuego candela llama caliente quemar crack lit fire flame hot burn trending" },
  { emoji: "⭐", name: "estrella favorito star gold favorite" },
  { emoji: "🌟", name: "estrella brillante resplandor glowing star shining bright" },
  { emoji: "✨", name: "destellos chispas brillo magia chispitas sparkles glitter magic clean" },
  { emoji: "💫", name: "mareo estrella brillante dizzy sparkle" },
  { emoji: "🎉", name: "fiesta celebracion cumpleanos felicidades tada party popper celebrate congrats" },
  { emoji: "🎊", name: "confeti fiesta celebracion carnaval confetti ball celebration party" },
  { emoji: "🎈", name: "globo fiesta cumpleanos balloon birthday party" },
  { emoji: "🎁", name: "regalo sorpresa detalle present gift box wrapped" },
  { emoji: "🎂", name: "pastel tarta cumpleanos vela birthday cake celebration" },
  { emoji: "❤️‍🔥", name: "corazon en fuego ardiente pasion amor heart on fire passionate love" },
  { emoji: "💕", name: "dos corazones amor ternura two hearts love affection" },
  { emoji: "💞", name: "corazones girando revolving hearts love" },
  { emoji: "💓", name: "corazon latiendo palpitando beating heart love" },
  { emoji: "💗", name: "corazon creciendo agrandado growing heart love" },
  { emoji: "💖", name: "corazon brillante destellos sparkling heart love shine" },
  { emoji: "💘", name: "flechazo cupido flecha corazon cupid heart arrow romance" },
  { emoji: "💝", name: "regalo corazon lazo cinta heart with ribbon gift" },
  { emoji: "💔", name: "corazon roto desamor dolor tristeza broken heart heartbreak sad" },
  { emoji: "❣️", name: "corazon exclamacion signo admiracion heart exclamation point" },
  { emoji: "☕", name: "cafe cafeina coffee cup drink caliente" },
  { emoji: "🍺", name: "cerveza birra brindar beer alcohol cheers copa" },
  { emoji: "🍕", name: "pizza comida rapida fast food slice" },
  { emoji: "🚀", name: "cohete despegar nave rapido rocket launch fast moon" },
  { emoji: "👀", name: "ojos mirando ver mirar miradas eyes looking watching" },
  { emoji: "⚡", name: "rayo trueno electricidad rapido zap lightning electricity bolt" },
  { emoji: "💡", name: "bombilla idea luz foco light bulb inspiration bright" },
  { emoji: "✅", name: "check aprobado listo bien correcto checkmark done ok yes" },
  { emoji: "❌", name: "cruz no cancelar error equis cross mark x no cancel" }
];

function filterEmojis(query, targetGrid, onSelect) {
  targetGrid.innerHTML = "";
  const cleanQ = (query || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const matched = cleanQ
    ? EMOJI_DATA.filter(item => {
        const cleanName = item.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        return cleanName.includes(cleanQ) || item.emoji.includes(cleanQ);
      })
    : EMOJI_DATA;

  if (matched.length === 0) {
    const hint = document.createElement("div");
    hint.className = "emoji-empty-hint";
    hint.textContent = "No se encontraron emojis";
    targetGrid.appendChild(hint);
    return;
  }

  for (const item of matched) {
    const btn = document.createElement("button");
    btn.className = "emoji-item";
    btn.textContent = item.emoji;
    btn.title = item.name.split(" ").slice(0, 3).join(" ");
    btn.onclick = (e) => {
      e.stopPropagation();
      onSelect(item.emoji);
    };
    targetGrid.appendChild(btn);
  }
}

function initEmojiPicker() {
  const popup = document.getElementById("emojiPopup");
  const searchInput = document.getElementById("emojiSearchInput");
  const grid = document.getElementById("emojiGrid");

  const insertEmoji = (em) => {
    const input = document.getElementById("chatInput");
    const pos = input.selectionStart || input.value.length;
    input.value = input.value.slice(0, pos) + em + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + em.length;
    autogrow();
    popup.classList.remove("open");
  };

  filterEmojis("", grid, insertEmoji);

  searchInput.addEventListener("input", () => {
    filterEmojis(searchInput.value, grid, insertEmoji);
  });

  document.getElementById("emojiBtn").onclick = (e) => {
    e.stopPropagation();
    const willOpen = !popup.classList.contains("open");
    popup.classList.toggle("open");
    if (willOpen) {
      searchInput.value = "";
      filterEmojis("", grid, insertEmoji);
      setTimeout(() => searchInput.focus(), 50);
    }
  };

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".emoji-wrapper")) {
      popup.classList.remove("open");
    }
  });
}

function updateBubbleReactionsInDom(wireId, reactions) {
  if (!wireId) return;
  const box = document.getElementById("messages");
  const bubble = box.querySelector(`.bubble[data-wire-id="${wireId}"], .file-bubble[data-wire-id="${wireId}"]`);
  if (!bubble) return;

  const oldContainer = bubble.querySelector(".bubble-reactions");
  if (oldContainer) oldContainer.remove();

  const msgs = chatHistory[activePeer?.id] || [];
  const realMsg = msgs.find(x => (x.wireId || x.id) === wireId) || { reactions, wireId };

  const newContainer = renderBubbleReactions(realMsg);
  if (newContainer) {
    const actions = bubble.querySelector(".bubble-actions");
    if (actions) {
      bubble.insertBefore(newContainer, actions);
    } else {
      bubble.appendChild(newContainer);
    }
  }
}

function applyReactionData(peerId, msgId, emoji, userId, action) {
  const msgs = chatHistory[peerId] || [];
  const msg = msgs.find(m => (m.wireId || m.id) === msgId);
  if (!msg) return null;

  if (!msg.reactions) msg.reactions = {};
  if (action === "add") {
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    if (!msg.reactions[emoji].includes(userId)) {
      msg.reactions[emoji].push(userId);
    }
  } else if (action === "remove") {
    if (msg.reactions[emoji]) {
      msg.reactions[emoji] = msg.reactions[emoji].filter(u => u !== userId);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    }
  }
  return msg.reactions;
}

async function toggleReaction(peerId, msg, emoji) {
  if (!peerId || !msg) return;
  const wireId = msg.wireId || msg.id;
  if (!wireId) return;

  const users = (msg.reactions && msg.reactions[emoji]) || [];
  const isMine = selfId && users.includes(selfId);
  const action = isMine ? "remove" : "add";

  applyReactionData(peerId, wireId, emoji, selfId, action);
  scheduleSaveHistory();
  updateBubbleReactionsInDom(wireId, msg.reactions);

  try {
    await invoke("send_reaction", {
      peerId,
      msgId: wireId,
      emoji,
      action
    });
  } catch (err) {
    console.error("[ChatLAN] send_reaction error:", err);
  }
}

function openFloatingReactions(m, triggerBtn) {
  reactionTargetMsg = m;
  const bar = document.getElementById("floatingReactions");
  const rect = triggerBtn.getBoundingClientRect();
  const barW = 260;
  const barH = 40;

  let left = rect.left - barW / 2 + rect.width / 2;
  let top = rect.top - barH - 8;

  if (left < 10) left = 10;
  if (left + barW > window.innerWidth - 10) left = window.innerWidth - barW - 10;
  if (top < 10) top = rect.bottom + 8;

  bar.style.left = left + "px";
  bar.style.top = top + "px";
  bar.classList.add("open");

  document.getElementById("reactionEmojiDialog")?.classList.remove("open");
  document.getElementById("contextMenu")?.classList.remove("open");
}

function openReactionEmojiDialog(targetMsg, anchorElem) {
  reactionTargetMsg = targetMsg;
  const dialog = document.getElementById("reactionEmojiDialog");
  const rect = anchorElem.getBoundingClientRect();
  const dialogW = 290;
  const dialogH = 260;

  let left = rect.left;
  let top = rect.top - dialogH - 6;

  if (left + dialogW > window.innerWidth - 10) left = window.innerWidth - dialogW - 10;
  if (left < 10) left = 10;
  if (top < 10) top = rect.bottom + 6;
  if (top + dialogH > window.innerHeight - 10) top = window.innerHeight - dialogH - 10;

  dialog.style.left = left + "px";
  dialog.style.top = top + "px";
  dialog.classList.add("open");

  const searchInput = document.getElementById("reactionEmojiSearch");
  const grid = document.getElementById("reactionEmojiGrid");

  const onReactSelect = (selectedEmoji) => {
    if (reactionTargetMsg && activePeer) {
      toggleReaction(activePeer.id, reactionTargetMsg, selectedEmoji);
    }
    dialog.classList.remove("open");
  };

  searchInput.value = "";
  filterEmojis("", grid, onReactSelect);

  searchInput.oninput = () => {
    filterEmojis(searchInput.value, grid, onReactSelect);
  };

  setTimeout(() => searchInput.focus(), 50);
}

function initReactionPickers() {
  document.querySelectorAll(".rx-quick-btn").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      if (emoji && reactionTargetMsg && activePeer) {
        toggleReaction(activePeer.id, reactionTargetMsg, emoji);
      }
      document.getElementById("floatingReactions").classList.remove("open");
    };
  });

  const floatingMore = document.getElementById("floatingMoreRx");
  if (floatingMore) {
    floatingMore.onclick = (e) => {
      e.stopPropagation();
      const target = reactionTargetMsg;
      document.getElementById("floatingReactions").classList.remove("open");
      if (target) {
        openReactionEmojiDialog(target, e.currentTarget);
      }
    };
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#floatingReactions") && !e.target.closest(".bubble-react-btn")) {
      document.getElementById("floatingReactions")?.classList.remove("open");
    }
    if (!e.target.closest("#reactionEmojiDialog") && !e.target.closest(".rx-more-btn") && !e.target.closest(".ctx-more-btn")) {
      document.getElementById("reactionEmojiDialog")?.classList.remove("open");
    }
  });
}

function initContextMenu() {
  const menu = document.getElementById("contextMenu");
  let contextMsg = null;

  document.querySelectorAll(".ctx-rx-btn:not(.ctx-more-btn)").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const emoji = btn.dataset.emoji;
      if (emoji && contextMsg && activePeer) {
        toggleReaction(activePeer.id, contextMsg, emoji);
      }
      menu.classList.remove("open");
      contextMsg = null;
    };
  });

  const ctxMore = document.getElementById("ctxMoreRx");
  if (ctxMore) {
    ctxMore.onclick = (e) => {
      e.stopPropagation();
      const target = contextMsg;
      menu.classList.remove("open");
      contextMsg = null;
      if (target) {
        openReactionEmojiDialog(target, e.currentTarget);
      }
    };
  }

  document.getElementById("messages").addEventListener("contextmenu", (e) => {
    const bubble = e.target.closest(".bubble, .file-bubble");
    if (!bubble) return;
    e.preventDefault();
    const idx = parseInt(bubble.dataset.msgIdx, 10);
    if (isNaN(idx)) return;
    const msgs = chatHistory[activePeer?.id] || [];
    contextMsg = msgs[idx];
    if (!contextMsg) return;
    const menuW = 180;
    const menuH = 135;
    let left = e.clientX;
    let top = e.clientY;
    if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 4;
    if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 4;
    if (left < 0) left = 4;
    if (top < 0) top = 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.classList.add("open");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".context-menu")) {
      menu.classList.remove("open");
      contextMsg = null;
    }
  });

  document.getElementById("ctxReply").onclick = () => {
    if (!contextMsg || !activePeer) return;
    replyingTo = {
      id: contextMsg.wireId || null,
      from: contextMsg.mine ? "Tú" : activePeer.name,
      body: contextMsg.body || "",
    };
    showReplyPreview();
    menu.classList.remove("open");
    contextMsg = null;
    document.getElementById("chatInput").focus();
  };

  document.getElementById("ctxDelete").onclick = () => {
    if (!contextMsg || !activePeer) return;
    const msg = contextMsg;
    const isMine = msg.mine;
    const text = isMine
      ? "Este mensaje se eliminará para ti y para el peer remoto."
      : "Este mensaje se eliminará solo para ti. El peer remoto aún lo verá.";
    showConfirm(text, async () => {
      const hist = chatHistory[activePeer.id];
      const idx = hist.indexOf(msg);
      if (idx !== -1) hist.splice(idx, 1);
      scheduleSaveHistory();
      renderMessages(true);
      if (isMine && msg.wireId) {
        try {
          await invoke("send_delete_message", { peerId: activePeer.id, msgId: msg.wireId });
        } catch (e) {
          console.error("[ChatLAN] send_delete_message error:", e);
        }
      }
    });
    menu.classList.remove("open");
    contextMsg = null;
  };
}

document.getElementById("messages").addEventListener("load", (e) => {
  if (e.target.tagName === "IMG") scrollChatToBottom();
}, true);

function showConfirm(text, onYes) {
  const modal = document.getElementById("confirmModal");
  document.getElementById("confirmText").textContent = text;
  modal.classList.add("open");
  const yesBtn = document.getElementById("confirmYes");
  const noBtn = document.getElementById("confirmNo");
  const cleanup = () => {
    modal.classList.remove("open");
    yesBtn.onclick = null;
    noBtn.onclick = null;
  };
  yesBtn.onclick = () => { cleanup(); onYes(); };
  noBtn.onclick = cleanup;
}

document.getElementById("chatMenuBtn").onclick = () => {
  if (!activePeer) return;
  showConfirm("¿Eliminar todo el historial de chat con este peer?", () => {
    chatHistory[activePeer.id] = [];
    scheduleSaveHistory();
    renderMessages(true);
  });
};

function showReplyPreview() {
  const bar = document.getElementById("replyPreview");
  if (!replyingTo) {
    bar.classList.remove("active");
    return;
  }
  document.getElementById("replyPreviewName").textContent = replyingTo.from;
  document.getElementById("replyPreviewText").textContent = replyingTo.body || "[archivo]";
  bar.classList.add("active");
}

document.getElementById("replyPreviewClose").onclick = () => {
  replyingTo = null;
  showReplyPreview();
};

async function sendDroppedFile(path) {
  if (!activePeer) return;
  const filename = path.split(/[/\\]/).pop();
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: true });
  pushMessage(activePeer.id, { type: "file", filename, size: 0, ts, mine: true });
  renderMessages();
  try {
    const size = await invoke("get_file_size", { path });
    const lastMsg = chatHistory[activePeer.id]?.slice(-1)[0];
    if (lastMsg && lastMsg.type === "file") { lastMsg.size = size; scheduleSaveHistory(); }
    renderMessages(true);
    await invoke("send_file_path", { peerId: activePeer.id, path });
  } catch (e) {
    console.error("[ChatLAN] drop file error:", e);
  }
}

init();
