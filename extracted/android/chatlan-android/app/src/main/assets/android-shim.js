// Sustituye window.__TAURI__ (Tauri) por un puente hacia el backend Kotlin.
(function () {
  const pending = {};
  let nextId = 1;
  window.__tauriResolve = (id, ok, val) => {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    ok ? p.res(val) : p.rej(val);
  };
  const invoke = (cmd, args) => new Promise((res, rej) => {
    const id = nextId++;
    pending[id] = { res, rej };
    try { AndroidBridge.invoke(id, cmd, JSON.stringify(args || {})); }
    catch (e) { delete pending[id]; rej(String(e)); }
  });
  const listeners = {};
  const listen = async (name, cb) => {
    (listeners[name] = listeners[name] || []).push(cb);
    return () => { listeners[name] = (listeners[name] || []).filter(f => f !== cb); };
  };
  const emit = async (name, payload) => {
    (listeners[name] || []).slice().forEach(cb => cb({ event: name, payload }));
  };
  window.__tauriEmit = (name, payload) => emit(name, payload);
  const noop = async () => {};
  const base = {
    listen, emit,
    minimize: async () => AndroidBridge.moveToBack(),
    hide: async () => AndroidBridge.moveToBack(),
    show: noop,
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: innerWidth, height: innerHeight }),
    onDragDropEvent: async () => () => {},
  };
  const win = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
  const CACHE = AndroidBridge.cacheDir();
  const convertFileSrc = (p) =>
    p && p.startsWith(CACHE)
      ? "https://appassets.androidplatform.net/cache/" + encodeURI(p.slice(CACHE.length).replace(/^\//, ""))
      : p;
  window.__TAURI__ = {
    core: { invoke, convertFileSrc },
    window: { getCurrentWindow: () => win },
    event: { listen, emit },
  };
  // Botón "atrás" de Android: vuelve a contactos desde chat/ajustes.
  window.__androidBack = () => {
    const visible = (id) => { const el = document.getElementById(id); return el && el.classList.contains("active"); };
    if (visible("view-chat")) { const b = document.getElementById("backBtn"); if (b) { b.click(); return true; } }
    const sb = document.getElementById("settingsBackBtn");
    if (sb && sb.offsetParent !== null) { sb.click(); return true; }
    return false;
  };
})();
