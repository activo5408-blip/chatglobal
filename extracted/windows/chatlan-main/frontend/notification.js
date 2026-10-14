const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const win = getCurrentWindow();
let notifData = null;

const AUTO_CLOSE_DELAY = 5000;
let autoCloseTimer = null;
let userInteracting = false;

const replyInput = document.getElementById("replyInput");
const replyBtn = document.getElementById("replyBtn");
const closeBtn = document.getElementById("closeBtn");
const card = document.getElementById("card");

function startAutoCloseTimer() {
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  if (!userInteracting) {
    autoCloseTimer = setTimeout(() => {
      win.hide();
    }, AUTO_CLOSE_DELAY);
  }
}

function markUserInteraction() {
  userInteracting = true;
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
}

if (replyInput) {
  replyInput.addEventListener("focus", markUserInteraction);
  replyInput.addEventListener("input", markUserInteraction);
  replyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendReply();
  });
}

if (closeBtn) {
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    if (notifData && notifData.peerId) {
      invoke("send_read_receipt", { peerId: notifData.peerId }).catch(() => {});
    }
    win.hide();
  });
}

if (card) {
  card.addEventListener("click", (e) => {
    if (e.target.closest(".reply-bar") || e.target.closest(".close-btn")) return;
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    if (notifData && notifData.peerId) {
      invoke("send_read_receipt", { peerId: notifData.peerId }).catch(() => {});
      window.__TAURI__.event.emit("notif-open-chat", { peerId: notifData.peerId, peerName: notifData.sender });
    }
    win.hide();
  });
}

async function sendReply() {
  if (!replyInput) return;
  const body = replyInput.value.trim();
  if (!body || !notifData) return;
  replyInput.value = "";
  try {
    await invoke("send_reply_from_notif", {
      peerId: notifData.peerId,
      body,
      replyTo: null,
      replyBody: null,
      replyFrom: null
    });
    win.hide();
  } catch (e) {
    console.error("[notif] reply error:", e);
    const msgBody = document.getElementById("msgBody");
    if (msgBody) msgBody.textContent = "Error: " + e;
  }
}

if (replyBtn) {
  replyBtn.addEventListener("click", sendReply);
}

window.__TAURI__.event.listen("notif-content", (e) => {
  notifData = e.payload;
  userInteracting = false;

  const senderEl = document.getElementById("sender");
  const msgBodyEl = document.getElementById("msgBody");
  const avatarEl = document.getElementById("notifAvatar");
  const replyBar = document.getElementById("replyBar");

  if (senderEl) senderEl.textContent = notifData.sender || "";
  if (msgBodyEl) msgBodyEl.textContent = notifData.body || "";

  if (avatarEl) {
    if (notifData.avatar) {
      avatarEl.innerHTML = '<img src="' + notifData.avatar + '" />';
    } else {
      avatarEl.textContent = (notifData.sender || "?").slice(0, 2).toUpperCase();
    }
  }

  if (replyBar) replyBar.style.display = "flex";
  if (replyInput) {
    replyInput.style.display = "";
    replyInput.value = "";
  }
  if (replyBtn) replyBtn.style.display = "";

  startAutoCloseTimer();
});