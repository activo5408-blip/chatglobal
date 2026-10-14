// Micrófono: medidor de nivel (barra vertical) junto al selector, volumen ajustable y
// aplicación del dispositivo/volumen elegidos a notas de voz y llamadas. Cargar ANTES de app.js.
(function () {
  "use strict";
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const LS_GAIN = "chatlan.micGain";
  const AC = window.AudioContext || window.webkitAudioContext;
  const rawGUM = md.getUserMedia.bind(md);
  window.__rawGUM = rawGUM;

  // ---------------------------------------------------------------- volumen
  function loadGain() {
    try { const v = parseFloat(localStorage.getItem(LS_GAIN)); if (isFinite(v) && v >= 0 && v <= 2) return v; } catch (e) {}
    return 1;
  }
  let gain = loadGain();
  const liveNodes = new Set(); // GainNode de flujos ya procesados (ajuste en vivo)

  function chosenDevice() {
    try {
      const sel = document.getElementById("settingsAudioDevice");
      if (sel && sel.value) return sel.value;
      if (typeof userSettings !== "undefined" && userSettings && userSettings.audio_device) return userSettings.audio_device;
    } catch (e) {}
    return "";
  }

  async function processGain(raw) {
    try {
      if (!AC || !raw.getAudioTracks().length) return raw;
      const ctx = new AC();
      if (ctx.state === "suspended") await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 600))]);
      if (ctx.state !== "running") { try { ctx.close(); } catch (e) {} return raw; }
      const src = ctx.createMediaStreamSource(new MediaStream(raw.getAudioTracks()));
      const g = ctx.createGain(); g.gain.value = gain;
      const lim = ctx.createDynamicsCompressor();      // limitador suave: evita saturar al subir el volumen
      lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
      const dst = ctx.createMediaStreamDestination();
      src.connect(g); g.connect(lim); lim.connect(dst);
      const outAudio = dst.stream.getAudioTracks()[0];
      const out = new MediaStream([outAudio].concat(raw.getVideoTracks()));
      const origStop = outAudio.stop.bind(outAudio);
      outAudio.stop = () => {
        origStop();
        raw.getTracks().forEach((t) => t.stop());
        liveNodes.delete(g);
        try { ctx.close(); } catch (e) {}
      };
      liveNodes.add(g);
      return out;
    } catch (e) { return raw; }
  }

  // ---------------------------------------------------------------- selección robusta de micrófono
  // Problemas que resuelve con varios micrófonos (sobre todo en Windows/WebView2):
  //  · "default"/"communications" duplican dispositivos reales y cambian de significado cuando se conecta otro micro.
  //  · un deviceId guardado que ya no existe (USB desenchufado, driver nuevo) hacía fallar TODA la captura.
  //  · el medidor de Ajustes y una llamada/nota de voz abrían micrófonos a la vez y Windows los rechazaba.
  const LS_LAST = "chatlan.micLast";
  const ALIAS = /^(default|communications)$/i;
  let stopMeterHook = () => {};
  let liveStreams = 0;
  const lastGood = () => { try { return localStorage.getItem(LS_LAST) || ""; } catch (e) { return ""; } };
  const setLastGood = (id) => { try { if (id) localStorage.setItem(LS_LAST, id); } catch (e) {} };

  async function realInputs() {
    let all = [];
    try { all = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch (e) {}
    const real = all.filter((d) => d.deviceId && !ALIAS.test(d.deviceId));
    return real.length ? real : all.filter((d) => d.deviceId);
  }
  const idOf = (v) => (!v ? "" : typeof v === "string" ? v : Array.isArray(v) ? idOf(v[0]) : v.exact ? idOf(v.exact) : v.ideal ? idOf(v.ideal) : "");

  // Abre el primer micrófono que funcione: preferido -> último que funcionó -> predeterminado del sistema -> cada uno de los reales.
  async function openMic(c, preferId, count) {
    const base = c.audio === true ? {} : Object.assign({}, c.audio);
    delete base.deviceId; delete base.groupId;
    const order = [];
    const add = (id) => { if (!order.includes(id)) order.push(id); };
    if (preferId) add(preferId);
    add(lastGood());
    add("");
    (await realInputs()).forEach((d) => add(d.deviceId));
    let lastErr = null;
    for (const id of order) {
      const a = Object.assign({}, base);
      if (id) a.deviceId = { exact: id };
      try {
        const s = await rawGUM(Object.assign({}, c, { audio: a }));
        const t = s.getAudioTracks()[0];
        if (!t || t.readyState !== "live") { s.getTracks().forEach((x) => x.stop()); continue; }
        const got = (t.getSettings && t.getSettings().deviceId) || id;
        if (got && !ALIAS.test(got)) setLastGood(got);
        if (count !== false) {   // cuenta capturas en uso (llamadas, notas de voz); stop() NO emite "ended", por eso se envuelve
          liveStreams++;
          let counted = true;
          const done = () => { if (counted) { counted = false; liveStreams = Math.max(0, liveStreams - 1); } };
          const origStop = t.stop.bind(t);
          t.stop = () => { done(); origStop(); };
          t.addEventListener("ended", done, { once: true });
        }
        return s;
      } catch (e) {
        lastErr = e;
        if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) break;   // permiso denegado: probar otros no sirve
      }
    }
    throw lastErr || new DOMException("No hay ningún micrófono disponible", "NotFoundError");
  }

  // Las aperturas se hacen de una en una y liberando antes el medidor.
  let gumQueue = Promise.resolve();
  md.getUserMedia = function (constraints) {
    const run = async () => {
      const c = constraints;
      if (!c || !c.audio) return rawGUM(c);
      stopMeterHook();
      const wanted = idOf(c.audio && c.audio.deviceId) || chosenDevice();
      const raw = await openMic(c, wanted);
      if (Math.abs(gain - 1) < 0.01) return raw;   // 100 %: sin procesar
      return processGain(raw);
    };
    const p = gumQueue.then(run, run);
    gumQueue = p.catch(() => {});
    return p;
  };

  // ---------------------------------------------------------------- UI en Ajustes
  const sel = document.getElementById("settingsAudioDevice");
  const view = document.getElementById("view-settings");
  if (!sel || !sel.parentElement || !view) return;

  let tidying = false;
  function tidySelect() {
    if (tidying) return;
    tidying = true;
    try {
      const opts = [...sel.options];
      const current = sel.value;
      const real = opts.filter((o) => o.value && !ALIAS.test(o.value));
      let saved = "";
      try { if (typeof userSettings !== "undefined" && userSettings) saved = userSettings.audio_device || ""; } catch (e) {}
      const keep = real.length ? real : opts;
      sel.innerHTML = "";
      const auto = document.createElement("option");
      auto.value = ""; auto.textContent = "Automático (recomendado)";
      sel.appendChild(auto);
      keep.forEach((o) => sel.appendChild(o));
      const wantId = [current, saved].find((v) => v && keep.some((o) => o.value === v));
      sel.value = wantId || "";            // un dispositivo guardado que ya no existe pasa a Automático
    } finally { tidying = false; }
  }
  new MutationObserver(() => { if (!tidying) tidySelect(); }).observe(sel, { childList: true });
  tidySelect();

  const group = sel.parentElement;          // .settings-group con la etiqueta y el selector
  const row = document.createElement("div");
  row.className = "mic-row";
  group.insertBefore(row, sel);
  row.appendChild(sel);
  const meter = document.createElement("div");
  meter.className = "mic-meter"; meter.title = "Nivel del micrófono";
  meter.innerHTML = '<div class="mic-meter-fill" id="micMeterFill"></div>';
  row.appendChild(meter);
  const fill = meter.firstChild;
  const msg = document.createElement("div");
  msg.className = "mic-meter-msg"; msg.id = "micMeterMsg"; msg.textContent = "Habla para ver el nivel";
  group.appendChild(msg);

  const volGroup = document.createElement("div");
  volGroup.className = "settings-group";
  volGroup.innerHTML =
    '<label class="settings-label">Volumen del micrófono: <span id="micGainVal"></span>%</label>' +
    '<input type="range" id="micGainRange" min="0" max="200" step="5" class="settings-range" />' +
    '<div class="mic-meter-msg">Se aplica a notas de voz y llamadas (a partir de la siguiente).</div>';
  group.parentElement.insertBefore(volGroup, group.nextSibling);
  const range = volGroup.querySelector("#micGainRange"), val = volGroup.querySelector("#micGainVal");
  range.value = Math.round(gain * 100); val.textContent = range.value;
  range.addEventListener("input", () => {
    gain = parseInt(range.value, 10) / 100;
    val.textContent = range.value;
    try { localStorage.setItem(LS_GAIN, String(gain)); } catch (e) {}
    liveNodes.forEach((g) => { try { g.gain.value = gain; } catch (e) {} });
  });

  // ---------------------------------------------------------------- medidor
  let token = 0, mStream = null, mCtx = null, raf = 0, shown = 0;

  function stopMeter() {
    token++;
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (mStream) { mStream.getTracks().forEach((t) => t.stop()); mStream = null; }
    if (mCtx) { try { mCtx.close(); } catch (e) {} mCtx = null; }
    fill.style.clipPath = "inset(100% 0 0 0)"; shown = 0;
  }
  stopMeterHook = stopMeter;
  const viewActive = () => view.classList.contains("active");

  // nivel 0..1 a partir del RMS (escala dB de -60 a 0) incluyendo el volumen elegido
  window.__micLevel = (rms) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms * gain, 1e-5)) + 60) / 60));

  async function startMeter() {
    stopMeter();
    if (!AC || !viewActive() || liveStreams > 0) return;   // con una llamada/nota de voz abierta no se toca el micrófono
    const my = token;
    const dev = sel.value;
    let stream;
    try {
      const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      await gumQueue.catch(() => {});
      if (my !== token || !viewActive() || liveStreams > 0) return;
      stream = await openMic({ audio: base }, dev, false);   // el medidor no cuenta como captura "de uso"
    } catch (e) {
      if (my === token) msg.textContent = "Sin acceso al micrófono (" + ((e && e.name) || e) + ")";
      return;
    }
    if (my !== token || !viewActive()) { stream.getTracks().forEach((t) => t.stop()); return; }
    msg.textContent = "Habla para ver el nivel";
    mStream = stream;
    mCtx = new AC();
    try { await mCtx.resume(); } catch (e) {}
    const an = mCtx.createAnalyser(); an.fftSize = 1024;
    mCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const loop = () => {
      if (my !== token) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const lv = window.__micLevel(Math.sqrt(sum / buf.length));
      shown = Math.max(lv, shown * 0.88);       // subida inmediata, caída suave
      fill.style.clipPath = "inset(" + ((1 - shown) * 100).toFixed(1) + "% 0 0 0)";
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  new MutationObserver(() => { if (viewActive()) startMeter(); else stopMeter(); })
    .observe(view, { attributes: true, attributeFilter: ["class"] });
  sel.addEventListener("change", () => { if (viewActive()) startMeter(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopMeter(); else if (viewActive()) startMeter(); });
  let dcTimer = null;
  if (md.addEventListener) md.addEventListener("devicechange", () => {
    clearTimeout(dcTimer);
    dcTimer = setTimeout(() => { if (viewActive()) startMeter(); }, 700);   // varios eventos seguidos = un solo reinicio
  });
})();
