"use strict";
// OtoHearSay: one page for phone, tablet (inside the Android app), web and desktop.
// On Android the page talks to Kotlin through window.OtoNative; in a browser it uses the browser's own speech features.
const APP_VERSION = "1.5.1";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = t => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------- saved data (kept on this device only) ----------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem("ohs." + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) {
    try { localStorage.setItem("ohs." + key, JSON.stringify(value)); } catch { toast("This device is out of space for saved talks."); return false; }
    if (typeof Sync !== "undefined") Sync.changed(key); // Google Drive sync (sync.js) dates the change and sends it soon
    return true;
  },
};
// this device's own name for itself in synced data (the listening diary counts each device's minutes separately)
const deviceId = store.get("deviceId", "") || (() => { const id = "d" + Math.random().toString(36).slice(2, 10); store.set("deviceId", id); return id; })();
const DEFAULT_SETTINGS = { capSize: 30, lineGap: 1.3, theme: "dark", rate: 1, lang: navigator.language || "en-US", name: "", keywords: [],
  keepDays: 0, pauseMs: 400, pron: [], screenOn: true, words: "", unsure: "normal", engine: "private",
  speedUp: false, skip: { brackets: false, links: true, notes: true }, keepSound: false, notifyCaptions: true, voiceFix: false, boost: null, places: {}, alerts: null, alertClose: true };
const UNSURE = { off: 0, normal: 0.3, more: 0.4 };
const DEFAULT_PHRASES = [
  { name: "Quick", items: ["Please speak slower.", "Can you write that down?", "Please face me when you talk.", "I'm deaf. I read what you say on my phone.", "Yes", "No", "Thank you!", "One moment, please."] },
  { name: "Health", items: ["I have cochlear implants.", "Please write down the next steps.", "Can you repeat the name of the medicine?", "I need an interpreter."] },
  { name: "Out and about", items: ["How much is it?", "Can I pay by card?", "Where is the restroom?", "Can I have a receipt?"] },
  { name: "Feelings", items: ["I'm fine.", "I need a break.", "I don't understand.", "That's great!"] },
];
let settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
let phrases = store.get("phrases", DEFAULT_PHRASES);
let info = store.get("info", { name: "", note: "I'm deaf. Please face me and speak slowly, or type on my phone.", contact: "" });
// newest first: { id, started, title?, fav?, note?, names: { [speakerNumber]: name }, lines: [{ who: "them"|"me"|"marker", text, t, spk? }] }
let sessions = store.get("sessions", []);
let pins = store.get("pins", []); // pinned phrases, shown first on the Talk screen
let current = null;
let phraseCat = 0;
let phraseEdit = false;

const saveSettings = () => { store.set("settings", settings); applySettings(); };
let saveTimer = 0;
function saveSessions() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set("sessions", sessions), 400); }

function applySettings() {
  const root = document.documentElement;
  applyTheme();
  root.style.setProperty("--cap-size", settings.capSize + "px");
  root.style.setProperty("--cap-gap", settings.lineGap);
  if (native && native.setNotifyCaptions) try { native.setNotifyCaptions(settings.notifyCaptions !== false); } catch { }
  if (native && native.setEngine) try { native.setEngine(settings.engine || "private"); } catch { }
  if (native && native.setScreenOn) try { native.setScreenOn(settings.screenOn !== false); } catch { }
  if (native && native.setWordList) try { native.setWordList(engineWords()); native.setUnsureLevel(UNSURE[settings.unsure] ?? 0.3); } catch { }
  if (typeof WebEngine !== "undefined" && WebEngine.worker) WebEngine.worker.postMessage({ type: "words", words: engineWords(), unsure: UNSURE[settings.unsure] ?? 0.3 });
  if (typeof Boost !== "undefined") Boost.push();
  if (typeof SoundAlerts !== "undefined") SoundAlerts.push();
}

// Looks: Dark blue (default), Light, High contrast, three colorful themes, and System colors (Android 12+ takes the
// phone's own wallpaper colors; elsewhere it follows the device's light or dark setting).
const THEMES = [["dark", "Dark blue"], ["light", "Light"], ["sunrise", "Sunrise (warm and bright)"], ["ocean", "Ocean (teal)"],
  ["violet", "Violet night"], ["system", "System colors (match my phone)"], ["contrast", "High contrast (yellow on black)"]];
const THEME_VARS = ["bg", "panel", "panel2", "fg", "muted", "line", "accent", "accent2"];
function applyTheme() {
  const root = document.documentElement;
  THEME_VARS.forEach(v => root.style.removeProperty("--" + v));
  let t = settings.theme || "dark";
  if (t === "system") {
    let sys = null;
    try { sys = native && native.systemColors ? JSON.parse(native.systemColors() || "null") : null; } catch { sys = null; }
    if (sys) { root.setAttribute("data-theme", "dark"); THEME_VARS.forEach(v => sys[v] && root.style.setProperty("--" + v, sys[v])); return; }
    t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  if (t === "dark") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
  applyOwnColors(t);
}
// Your own colors (Settings): a background color (bars, panels and text are worked out from it) and an accent color
// (buttons, highlights and lines), on top of the chosen look. High contrast keeps its own colors so it stays readable.
const WALLS = [["#04191F", "Teal"], ["#0B1830", "Blue"], ["#160F24", "Purple"], ["#0B1F14", "Dark green"], ["#2A0A0E", "Red"], ["#000000", "Black"], ["#F3E2A9", "Gold"], ["#F6EEDC", "Cream"], ["#FFFFFF", "White"]];
const ACCENTS = [["#f2a900", "Gold"], ["#22c3e6", "Teal"], ["#4c8dff", "Blue"], ["#9b6bff", "Purple"], ["#2fd67b", "Green"], ["#ff5a5f", "Red"], ["#ff4f9a", "Pink"], ["#ff8a2a", "Orange"]];
const OWN_VARS = ["accent-fg", "them", "me"];
const Color = {
  rgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; },
  hex(c) { return "#" + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""); },
  mix(a, b, t) { const x = this.rgb(a), y = this.rgb(b); return this.hex(x.map((v, i) => v + (y[i] - v) * t)); },
  lum(h) { const c = this.rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; },
};
function applyOwnColors(t) {
  const root = document.documentElement, set = (k, v) => root.style.setProperty("--" + k, v);
  OWN_VARS.forEach(v => root.style.removeProperty("--" + v));
  root.style.removeProperty("color-scheme");
  if (t === "contrast") return;
  const w = Color.rgb(settings.wall) && settings.wall, a = Color.rgb(settings.accentColor) && settings.accentColor;
  if (w) {
    const light = Color.lum(w) > 0.35, fg = light ? "#14202b" : "#f3f7fa";
    if (light) root.setAttribute("data-theme", "light"); else root.removeAttribute("data-theme");
    set("bg", w); set("fg", fg); set("muted", Color.mix(fg, w, light ? 0.38 : 0.32));
    set("panel", light ? Color.mix(w, "#ffffff", 0.6) : Color.mix(w, "#ffffff", 0.09));
    set("panel2", light ? Color.mix(w, "#000000", 0.07) : Color.mix(w, "#ffffff", 0.16));
    set("line", light ? Color.mix(w, "#000000", 0.2) : Color.mix(w, "#ffffff", 0.26));
    set("them", fg); set("me", light ? "#1f5f8f" : "#ffe26a");
    root.style.setProperty("color-scheme", light ? "light" : "dark");
  }
  if (a) { set("accent", a); set("accent-fg", Color.lum(a) > 0.4 ? "#10202e" : "#ffffff"); }
}
try { matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (settings.theme === "system") applyTheme(); }); } catch { }

// Talks older than the chosen number of days are deleted when the app starts (favorites are kept).
function pruneOldTalks() {
  if (!settings.keepDays) return;
  const cutoff = Date.now() - settings.keepDays * 86400000;
  const before = sessions.length;
  sessions = sessions.filter(x => { const keep = x.fav || x === current || (x.lines.at(-1)?.t || x.started) >= cutoff; if (!keep) TalkSound.remove(x); return keep; });
  if (sessions.length !== before) store.set("sessions", sessions);
}

// Pronunciation fixes: words the voice says wrong are swapped for a spelling it says right (for example "Oto" -> "Oh-toe").
function sayable(text) {
  let out = text;
  // Read aloud "skip" switches: leave out web links, footnote marks and things in brackets.
  const sk = settings.skip || {};
  if (sk.links) out = out.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  if (sk.notes) out = out.replace(/\[\d{1,3}\]|[\u00b9\u00b2\u00b3\u2070-\u2079]+/g, "");
  if (sk.brackets) out = out.replace(/\([^()]*\)|\[[^\[\]]*\]/g, " ");
  for (const r of settings.pron || []) {
    if (!r.from || !r.to) continue;
    out = out.replace(new RegExp("\\b" + r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), r.to);
  }
  return out;
}
const noWordMarks = new Set(); // speech ids whose text was changed by a pronunciation fix (word positions no longer match)

// ---------- events from Android (and from the browser adapters below) ----------
const OtoEvents = {
  handlers: {},
  on(name, fn) { (this.handlers[name] ||= []).push(fn); return () => { const h = this.handlers[name], i = h.indexOf(fn); if (i >= 0) h.splice(i, 1); }; },
  emit(name, payload) { [...(this.handlers[name] || [])].forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); },
};
window.OtoEvents = OtoEvents;
const native = window.OtoNative || null;

// ---------- speaking ----------
let speakSeq = 0;
const Voice = {
  speak(text, id = "s" + (++speakSeq)) {
    if (!text.trim()) return id;
    const spoken = sayable(text);
    if (spoken !== text) { noWordMarks.add(id); text = spoken; }
    if (native) { native.speak(text, settings.rate, id); return id; }
    if (!("speechSynthesis" in window)) { toast("This browser cannot speak text."); OtoEvents.emit("speakDone", id); return id; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = settings.rate; u.lang = settings.lang;
    u.onboundary = e => {
      if (e.name && e.name !== "word") return;
      const len = e.charLength || (text.slice(e.charIndex).match(/^\S+/) || [""])[0].length;
      OtoEvents.emit("word", { id, start: e.charIndex, end: e.charIndex + len });
    };
    u.onend = u.onerror = () => { if (this.speaking === id) { this.speaking = null; this.holdUntil = Date.now() + 400; } OtoEvents.emit("speakDone", id); };
    speechSynthesis.cancel();
    this.speaking = id; // captions pause while the device speaks (same as the Android app's CaptionEngine.speakingId)
    speechSynthesis.speak(u);
    return id;
  },
  stop() { this.speaking = null; if (native) native.stopSpeaking(); else if ("speechSynthesis" in window) speechSynthesis.cancel(); },
  // While the reply is spoken (and 0.4 s after), the private engine gets no sound: the device's own voice is not
  // captioned and does not compete with the engine for the processor (26 Nov phone test: choppy reply while listening).
  speaking: null, holdUntil: 0,
  holding() { return !!this.speaking || Date.now() < this.holdUntil; },
};

// ---------- listening: a private on-device engine (sherpa-onnx) on Android and in browsers; the browser's own
// recognizer only if the built-in engine cannot run here ----------
const WebEngine = {
  // the same speech engine as the phone, compiled to WebAssembly, running in a background worker
  supported() { return typeof WebAssembly === "object" && typeof Worker === "function" && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !!(window.AudioContext || window.webkitAudioContext); },
  worker: null, ready: false, broken: false, ctx: null, mic: null, node: null,
  getWorker() {
    if (this.worker) return this.worker;
    const w = new Worker("engine/caption-worker.js");
    w.onmessage = e => {
      const m = e.data;
      if (m.type === "progress") OtoEvents.emit("engineProgress", m.pct);
      else if (m.type === "ready") { this.ready = true; OtoEvents.emit("engineProgress", null); }
      else if (m.type === "partial") OtoEvents.emit("partial", m.text);
      else if (m.type === "final") OtoEvents.emit("final", { text: m.text, unsure: m.unsure || [] });
      else if (m.type === "error") this.fail(m.code);
      else if (m.type === "fileSegment") OtoEvents.emit("fileSegment", m);
      else if (m.type === "fileProgress") OtoEvents.emit("fileProgress", m.pct);
      else if (m.type === "fileDone") OtoEvents.emit("fileDone", null);
      else if (m.type === "fileError") OtoEvents.emit("fileError", m.code);
    };
    w.onerror = e => { e.preventDefault(); this.fail("engine-load"); };
    w.postMessage({ type: "words", words: engineWords(), unsure: UNSURE[settings.unsure] ?? 0.3 });
    return this.worker = w;
  },
  fail(code) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.ready = false; OtoEvents.emit("engineProgress", null);
    if (code !== "download-failed") this.broken = true; // a missing or failing engine: use the browser's recognizer from now on
    const wasOn = Listener.on && Listener.mode === "engine";
    this.stopAudio();
    if (wasOn) Listener.fallback(code);
  },
  async start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const want = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    const dev = Boost.cfg().mic; // More > Sound boost > Microphone
    try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: dev && dev.length > 10 ? { ...want, deviceId: { exact: dev } } : want }); }
    catch (e) { if (!(dev && dev.length > 10)) throw e; this.mic = await navigator.mediaDevices.getUserMedia({ audio: want }); } // that microphone is gone: use any
    const w = this.getWorker();
    if (!this.ready) w.postMessage({ type: "load" });
    this.ctx = new AC();
    const src = this.ctx.createMediaStreamSource(this.mic);
    const send = samples => {
      Listener.level(samples);
      if (this.ready && this.worker && !Voice.holding()) this.worker.postMessage({ type: "audio", samples, rate: this.ctx.sampleRate }, [samples.buffer]);
    };
    // ScriptProcessor is old but works in every browser and needs no extra file; 4096 samples is about a tenth of a second
    const node = this.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = e => send(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node); node.connect(this.ctx.destination);
    this.node = node;
    WebBoost.attach(this.ctx, src);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  },
  stopAudio() {
    WebBoost.detach();
    if (this.node) { this.node.onaudioprocess = null; try { this.node.disconnect(); } catch { } this.node = null; }
    if (this.mic) { this.mic.getTracks().forEach(t => t.stop()); this.mic = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  },
  stop() { this.stopAudio(); if (this.worker && this.ready) this.worker.postMessage({ type: "stop" }); },
};

const Listener = {
  on: false, rec: null, mode: "",
  browserSR() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; },
  // Settings > Speech engine: "online" uses the browser's own recognizer (Chrome and Edge send the sound to Google or
  // Microsoft); otherwise the private engine runs on this device.
  useEngine() {
    // the private engine knows English only; other languages use the browser's own recognizer
    const english = /^en/i.test(settings.lang || "en");
    return WebEngine.supported() && !WebEngine.broken && !(this.browserSR() && (settings.engine === "online" || !english));
  },
  available() { return !!native || this.useEngine() || !!this.browserSR(); },
  name() {
    if (native) return native.engineName ? native.engineName() : "Phone's speech engine";
    return this.useEngine() ? "Private engine (on this device)" : "Browser speech (online)";
  },
  async start() {
    TalkSound.begin();
    if (native) { native.startListening(settings.lang); return; }
    quiet.reset();
    if (this.useEngine()) {
      this.mode = "engine"; this.on = true;
      try { await WebEngine.start(); TalkSound.webStart(WebEngine.mic); OtoEvents.emit("listenState", true); OtoEvents.emit("engine", this.name()); }
      catch (e) {
        WebEngine.stopAudio(); this.on = false;
        const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
        OtoEvents.emit("listenError", denied ? "mic-denied" : e && e.name === "NotReadableError" ? "mic-busy" : "recognizer-failed");
      }
      return;
    }
    this.startBrowser();
  },
  fallback(code) {
    // the built-in engine could not run here; carry on with the browser's recognizer when there is one
    this.on = false; this.mode = "";
    if (code === "download-failed") { OtoEvents.emit("listenError", "download-failed"); return; }
    if (this.browserSR()) { toast("The built-in speech engine could not start here, so the browser's speech recognition is used instead."); this.startBrowser(); }
    else OtoEvents.emit("listenError", "engine-failed");
    OtoEvents.emit("engine", this.name());
  },
  startBrowser() {
    const SR = this.browserSR();
    if (!SR) { OtoEvents.emit("listenError", "no-recognizer"); return; }
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = settings.lang;
    rec.onresult = e => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) OtoEvents.emit("final", r[0].transcript.trim()); else partial += r[0].transcript;
      }
      OtoEvents.emit("partial", partial);
    };
    rec.onerror = e => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { this.on = false; OtoEvents.emit("listenError", "mic-denied"); } };
    rec.onend = () => { if (this.on) { try { rec.start(); } catch { /* restarts on the next end */ } } else OtoEvents.emit("listenState", false); };
    this.rec = rec; this.on = true; this.mode = "browser";
    try { rec.start(); OtoEvents.emit("listenState", true); } catch { OtoEvents.emit("listenError", "recognizer-failed"); }
  },
  stop() {
    TalkSound.end();
    stoppedAt = Date.now(); hideToast("micQuiet"); // the phone stops a moment later; its silence is not a quiet mic
    if (native) { native.stopListening(); return; }
    this.on = false;
    if (this.mode === "engine") WebEngine.stop();
    if (this.rec) { try { this.rec.stop(); } catch { } this.rec = null; }
    this.mode = "";
    OtoEvents.emit("listenState", false);
  },
  level(samples) { quiet.add(samples); },
};

// "microphone too quiet": if the sound stays very faint for 8 seconds while listening, say so once
const quiet = {
  t: 0, warned: false,
  reset() { this.t = 0; this.warned = false; },
  add(samples) {
    let sum = 0; for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / (samples.length / 4));
    const now = Date.now(); if (now - (this.lastLvl || 0) > 180) { this.lastLvl = now; OtoEvents.emit("level", Math.min(1, rms * 12)); }
    this.t = rms < 0.003 ? this.t + samples.length / ((WebEngine.ctx && WebEngine.ctx.sampleRate) || 48000) : 0;
    if (this.t > 8 && !this.warned) { this.warned = true; OtoEvents.emit("micQuiet"); }
  },
};

let listening = false;
// Sound meter and timer on the big listen button: the ring grows with the sound the microphone hears, so silence is
// never mistaken for a broken app.
const Meter = {
  since: 0, tick: 0, lvl: 0,
  state(on) {
    clearInterval(this.tick);
    if (on) { if (!this.since) this.since = Date.now(); this.tick = setInterval(() => this.draw(), 500); }
    else { this.since = 0; this.set(0); }
    this.draw();
  },
  set(v) { this.lvl = v; const b = $("#listen"); if (b) b.style.setProperty("--lvl", Math.max(0, Math.min(1, v)).toFixed(2)); },
  draw() {
    const t = $("#timer"); if (!t) return;
    if (!this.since) { t.textContent = "Ready"; return; }
    const sec = Math.floor((Date.now() - this.since) / 1000);
    t.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  },
};
OtoEvents.on("level", v => Meter.set(+v || 0));
// During a phone call Android gives the microphone to the call only, so captions go quiet: say why, once per call.
let callWarned = false;
setInterval(() => {
  if (!native || !native.callActive) return;
  let on = false; try { on = native.callActive(); } catch { }
  if (on && !callWarned) { callWarned = true; showCallNote(); } else if (!on) callWarned = false;
}, 3000);
function showCallNote() {
  if ($("#callNote")) return;
  const d = document.createElement("div");
  d.id = "callNote"; d.className = "box callnote";
  d.innerHTML = `<b>You are on a phone call.</b> No app can hear phone calls, so OtoHearSay cannot caption it. Use your phone's <b>Live Caption</b>: press a volume button and tap the caption icon. <button class="btn" id="cnHow">How</button> <button class="btn" id="cnOk">OK</button>`;
  document.body.appendChild(d);
  $("#cnOk").onclick = () => d.remove();
  $("#cnHow").onclick = () => { d.remove(); location.hash = "more/calls"; };
}
// The home-screen widget, quick-settings button and app shortcut (and ?listen=1 on the web) open Talk and listen.
OtoEvents.on("autoListen", () => {
  if ((location.hash.slice(1) || "talk").split("/")[0] !== "talk") location.hash = "talk";
  setTimeout(() => { if (!listening && Listener.available()) Listener.start(); }, 300);
});
OtoEvents.on("listenState", on => {
  listening = !!on; updateListenButton();
  if (!on) { setPartial(""); stoppedAt = Date.now(); hideToast("micQuiet"); }
});
OtoEvents.on("listenError", code => {
  listening = false; updateListenButton();
  toast({
    "mic-denied": "OtoHearSay needs the microphone to show captions. Allow it in your settings, then try again.",
    "no-recognizer": "This browser cannot run the speech engine. A recent Chrome, Edge, Firefox or Safari can.",
    "recognizer-failed": "The speech engine stopped. Tap Listen to start again.",
    "engine-failed": "The speech engine stopped. Tap Listen to start again.",
    "mic-busy": "Another app is using the microphone. Close it, then tap Listen again.",
    "download-failed": "Could not download the speech engine. Check the internet connection, then tap Listen again. After the first download it works offline.",
  }[code] || "Listening stopped.");
});
OtoEvents.on("partial", text => { if (text) TalkSound.heard(); setPartial(text); });
// Shown only while listening on the Talk tab (26 Nov phone test: it popped up right after Stop and stayed over Saved
// talks). The silence after Stop never counts, and the warning goes away on Stop and when the tab changes.
let stoppedAt = 0;
OtoEvents.on("micQuiet", () => {
  if (!listening || Date.now() - stoppedAt < 3000) return;
  if ((location.hash.slice(1) || "talk").split("/")[0] !== "talk") return;
  toast("The microphone hears almost nothing. Move the phone closer to the person talking, or check that nothing covers the microphone.", "micQuiet");
});
window.addEventListener("hashchange", () => hideToast("micQuiet"));
OtoEvents.on("engineProgress", pct => {
  const e = $("#engine"); if (!e) return;
  e.textContent = pct == null ? Listener.name() : `Getting the private speech engine ready (one time, 79 MB): ${pct}%`;
});
OtoEvents.on("engine", name => { const e = $("#engine"); if (e) e.textContent = name; });
OtoEvents.on("final", m => {
  setPartial("");
  const text = typeof m === "string" ? m : m && m.text, unsure = typeof m === "object" && m ? m.unsure : null;
  if (!text) return;
  const a = (m && m.a) || TalkSound.range();
  if (settings.voiceFix && voiceFix(text)) return;
  if (redo && redo.s === current && current.lines[redo.i]) { replaceLine(redo.s, redo.i, text, unsure); redo = null; return; }
  addLine("them", text, unsure);
  if (a && current) { const l = current.lines.at(-1); l.a = [+a[0], +a[1]]; if (TalkSound.key) l.ak = TalkSound.key; saveSessions(); }
});
// The engine tells the page when it falls behind, skips ahead, or reconnects the microphone, so a stall is never silent.
OtoEvents.on("engineStatus", st => {
  if (/^boost-/.test(st || "")) return; // sound boost has its own messages
  const e = $("#engine");
  const msg = { behind: "Catching up...", "mic-retry": "Reconnecting the microphone...", live: null, restarted: null, skipped: null }[st];
  if (st === "skipped") toast("The phone was busy, so a few seconds were skipped to keep captions live.");
  if (e) { e.textContent = msg || Listener.name(); e.classList.toggle("warn", !!msg); }
});

// ---------- talk sessions ----------
function ensureSession() {
  if (!current) {
    current = { id: Date.now().toString(36), started: Date.now(), lines: [], names: {} };
    sessions.unshift(current);
  }
  return current;
}
function sessionTitle(s) {
  if (s.title) return s.title;
  const first = s.lines.find(l => l.who !== "marker");
  return first ? first.text.slice(0, 60) : "Empty talk";
}
const speakerName = (s, n) => (s && s.names && s.names[n]) || "Speaker " + n;
function alertWords() {
  return [settings.name, ...settings.keywords].map(w => (w || "").trim()).filter(Boolean);
}
// The speech engines get the personal word list plus the alert name and alert words as "hot words", so a name the
// engine does not know (Otobong was written "O tobon" in the 26 Nov phone test) is heard right more often.
function engineWords() {
  const listed = (settings.words || "").split(/[,\n]/).map(w => w.trim()).filter(Boolean);
  const seen = new Set(listed.map(w => w.toLowerCase()));
  for (const w of alertWords()) if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); listed.push(w); }
  return listed.join("\n");
}
const plainWord = w => (w || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
// How many letters may differ for a word to still count as the alert word: none for short words (so "Ann" never fires
// on "and"), one for 5 to 7 letters, two for longer ones.
function closeEnough(a, b) {
  const max = b.length < 5 ? 0 : b.length < 8 ? 1 : 2;
  if (Math.abs(a.length - b.length) > max) return false;
  if (!max) return a === b;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}
// Which words of a caption match an alert word, as word positions (counting the non-space pieces). A word the engine
// split in two ("O tobon") is joined back, and with "Close spellings count" on (the default) a small spelling
// difference still counts ("Catherine" for Katherine). Returns an empty set when nothing matches.
function alertHits(text, words = alertWords()) {
  const hits = new Set();
  if (!words.length || !text) return hits;
  const plain = text.split(/\s+/).filter(Boolean).map(p => plainWord(p.replace(/'s\W*$/i, "")));
  const fuzzy = settings.alertClose !== false;
  for (const w of words) {
    const target = plainWord(w);
    if (!target) continue;
    const span = w.trim().split(/\s+/).length; // an alert of two words may be heard as two to four pieces
    for (let i = 0; i < plain.length; i++) {
      if (!plain[i]) continue;
      let joined = "";
      for (let k = 0; k < span + 2 && i + k < plain.length; k++) {
        joined += plain[i + k];
        if (k + 1 < span) continue;
        if (joined === target || (fuzzy && closeEnough(joined, target))) { for (let x = 0; x <= k; x++) hits.add(i + x); break; }
        if (!fuzzy || joined.length > target.length + 2) break;
      }
    }
  }
  return hits;
}
function addLine(who, text, unsure) {
  const s = ensureSession();
  const line = { who, text, t: Date.now() };
  if (unsure && unsure.length) line.unsure = unsure;
  if (who === "marker") {
    line.spk = s.lines.filter(l => l.who === "marker").length + 2;
    if (native && native.shareEvent) try { native.shareEvent("marker", JSON.stringify(speakerName(s, line.spk))); } catch { }
  }
  s.lines.push(line);
  saveSessions();
  if (who === "them") {
    if (alertHits(text).size) alertUser();
  }
  const caps = $("#caps");
  if (caps) { $(".empty", caps)?.remove(); $("#resume")?.remove(); caps.insertBefore(lineEl(line, s), $("#partial")); scrollCaps(); }
}
function lineEl(line, s) {
  const p = document.createElement("p");
  p.className = "line " + line.who + (line.edited ? " edited" : "");
  if (s) p.dataset.i = s.lines.indexOf(line);
  if (line.who === "bookmark") { p.textContent = "🔖 Bookmark · " + new Date(line.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (line.text ? " · " + line.text : ""); return p; }
  if (line.who === "marker") {
    // Speakers are named in words, never by color alone. Tap the label to rename the speaker.
    p.innerHTML = `<button class="spk" data-spk="${line.spk || 2}" title="Tap to name this speaker">${esc(speakerName(s, line.spk || 2))}</button>`;
    return p;
  }
  const hits = line.who === "them" ? alertHits(line.text) : new Set();
  // words the engine was unsure of get a dotted underline, so a wrong guess is not taken at face value
  const unsure = new Set(line.unsure || []);
  let i = -1;
  p.innerHTML = line.text.split(/(\s+)/).map(part => {
    if (!part.trim()) return part;
    i++;
    let h = esc(part);
    if (hits.has(i)) h = `<mark>${h}</mark>`;
    return unsure.has(i) ? `<span class="unsure" title="The app is not sure of this word">${h}</span>` : h;
  }).join("");
  return p;
}
// Tapping a speaker label turns it into a box to type a name; the name applies to that speaker everywhere in the talk.
function wireSpeakerRename(container, getSession, redraw) {
  container.addEventListener("click", e => {
    const b = e.target.closest("button.spk");
    const s = getSession();
    if (!b || !s) return;
    const n = +b.dataset.spk;
    const input = document.createElement("input");
    input.type = "text"; input.value = s.names?.[n] || ""; input.placeholder = "Name for speaker " + n; input.className = "spk-input";
    b.replaceWith(input); input.focus();
    const done = () => { s.names = s.names || {}; const v = input.value.trim(); if (v) s.names[n] = v; else delete s.names[n]; store.set("sessions", sessions); redraw(); };
    input.onblur = done;
    input.onkeydown = ev => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { input.value = s.names?.[n] || ""; input.blur(); } };
  });
}
// ---------- keeping the sound of a talk, and playing it back ----------
// Optional (Settings > Keep the sound of talks). On Android the engine writes the sound to a file per talk and reports
// where each sentence sits; in a browser the microphone is recorded (MediaRecorder) into the browser's storage and the
// sentence times are measured on the page. Nothing leaves the device.
const SoundDB = {
  db: null,
  open() { return this.db || (this.db = new Promise((res, rej) => { const r = indexedDB.open("ohs-sound", 1); r.onupgradeneeded = () => r.result.createObjectStore("clips"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
  async put(k, v) { const d = await this.open(); return new Promise(res => { const t = d.transaction("clips", "readwrite"); t.objectStore("clips").put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); }); },
  async get(k) { const d = await this.open(); return new Promise(res => { const r = d.transaction("clips").objectStore("clips").get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); },
  async del(k) { const d = await this.open(); d.transaction("clips", "readwrite").objectStore("clips").delete(k); },
};
const TalkSound = {
  key: "", rec: null, parts: [], t0: 0, segStart: null,
  begin() {
    this.key = ""; this.segStart = null;
    if (!settings.keepSound) { if (native && native.setRecording) try { native.setRecording(""); } catch { } return; }
    const s = ensureSession();
    if (native && native.setRecording) try { native.setRecording(s.id); } catch { }
  },
  webStart(stream) {
    if (native || !settings.keepSound || !stream || typeof MediaRecorder !== "function") return;
    try {
      this.rec = new MediaRecorder(stream); this.parts = []; this.t0 = performance.now(); this.segStart = null;
      this.key = ensureSession().id + ":" + Date.now();
      this.rec.ondataavailable = e => { if (e.data && e.data.size) this.parts.push(e.data); };
      const key = this.key, parts = this.parts;
      this.rec.onstop = () => { if (parts.length) SoundDB.put(key, new Blob(parts, { type: this.rec?.mimeType || "audio/webm" })).catch(() => {}); };
      this.rec.start(5000);
    } catch { this.rec = null; this.key = ""; }
  },
  end() {
    if (native && native.setRecording) try { native.setRecording(""); } catch { }
    if (this.rec) { try { this.rec.stop(); } catch { } this.rec = null; }
  },
  heard() { if (this.rec && this.segStart == null) this.segStart = Math.max(0, (performance.now() - this.t0) / 1000 - 0.8); },
  range() {
    if (!this.rec) return null;
    const end = (performance.now() - this.t0) / 1000, start = this.segStart ?? Math.max(0, end - 4);
    this.segStart = null;
    return [start, end];
  },
  remove(s) {
    if (native && native.deleteTalkAudio) try { native.deleteTalkAudio(s.id); } catch { }
    if (!native) [...new Set(s.lines.map(l => l.ak).filter(Boolean))].forEach(k => SoundDB.del(k).catch(() => {}));
  },
  has(s) { return s.lines.some(l => l.a); },
  async src(s, key) {
    if (native && native.talkAudio) return native.talkAudio(s.id) || "";
    const b = key && await SoundDB.get(key).catch(() => null);
    return b ? URL.createObjectURL(b) : "";
  },
};
// The player in a saved talk: plays the kept sound and lights up the line, and the word, being heard.
function wirePlayer(s, caps) {
  const bar = $("#player"); if (!bar) return;
  const audio = new Audio(); let key = null, timer = 0;
  const lines = () => s.lines.map((l, i) => ({ l, i })).filter(x => x.l.a);
  const show = t => {
    caps.querySelectorAll(".line.playing").forEach(el => { el.classList.remove("playing"); const i = +el.dataset.i; el.replaceWith(lineEl(s.lines[i], s)); });
    const hit = lines().find(x => (native || x.l.ak === key) && t >= x.l.a[0] && t <= x.l.a[1] + 0.3);
    if (!hit) return;
    const el = caps.querySelector(`[data-i="${hit.i}"]`); if (!el) return;
    const words = hit.l.text.split(/\s+/), k = Math.min(words.length - 1, Math.floor((t - hit.l.a[0]) / Math.max(0.3, hit.l.a[1] - hit.l.a[0]) * words.length));
    el.classList.add("playing");
    el.innerHTML = words.map((w, j) => j === k ? `<span class="pw">${esc(w)}</span>` : esc(w)).join(" ");
    el.scrollIntoView({ block: "nearest" });
  };
  const playAt = async (l) => {
    const want = native ? "all" : l.ak;
    if (want !== key || !audio.src) { const src = await TalkSound.src(s, l.ak); if (!src) { toast("The sound of this talk was not kept."); return; } key = want; audio.src = src; }
    audio.currentTime = l.a[0]; audio.play().catch(() => toast("Could not play the sound."));
  };
  $("#playBtn").onclick = () => { if (!audio.paused) { audio.pause(); return; } const first = lines()[0]; if (first) (audio.src && audio.currentTime > 0 ? audio.play() : playAt(first.l)); };
  audio.onplay = () => { $("#playBtn").textContent = "⏸ Pause"; clearInterval(timer); timer = setInterval(() => { show(audio.currentTime); $("#playT").textContent = fmtSec(audio.currentTime); }, 200); };
  audio.onpause = audio.onended = () => { $("#playBtn").textContent = "▶ Play"; clearInterval(timer); };
  audio.onended = () => {
    $("#playBtn").textContent = "▶ Play"; clearInterval(timer);
    if (!native) { const next = lines().find(x => x.l.ak && x.l.ak > key); if (next) playAt(next.l); }
  };
  s._playLine = i => { const l = s.lines[i]; if (l && l.a) playAt(l); };
  // "Louder": the same sound through the Sound boost loudness, tone, each-ear levels and limiter
  let lctx = null, lsrc = null, loud = false;
  if ($("#playLoud")) $("#playLoud").onclick = () => {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) { toast("This device cannot make the sound louder."); return; }
    loud = !loud;
    try {
      if (!lctx) { lctx = new AC(); lsrc = lctx.createMediaElementSource(audio); }
      if (lctx.state === "suspended") lctx.resume();
      lsrc.disconnect(); lsrc.connect(loud ? boostOut(lctx) : lctx.destination);
    } catch { loud = false; toast("This device cannot make the sound louder."); }
    $("#playLoud").setAttribute("aria-pressed", loud ? "true" : "false");
    if (loud) toast("Louder and clearer. Change how it sounds in More > Sound boost.");
  };
  window.addEventListener("hashchange", () => { if (lctx) lctx.close().catch(() => { }); }, { once: true });
  window.addEventListener("hashchange", () => { audio.pause(); clearInterval(timer); }, { once: true });
}
const fmtSec = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// "replace X with Y" (Settings > Fix by voice): fixes the last caption line instead of adding a new one.
function voiceFix(text) {
  const m = text.match(/^\s*(?:replace|change)\s+(.+?)\s+(?:with|to)\s+(.+?)[.!?]*\s*$/i);
  const s = current; if (!m || !s) return false;
  for (let i = s.lines.length - 1; i >= 0; i--) {
    const l = s.lines[i]; if (l.who !== "them" && l.who !== "me") continue;
    const re = new RegExp("\\b" + m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (!re.test(l.text)) { toast(`"${m[1]}" is not in the last line.`); return true; }
    replaceLine(s, i, l.text.replace(re, m[2]), null, true); toast(`Fixed: ${m[1]} → ${m[2]}`);
    return true;
  }
  return false;
}

// Key points of a talk, worked out on the device (no AI service): the sentences that carry the most of the talk's
// frequent words, in their original order, and the names and words that came up most.
const STOP = new Set("a an the and or but so if then to of in on at by for with from up down out over is are was were be been being am do does did have has had i you he she it we they me him her us them my your his its our their this that these those there here what which who whom when where why how all any both each few more most other some such no nor not only own same than too very can will just don should now yeah okay ok um uh like oh well get got go going know think really right one two also would could about into".split(" "));
function keyPoints(s, n = 5) {
  const lines = s.lines.filter(l => l.who === "them" || l.who === "me").map(l => l.text.trim()).filter(Boolean);
  const words = t => (t.toLowerCase().match(/[a-z']+/g) || []).filter(w => w.length > 2 && !STOP.has(w));
  const freq = {}; lines.forEach(t => words(t).forEach(w => freq[w] = (freq[w] || 0) + 1));
  const scored = lines.map((t, i) => { const ws = words(t); return { t, i, sc: ws.length ? ws.reduce((a, w) => a + freq[w], 0) / Math.sqrt(ws.length) : 0 }; });
  const pick = scored.filter(x => x.t.split(/\s+/).length >= 4).sort((a, b) => b.sc - a.sc).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.t);
  const top = Object.entries(freq).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  return { points: pick, topics: top };
}

// ---------- fixing a caption line ----------
// Tap any caption line (live or in a saved talk) to correct it by typing, delete it, or (while live) say it again:
// the next sentence heard replaces that line instead of being added. Words added in a fix can go to the word list,
// so the engine gets them right next time.
let redo = null; // { s, i } while waiting for the replacement sentence
function replaceLine(s, i, text, unsure, learn) {
  const l = s.lines[i];
  const before = l.text;
  l.text = text; l.edited = true;
  if (unsure && unsure.length) l.unsure = unsure; else delete l.unsure;
  store.set("sessions", sessions);
  const old = document.querySelector(`.captions [data-i="${i}"]`);
  if (old) { const el = lineEl(l, s); old.replaceWith(el); if (learn) offerWords(before, text, el); }
}
// New words a fix brought in (names and longer words), offered for the word list.
function newWordsFrom(before, after) {
  const clean = w => w.replace(/^[^\w']+|[^\w']+$/g, "");
  const had = new Set(before.split(/\s+/).map(w => clean(w).toLowerCase()));
  const listed = new Set((settings.words || "").split(/[,\n]/).map(w => w.trim().toLowerCase()).filter(Boolean));
  const out = [];
  for (const raw of after.split(/\s+/)) {
    const w = clean(raw), k = w.toLowerCase();
    if (w.length < 3 || had.has(k) || listed.has(k) || out.some(o => o.toLowerCase() === k)) continue;
    if (/^[A-Z]/.test(w) && !/^(I|I'm|I'll|I've|I'd)$/.test(w) || w.length >= 7) out.push(w);
  }
  return out.slice(0, 3);
}
function offerWords(before, after, afterEl) {
  const words = newWordsFrom(before, after);
  if (!words.length || !afterEl) return;
  const box = document.createElement("div");
  box.className = "learn small";
  box.innerHTML = `Add <b>${words.map(esc).join(", ")}</b> to your word list, so captions get ${words.length > 1 ? "them" : "it"} right next time?
    <button class="btn" data-a="add">Add</button> <button class="btn" data-a="no">No</button>`;
  box.onclick = e => {
    const a = e.target.closest("button")?.dataset.a; if (!a) return;
    if (a === "add") {
      settings.words = [(settings.words || "").trim(), ...words].filter(Boolean).join("\n");
      saveSettings(); applySettings(); toast("Added to your word list (More > Settings).");
    }
    box.remove();
  };
  afterEl.after(box);
}
function wireLineEdit(container, getSession, live) {
  container.addEventListener("click", e => {
    if (e.target.closest("button, textarea, input, .lineedit, .learn")) return;
    const p = e.target.closest(".line.them, .line.me");
    const s = getSession();
    if (!p || !s || p.dataset.i == null) return;
    const i = +p.dataset.i, l = s.lines[i];
    if (!l) return;
    container.querySelector(".lineedit")?.cancel?.();
    const box = document.createElement("div");
    box.className = "lineedit box";
    box.innerHTML = `<textarea rows="2" aria-label="Fix this line">${esc(l.text)}</textarea>
      <div class="row"><button class="btn primary" data-a="save">Save</button>
      ${live ? `<button class="btn" data-a="again" title="The next sentence heard replaces this line">🎤 Say it again</button>` : ""}
      ${!live && l.a ? `<button class="btn" data-a="play">▶ Play this line</button>` : ""}
      <button class="btn" data-a="cancel">Cancel</button><button class="btn danger" data-a="del">Delete line</button></div>`;
    p.replaceWith(box);
    const ta = box.querySelector("textarea");
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    box.cancel = () => { if (box.isConnected) box.replaceWith(lineEl(l, s)); };
    box.onclick = ev => {
      const a = ev.target.closest("button")?.dataset.a; if (!a) return;
      if (a === "cancel") box.cancel();
      else if (a === "play") { box.cancel(); s._playLine && s._playLine(i); }
      else if (a === "save") {
        const v = ta.value.trim();
        if (!v || v === l.text) { box.cancel(); return; }
        box.replaceWith(lineEl(l, s)); replaceLine(s, i, v, null, true);
      } else if (a === "del") {
        s.lines.splice(i, 1); store.set("sessions", sessions);
        if (redo && redo.s === s) redo = null;
        // indexes after this line moved up by one; redraw so taps find the right line
        box.remove(); container.querySelectorAll("[data-i]").forEach(el => { if (+el.dataset.i > i) el.dataset.i = +el.dataset.i - 1; });
      } else if (a === "again") {
        redo = { s, i };
        const el = lineEl(l, s); el.classList.add("redo"); box.replaceWith(el);
        toast("Say it again now. The next sentence replaces this line.");
        if (!listening) Listener.start();
      }
    };
    ta.onkeydown = ev => { if (ev.key === "Escape") box.cancel(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); box.querySelector('[data-a="save"]').click(); } };
  });
}
function setPartial(text) {
  const el = $("#partial");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  if (text) scrollCaps();
}
// Captions follow the newest words only while you are at the bottom; scroll up to re-read and they stay put,
// with a "Newest" button to jump back.
let capsPinned = true;
function scrollCaps(force) {
  const c = $("#caps"); if (!c) return;
  if (force || capsPinned) c.scrollTop = c.scrollHeight;
  const b = $("#newest"); if (b) b.hidden = capsPinned;
}
function alertUser() {
  if (native) native.vibrate(500); else navigator.vibrate?.(500);
  const f = $("#flash");
  f.classList.add("on"); setTimeout(() => f.classList.remove("on"), 250);
  setTimeout(() => { f.classList.add("on"); setTimeout(() => f.classList.remove("on"), 250); }, 400);
}
function sayAloud(text) {
  text = text.trim();
  if (!text) return;
  addLine("me", text);
  Voice.speak(text);
}

// ---------- small helpers ----------
let toastTimer = 0;
// kind names a message that belongs to one moment (the low-microphone warning belongs to listening), so it can be
// taken away when that moment ends: hideToast("micQuiet") on Stop and on a tab change.
function hideToast(kind) {
  const t = $("#toast");
  if (t && !t.hidden && (!kind || t.dataset.kind === kind)) { t.hidden = true; clearTimeout(toastTimer); }
}
function toast(msg, kind = "") {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t);
    Object.assign(t.style, { position: "fixed", left: "50%", bottom: "92px", transform: "translateX(-50%)", maxWidth: "min(92vw, 520px)", background: "var(--panel2)", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "12px", padding: "12px 16px", zIndex: 70, boxShadow: "0 6px 24px rgba(0,0,0,.35)" }); }
  t.textContent = msg; t.hidden = false; t.dataset.kind = kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function showCard(text) {
  $("#cardText").textContent = text;
  $("#cardText").classList.remove("flipped");
  $("#card").hidden = false;
}
function exportText(title, text) {
  if (native) { native.shareText(title, text); return; }
  exportFile(title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) + ".txt", text, "text/plain");
}
const clock = t => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function sessionText(s, withTimes) {
  const marks = s.lines.filter(l => l.who === "bookmark");
  return "OtoHearSay talk: " + sessionTitle(s) + "\n" + fmtDate(s.started) + "\n"
    + (marks.length ? "\nBookmarks: " + marks.map(l => clock(l.t)).join(", ") + "\n" : "")
    + "\n" + s.lines.map(l => {
      if (l.who === "marker") return "--- " + speakerName(s, l.spk || 2) + " ---";
      if (l.who === "bookmark") return "*** Bookmark " + clock(l.t) + " ***";
      return (withTimes ? "[" + (l.at != null ? srtTime(l.at).slice(0, 8) : clock(l.t)) + "] " : "") + (l.who === "me" ? "Me: " : "") + l.text;
    }).join("\n")
    + (s.note ? "\n\nNotes:\n" + s.note : "");
}
// Subtitles (SRT) for a captioned recording: numbered cues with start --> end times.
const srtTime = sec => { const ms = Math.round(sec * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60; return [h, m, x].map(v => String(v).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0"); };
function sessionSrt(s) {
  return s.lines.filter(l => l.at != null).map((l, i) => `${i + 1}\n${srtTime(l.at)} --> ${srtTime(Math.max(l.end || l.at + 2, l.at + 0.5))}\n${l.text}\n`).join("\n");
}

// ---------- screens ----------
const TITLES = { talk: "Talk", phrases: "Phrases", read: "Read aloud", history: "Saved talks", more: "More" };
const view = () => $("#view");

function route() {
  const [tab, sub] = (location.hash.slice(1) || "talk").split("/");
  const name = TITLES[tab] ? tab : "talk";
  if (!(tab === "more" && sub === "practice") && typeof Practice !== "undefined") Practice.stopNoise();
  document.querySelectorAll(".tabs button").forEach(b => { if (b.dataset.go !== name) b.removeAttribute("aria-current"); else b.setAttribute("aria-current", "page"); });
  view().className = name === "talk" ? "talk" : "";
  document.body.dataset.sec = name;
  $("#title").textContent = TITLES[name];
  $("#engine").hidden = name !== "talk";
  ({ talk: renderTalk, phrases: renderPhrases, read: renderRead, history: renderHistory, more: renderMore })[name](sub);
}
window.addEventListener("hashchange", route);
document.querySelector(".tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-go]");
  if (b) location.hash = b.dataset.go;
});

function renderTalk() {
  $("#engine").textContent = Listener.name();
  const s = current;
  const quick = [...new Set([...pins, ...(phrases[0]?.items || [])])].slice(0, 10);
  const last = sessions[0];
  const canResume = !s && last && last.lines.length && Date.now() - (last.lines.at(-1)?.t || last.started) < 3 * 3600000;
  view().innerHTML = `
    <div class="captions" id="caps" aria-live="polite">
      ${s && s.lines.length ? "" : `<p class="empty">Tap <b>Listen</b> and what people say appears here in big letters. Type below and tap <b>Speak</b> to answer out loud. Captions can contain mistakes.</p>`}
      ${!s && !sessions.length && !store.get("welcomed", false) ? `<div class="box" id="welcome" style="font-size:1rem"><b>Welcome to OtoHearSay.</b> <a href="#more/manual">Read how to use it</a>. New phone? <button class="btn primary" id="wSync">Sync with Google Drive</button> <button class="btn" id="wRestore">Restore from a backup</button> <button class="btn" id="wFresh">Start fresh</button></div>` : ""}
      ${canResume ? `<p id="resume"><button class="btn" id="resumeBtn">Continue your last talk (${esc(fmtDate(last.lines.at(-1)?.t || last.started))})</button></p>` : ""}
      <p class="line partial" id="partial" hidden></p>
    </div>
    <button class="btn primary" id="newest" hidden>↓ Newest</button>
    <div class="talkbar" id="tb">
      <div class="tools" role="toolbar" aria-label="Talk tools">
        <button class="tool t1" id="mark" title="Mark that a different person is talking"><span>🗣</span>New speaker</button>
        <button class="tool t2" id="cardBtn" title="Show your typed words in big letters"><span>🪧</span>Show</button>
        <button class="tool t3" id="flip" title="Turn the typing box around for the person across from you" aria-label="Flip"><span>⇅</span>Flip</button>
        <button class="tool t4" id="smaller" aria-label="Smaller text"><span>A−</span>Smaller</button>
        <button class="tool t5" id="bigger" aria-label="Bigger text"><span>A+</span>Bigger</button>
        <button class="tool t6" id="bookmark" title="Mark this moment (class, church, meetings)"><span>🔖</span>Mark</button>
        ${Boost.available() ? `<button class="tool t8" id="boostBtn" aria-pressed="${Boost.cfg().on}" title="Play the sound into your headphones, louder and clearer"><span>🎧</span>Boost</button>` : ""}
        <button class="tool t7" id="newTalk" title="Keep this talk in Saved and start a fresh one"><span>✚</span>New talk</button>
      </div>
      <div class="chips" id="chips">${quick.map((p, i) => `<button class="chip" data-i="${i}">${pins.includes(p) ? "★ " : ""}${esc(p)}</button>`).join("")}</div>
      <div class="reply">
        <div class="mic">
          <button class="listen" id="listen" aria-label="Listen"></button>
          <span class="timer" id="timer">Ready</span>
        </div>
        <textarea id="say" placeholder="Type to talk..." aria-label="Type what you want to say" enterkeyhint="send"></textarea>
        <button class="btn primary" id="speak">Speak</button>
      </div>
    </div>`;
  const caps = $("#caps");
  if (s) s.lines.forEach(l => caps.insertBefore(lineEl(l, s), $("#partial")));
  scrollCaps();
  wireSpeakerRename(caps, () => current, renderTalk);
  wireLineEdit(caps, () => current, true);
  capsPinned = true;
  caps.addEventListener("scroll", () => {
    capsPinned = caps.scrollHeight - caps.scrollTop - caps.clientHeight < 40;
    const b = $("#newest"); if (b) b.hidden = capsPinned;
  });
  $("#newest").onclick = () => { capsPinned = true; scrollCaps(true); };
  if (canResume) $("#resumeBtn").onclick = () => { current = last; renderTalk(); };
  if ($("#welcome")) {
    $("#wRestore").onclick = () => Backup.open();
    $("#wSync").onclick = () => { store.set("welcomed", true); Sync.connect(); };
    $("#wFresh").onclick = () => { store.set("welcomed", true); $("#welcome").remove(); };
  }
  updateListenButton();
  $("#listen").onclick = () => listening ? Listener.stop() : Listener.start();
  $("#mark").onclick = () => addLine("marker", "");
  $("#bookmark").onclick = () => { addLine("bookmark", ""); toast("Bookmarked. Find it in Saved."); };
  $("#cardBtn").onclick = () => showCard($("#say").value.trim() || info.note);
  $("#flip").onclick = () => $("#tb").classList.toggle("flipped");
  $("#smaller").onclick = () => { settings.capSize = Math.max(18, settings.capSize - 4); saveSettings(); scrollCaps(); };
  $("#bigger").onclick = () => { settings.capSize = Math.min(72, settings.capSize + 4); saveSettings(); scrollCaps(); };
  if ($("#boostBtn")) { $("#boostBtn").onclick = () => Boost.sheet(); Boost.pill(); }
  $("#newTalk").onclick = () => { if (current && current.lines.length) toast("Saved. A new talk has started."); current = null; renderTalk(); };
  $("#chips").onclick = e => { const c = e.target.closest(".chip"); if (c) sayAloud(quick[+c.dataset.i]); };
  const say = $("#say");
  $("#speak").onclick = () => { sayAloud(say.value); say.value = ""; say.focus(); };
  say.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#speak").click(); } };
}
function updateListenButton() {
  const b = $("#listen");
  if (!b) return;
  b.innerHTML = `<span class="ring" aria-hidden="true"></span><span class="ico" aria-hidden="true">${listening ? "■" : "🎤"}</span><span class="lbl">${listening ? "Stop" : "Listen"}</span>`;
  b.setAttribute("aria-label", listening ? "Stop" : "Listen");
  b.classList.toggle("on", listening);
  Meter.state(listening);
  b.disabled = !Listener.available();
  if (!Listener.available()) b.title = "This browser cannot run the speech engine.";
}

function renderPhrases() {
  phraseCat = Math.min(phraseCat, Math.max(0, phrases.length - 1));
  const cat = phrases[phraseCat];
  view().innerHTML = `
    <div class="cats" role="group" aria-label="Phrase groups">
      ${phrases.map((c, i) => `<button class="chip" data-cat="${i}" aria-pressed="${i === phraseCat}">${esc(c.name)}</button>`).join("")}
      <button class="chip" id="editToggle">${phraseEdit ? "Done" : "Edit"}</button>
    </div>
    ${phraseEdit ? `
      <div class="box">
        <div class="row" style="margin-bottom:8px"><input type="text" id="newPhrase" placeholder="New phrase for ${esc(cat?.name || "this group")}"><button class="btn primary" id="addPhrase">Add</button></div>
        <div class="row"><input type="text" id="newCat" placeholder="New group name"><button class="btn" id="addCat">Add group</button>
        ${cat ? `<button class="btn danger" id="delCat">Delete "${esc(cat.name)}"</button>` : ""}<button class="btn" id="resetPh">Restore starting phrases</button></div>
      </div>
      <ul class="list">${(cat?.items || []).map((p, i) => `<li><span class="grow">${esc(p)}</span><button class="btn iconbtn" data-pin="${i}" aria-label="${pins.includes(p) ? "Unpin" : "Pin to the Talk screen"}" aria-pressed="${pins.includes(p)}">${pins.includes(p) ? "★" : "☆"}</button><button class="btn danger iconbtn" data-del="${i}" aria-label="Delete">✕</button></li>`).join("")}</ul>
      <p class="muted small">★ pins a phrase so it shows first on the Talk screen.</p>`
    : `<p class="muted small">Tap a phrase to say it out loud. It is also added to your current talk.</p>
       <div class="phrase-grid">${(cat?.items || []).map((p, i) => `<button class="phrase" data-say="${i}">${pins.includes(p) ? "★ " : ""}${esc(p)}</button>`).join("")}</div>`}`;
  const save = () => { store.set("phrases", phrases); renderPhrases(); };
  view().onclick = e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.cat) { phraseCat = +t.dataset.cat; renderPhrases(); }
    else if (t.id === "editToggle") { phraseEdit = !phraseEdit; renderPhrases(); }
    else if (t.dataset.say) { const p = cat.items[+t.dataset.say]; sayAloud(p); toast("Said: " + p); }
    else if (t.dataset.del) { cat.items.splice(+t.dataset.del, 1); save(); }
    else if (t.dataset.pin) { const p = cat.items[+t.dataset.pin]; pins = pins.includes(p) ? pins.filter(x => x !== p) : [...pins, p]; store.set("pins", pins); renderPhrases(); }
    else if (t.id === "addPhrase") { const v = $("#newPhrase").value.trim(); if (v && cat) { cat.items.push(v); save(); } }
    else if (t.id === "addCat") { const v = $("#newCat").value.trim(); if (v) { phrases.push({ name: v, items: [] }); phraseCat = phrases.length - 1; save(); } }
    else if (t.id === "delCat") { if (t.dataset.sure) { phrases.splice(phraseCat, 1); phraseCat = 0; save(); } else { t.dataset.sure = 1; t.textContent = "Tap again to delete"; } }
    else if (t.id === "resetPh") { if (t.dataset.sure) { phrases = JSON.parse(JSON.stringify(DEFAULT_PHRASES)); phraseCat = 0; save(); } else { t.dataset.sure = 1; t.textContent = "Tap again to restore"; } }
  };
}

// Read aloud, one sentence at a time: tap any word to start there, skip or repeat a sentence, set a pause between
// sentences and a sleep timer. The sentence being read is shaded and the word being read is highlighted.
const reader = { text: "", sents: [], index: 0, from: 0, id: "", on: false, word: null, sleepAt: 0, sleepTimer: 0 };
function splitSentences(text) {
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+["')\]]*)?\s*|\n+/g;
  let m;
  while ((m = re.exec(text))) { if (m[0].trim()) out.push({ start: m.index, end: m.index + m[0].length }); if (!m[0]) re.lastIndex++; }
  return out;
}
function drawReadOut() {
  const out = $("#readOut"); if (!out) return;
  const t = reader.text, sen = reader.on ? reader.sents[reader.index] : null, w = reader.on ? reader.word : null;
  let html = "", i = 0;
  const re = /\S+|\s+/g; let m;
  while ((m = re.exec(t))) {
    const a = m.index, b = a + m[0].length, word = /\S/.test(m[0]);
    if (!word) { html += esc(m[0]); continue; }
    const inS = sen && a >= sen.start && b <= sen.end, inW = w && a < w.end && b > w.start;
    html += `<span data-o="${a}" class="${inW ? "w" : inS ? "s" : ""}">${esc(m[0])}</span>`;
    i++;
  }
  out.innerHTML = html;
  out.querySelector(".w, .s")?.scrollIntoView({ block: "nearest" });
}
function speakCurrent() {
  if (!reader.on) return;
  if (reader.index >= reader.sents.length) { stopReading(); return; }
  const sen = reader.sents[reader.index];
  const from = Math.max(sen.start, reader.from);
  reader.from = 0;
  reader.offset = from;
  reader.word = null;
  reader.id = "r" + (++speakSeq);
  drawReadOut();
  Voice.speak(reader.text.slice(from, sen.end), reader.id);
}
function startReading(offset = 0) {
  reader.sents = splitSentences(reader.text);
  if (!reader.sents.length) return;
  reader.index = Math.max(0, reader.sents.findIndex(x => offset < x.end));
  reader.from = offset;
  reader.on = true;
  const b = $("#readBtn"); if (b) b.textContent = "Stop";
  speakCurrent();
}
function stopReading() {
  reader.on = false; reader.word = null;
  Voice.stop();
  clearTimeout(reader.sleepTimer); reader.sleepAt = 0;
  drawReadOut();
  const b = $("#readBtn"); if (b) b.textContent = "Read aloud";
  const z = $("#sleep"); if (z) z.value = "0";
}
function jumpSentence(step) {
  if (!reader.on) { startReading(0); return; }
  reader.index = Math.min(Math.max(0, reader.index + step), reader.sents.length - 1);
  Voice.stop();
  speakCurrent();
}
OtoEvents.on("speakDone", id => {
  if (!reader.on || id !== reader.id) return;
  reader.index++;
  if (settings.speedUp && reader.index % 4 === 0 && settings.rate < 2) {
    settings.rate = Math.min(2, Math.round((settings.rate + 0.1) * 10) / 10); saveSettings();
    const r = $("#rateNow"); if (r) r.textContent = settings.rate.toFixed(1) + "×";
    const rr = $("#readRate"); if (rr) rr.value = settings.rate;
  }
  setTimeout(() => { if (reader.on && id === reader.id) speakCurrent(); }, settings.pauseMs);
});
OtoEvents.on("word", w => {
  if (!reader.on || w.id !== reader.id || noWordMarks.has(w.id)) return;
  reader.word = { start: reader.offset + w.start, end: reader.offset + w.end };
  drawReadOut();
});
let pendingRead = "";
function renderRead() {
  view().innerHTML = `
    <label class="field"><span>Paste or type text, or share text to OtoHearSay from another app</span>
      <textarea id="readIn" rows="5" placeholder="Text to read aloud"></textarea></label>
    ${native && native.scanPage ? `<div class="row" style="margin:-4px 0 10px"><button class="btn c-scan" id="scanCam">📷 Read a page with the camera</button><button class="btn" id="scanPick">🖼 From a picture</button></div>` : ""}
    <div class="player" role="group" aria-label="Reading controls">
      <button class="pbtn" id="prevS" aria-label="Previous sentence">⏮</button>
      <button class="pbtn" id="againS" aria-label="Repeat this sentence">↻</button>
      <button class="pbtn play" id="readBtn">${reader.on ? "Stop" : "Read aloud"}</button>
      <button class="pbtn" id="nextS" aria-label="Next sentence">⏭</button>
      <button class="pbtn" id="readCard" aria-label="Show in big letters">🪧</button>
    </div>
    <div class="speeds" role="group" aria-label="Reading speed">
      <span class="small muted">Speed</span>
      ${[0.8, 1, 1.2, 1.5, 2, 2.5].map(v => `<button class="chip speed" data-rate="${v}" aria-pressed="${Math.abs(settings.rate - v) < 0.05}">${v}×</button>`).join("")}
      <input type="range" id="readRate" min="0.5" max="3" step="0.1" value="${settings.rate}" aria-label="Exact speed" style="width:110px">
      <b id="rateNow" class="small">${(+settings.rate).toFixed(1)}×</b>
    </div>
    <details class="box readopts">
      <summary>Reading options</summary>
      <label class="row"><input type="checkbox" id="speedUp" ${settings.speedUp ? "checked" : ""} style="width:auto;min-height:auto"> Speed up gradually (a little faster every few sentences, up to 2×)</label>
      <p class="small muted" style="margin:8px 0 4px">Skip while reading:</p>
      <label class="row"><input type="checkbox" id="skLinks" ${settings.skip?.links ? "checked" : ""} style="width:auto;min-height:auto"> Web links</label>
      <label class="row"><input type="checkbox" id="skNotes" ${settings.skip?.notes ? "checked" : ""} style="width:auto;min-height:auto"> Footnote marks like [1]</label>
      <label class="row"><input type="checkbox" id="skBrackets" ${settings.skip?.brackets ? "checked" : ""} style="width:auto;min-height:auto"> Anything in (brackets)</label>
      <div class="row small" style="margin-top:8px">
        <label class="row" style="gap:6px">Pause between sentences <select id="pause" style="width:auto"><option value="150">Short</option><option value="400">Normal</option><option value="900">Long</option></select></label>
        <label class="row" style="gap:6px">Sleep timer <select id="sleep" style="width:auto"><option value="0">Off</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">1 hour</option></select></label>
      </div>
    </details>
    <p class="muted small">Tap any word below to start reading from there.</p>
    <div class="box readtext" id="readOut" aria-live="off"></div>`;
  const input = $("#readIn");
  if (pendingRead) { reader.text = pendingRead; pendingRead = ""; }
  input.value = reader.text;
  drawReadOut();
  input.oninput = () => { if (reader.on) stopReading(); reader.text = input.value; drawReadOut(); };
  const setRate = v => {
    settings.rate = Math.round(v * 10) / 10; saveSettings();
    $("#readRate").value = settings.rate; $("#rateNow").textContent = settings.rate.toFixed(1) + "×";
    document.querySelectorAll(".speed").forEach(b => b.setAttribute("aria-pressed", Math.abs(+b.dataset.rate - settings.rate) < 0.05));
  };
  $("#readRate").oninput = e => setRate(+e.target.value);
  document.querySelectorAll(".speed").forEach(b => { b.onclick = () => setRate(+b.dataset.rate); });
  $("#speedUp").onchange = e => { settings.speedUp = e.target.checked; saveSettings(); };
  const skip = (id, key) => { $(id).onchange = e => { settings.skip = { ...(settings.skip || {}), [key]: e.target.checked }; saveSettings(); }; };
  skip("#skLinks", "links"); skip("#skNotes", "notes"); skip("#skBrackets", "brackets");
  $("#pause").value = String([150, 400, 900].includes(settings.pauseMs) ? settings.pauseMs : 400);
  $("#pause").onchange = e => { settings.pauseMs = +e.target.value; saveSettings(); };
  $("#sleep").value = reader.sleepAt ? $("#sleep").value : "0";
  $("#sleep").onchange = e => {
    clearTimeout(reader.sleepTimer); reader.sleepAt = 0;
    const min = +e.target.value;
    if (min) { reader.sleepAt = Date.now() + min * 60000; reader.sleepTimer = setTimeout(() => { stopReading(); toast("Sleep timer: reading stopped."); }, min * 60000); toast(`Reading stops in ${min} minutes.`); }
  };
  if ($("#scanCam")) { $("#scanCam").onclick = () => { toast("Take a clear, flat photo of the page."); native.scanPage(true); }; $("#scanPick").onclick = () => native.scanPage(false); }
  $("#readCard").onclick = () => reader.text.trim() && showCard(reader.text.trim());
  $("#readBtn").onclick = () => { if (reader.on) stopReading(); else { reader.text = input.value; startReading(0); } };
  $("#prevS").onclick = () => jumpSentence(-1);
  $("#nextS").onclick = () => jumpSentence(1);
  $("#againS").onclick = () => jumpSentence(0);
  $("#readOut").onclick = e => {
    const w = e.target.closest("[data-o]"); if (!w) return;
    Voice.stop(); reader.on = false; startReading(+w.dataset.o);
  };
}
function openShared(text) { if (!text) return; if (reader.on) stopReading(); pendingRead = text; location.hash = "read"; if ((location.hash.slice(1) || "") === "read") renderRead(); }
OtoEvents.on("sharedText", openShared);
OtoEvents.on("scanText", t => { if (!t || !t.trim()) { toast("No text was found. Try a sharper, closer photo with good light."); return; } openShared(t.trim()); toast("Text found. Tap Read aloud."); });

function renderHistory(id) {
  if (id) {
    const s = sessions.find(x => x.id === id);
    if (!s) { location.hash = "history"; return; }
    const lines = s.lines.filter(l => l.who !== "marker").length;
    view().innerHTML = `<div class="split"><aside class="side" id="side" aria-label="All talks"></aside><section class="detail">
      <div class="row" style="margin-bottom:12px">
        <button class="btn" id="back">‹ All talks</button>
        <button class="btn iconbtn" id="fav" aria-pressed="${!!s.fav}" aria-label="${s.fav ? "Remove from favorites" : "Add to favorites"}">${s.fav ? "★" : "☆"}</button>
        <button class="btn" id="exp">Text</button>
        <button class="btn c-pdf" id="expPdf">PDF</button>
        <button class="btn c-doc" id="expDoc">Word</button>
        <button class="btn" id="expT">Text with times</button>
        ${s.lines.some(l => l.at != null) ? `<button class="btn" id="srt">Save subtitles (SRT)</button>` : ""}
        <button class="btn" id="cont">Continue this talk</button>
        <button class="btn danger" id="del">Delete</button>
      </div>
      <label class="field"><span>Name of this talk</span><input type="text" id="ttl" value="${esc(s.title || "")}" placeholder="${esc(sessionTitle({ lines: s.lines }))}"></label>
      <p class="muted small">${fmtDate(s.started)} · ${lines} lines · tap a speaker's label to name them</p>
      ${FileCaption.session === s ? `<p id="fileStatus" class="small"><b>Captioning...</b></p>` : ""}
      ${TalkSound.has(s) ? `<div class="player" id="player"><button class="pbtn play" id="playBtn">▶ Play</button><span class="small muted" id="playT">0:00</span><button class="pbtn" id="playLoud" aria-pressed="false" title="Play it louder and clearer, with your Sound boost settings">🔊 Louder</button><span class="small muted">Tap a line, then "Play this line"</span></div>` : ""}
      <details class="box" id="kp"><summary><b>Key points</b> <span class="small muted">(worked out on this device)</span></summary><div id="kpBody"></div></details>
      <div class="captions" id="hcaps" style="font-size:min(var(--cap-size),28px)">${s.lines.map(l => lineEl(l, s).outerHTML).join("")}</div>
      <div class="box">
        <h2>Fix a word everywhere in this talk</h2>
        <div class="row"><input type="text" id="fixFrom" placeholder="Wrong word (for example: Jon)" style="flex:1;min-width:140px">
        <input type="text" id="fixTo" placeholder="Right word (for example: John)" style="flex:1;min-width:140px">
        <button class="btn" id="fixGo">Fix</button></div>
      </div>
      <label class="field"><span>Notes about this talk</span><textarea id="note" rows="3">${esc(s.note || "")}</textarea></label></section></div>`;
    // Tablets and computers: the list of talks stays on the left (two panes).
    $("#side").innerHTML = sessions.filter(x => x.lines.length).map(x => `<button class="sidebtn${x === s ? " on" : ""}" data-id="${x.id}"><b>${x.fav ? "★ " : ""}${esc(sessionTitle(x))}</b><span class="muted small">${fmtDate(x.started)}</span></button>`).join("");
    $("#side").onclick = e => { const b = e.target.closest("[data-id]"); if (b) location.hash = "history/" + b.dataset.id; };
    const save = () => store.set("sessions", sessions);
    $("#back").onclick = () => { location.hash = "history"; };
    $("#fav").onclick = () => { s.fav = !s.fav; save(); renderHistory(id); };
    $("#ttl").onchange = e => { s.title = e.target.value.trim(); save(); };
    $("#note").onchange = e => { s.note = e.target.value.trim(); save(); };
    $("#exp").onclick = () => exportText("OtoHearSay " + sessionTitle(s), sessionText(s));
    $("#expT").onclick = () => exportText("OtoHearSay " + sessionTitle(s), sessionText(s, true));
    const fname = ext => ("OtoHearSay " + sessionTitle(s)).replace(/[^\w\- ]+/g, "").trim().slice(0, 60) + ext;
    $("#expPdf").onclick = () => exportBytes(fname(".pdf"), "application/pdf", makePdf(sessionTitle(s), sessionText(s, true)));
    $("#expDoc").onclick = () => exportBytes(fname(".doc"), "application/msword", makeDoc(sessionTitle(s), s));
    if ($("#srt")) $("#srt").onclick = () => {
      const name = sessionTitle(s).replace(/\.[a-z0-9]+$/i, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) + ".srt";
      if (native) native.shareText(name, sessionSrt(s)); else exportFile(name, sessionSrt(s), "application/x-subrip");
    };
    $("#cont").onclick = () => { current = s; location.hash = "talk"; };
    $("#fixGo").onclick = () => {
      const from = $("#fixFrom").value.trim(), to = $("#fixTo").value.trim();
      if (!from) return;
      const re = new RegExp("\\b" + from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
      let n = 0;
      s.lines.forEach(l => { if (l.who !== "marker") l.text = l.text.replace(re, () => { n++; return to; }); });
      save(); renderHistory(id); toast(n ? `Fixed ${n} ${n === 1 ? "place" : "places"}.` : `"${from}" was not found.`);
    };
    $("#del").onclick = e => {
      if (!e.target.dataset.sure) { e.target.dataset.sure = 1; e.target.textContent = "Tap again to delete"; return; }
      TalkSound.remove(s); sessions = sessions.filter(x => x !== s); if (current === s) current = null; save(); location.hash = "history";
    };
    wireSpeakerRename($("#hcaps"), () => s, () => renderHistory(id));
    wireLineEdit($("#hcaps"), () => s, false);
    wirePlayer(s, $("#hcaps"));
    $("#kp").ontoggle = () => {
      if (!$("#kp").open) return;
      const k = keyPoints(s);
      $("#kpBody").innerHTML = k.points.length ? `<ul>${k.points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>${k.topics.length ? `<p class="small muted">Came up most: ${k.topics.map(esc).join(", ")}</p>` : ""}`
        : `<p class="muted small">This talk is too short for key points.</p>`;
    };
    return;
  }
  view().innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <input type="search" id="q" placeholder="Search saved talks" aria-label="Search saved talks" style="flex:1;min-width:180px">
      <button class="chip" id="favOnly" aria-pressed="false">★ Favorites</button>
    </div>
    <p><button class="btn" id="capFile">🎧 Caption a voice message, recording or video</button></p>
    <ul class="list" id="sessList"></ul>
    ${settings.keepDays ? `<p class="muted small" style="margin-top:10px">Talks older than ${settings.keepDays} days are deleted automatically, except favorites. Change this in More, Settings.</p>` : ""}`;
  let favOnly = false;
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    const list = sessions.filter(s => s.lines.length && (!favOnly || s.fav) &&
      (!q || (s.title || "").toLowerCase().includes(q) || (s.note || "").toLowerCase().includes(q) || s.lines.some(l => l.text.toLowerCase().includes(q))));
    $("#sessList").innerHTML = list.length ? list.map(s => `<li><button class="link grow" data-id="${s.id}"><b>${s.fav ? "★ " : ""}${esc(sessionTitle(s))}</b><br><span class="muted small">${fmtDate(s.started)} · ${s.lines.filter(l => l.who !== "marker").length} lines${s.note ? " · has notes" : ""}</span></button></li>`).join("")
      : `<li class="muted">${q || favOnly ? "No saved talk matches." : "Your talks are saved here automatically, on this device only."}</li>`;
  };
  draw();
  $("#q").oninput = draw;
  $("#capFile").onclick = () => FileCaption.pick();
  $("#favOnly").onclick = e => { favOnly = !favOnly; e.target.setAttribute("aria-pressed", favOnly); draw(); };
  $("#sessList").onclick = e => { const b = e.target.closest("[data-id]"); if (b) location.hash = "history/" + b.dataset.id; };
}

// ---------- the manual (More > How to use OtoHearSay) ----------
// Plain steps for every part of the app. Sections that do not exist on this device (phone-only or personal-only
// features) are left out, so the manual always matches the app in hand.
function manualSections() {
  const phone = !!native, upd = !!(native && native.checkUpdate);
  return [
    ["boost", "Sound boost: hear it louder in your headphones", `<p>Sound boost plays what the microphone hears into your headphones, louder and clearer, while the captions keep running, so you can listen and read at the same time.</p>
      <ol><li>Put on headphones or earbuds. ${phone ? "Wired, USB or Bluetooth all work. Sound boost never plays through the phone's own speaker, because that would squeal." : "In a browser the app cannot tell whether headphones are on, so it asks you. Loudspeakers would squeal."}</li>
      <li>On <b>Talk</b>, tap <b>🎧 Boost</b>, switch <b>Sound boost</b> on, then tap <b>Listen</b>.</li>
      <li>Slide <b>Louder by</b> up slowly until it is comfortable.</li>
      <li>Tap a place (<b>Quiet room, Restaurant, Church, Class, TV, Car</b>) to set the sound for it in one tap.</li>
      <li><b>One-on-one</b> keeps the nearest, loudest voice and turns the background down. It suits a noisy table.</li></ol>
      <p><b>More > Sound boost</b> has the rest: noise reduction, three tone sliders, a level for each ear, the loudness limit, which microphone to use, and <b>Save my settings here</b> to make a place your own (it also remembers your caption size).</p>
      <p><b>Sound setup</b> plays soft beeps in each ear and tunes the tone and the two ears to your headphones. It is not a hearing test.</p>
      <p><b>TV or another room:</b> leave the ${phone ? "phone" : "device"} near the TV or the person talking and wear Bluetooth earbuds. It works as far as Bluetooth reaches, usually one or two rooms.${phone ? " It keeps working with the screen off." : ""}</p>
      <p><b>Tips:</b> wired headphones keep the sound in step with people's lips; Bluetooth adds a short delay. Sound boost works with the private speech engine and English. Start low: loud sound for a long time can harm hearing. Sound boost is an amplifier for everyday situations, not a medical device.</p>
      <p>The <b>Listening diary</b> (More) shows how long you listened in the last two weeks, by place.</p>`],
    ["alerts", "Sound alerts: doorbell, alarm, baby, phone", `${phone ? `<p>In <b>More > Sound alerts</b>, switch alerts on and choose which sounds matter. While <b>Listen</b> is on, a doorbell or knock, a smoke or fire alarm, a baby crying or a phone ringing makes the screen flash, the phone buzz, and a large word appear. A bookmark is added to the talk at that moment.</p>
      <p>It runs on the phone; nothing is sent anywhere. It can miss sounds and it can be wrong. <b>Never rely on it as your only warning of a fire.</b> Keep working smoke alarms.</p>` : `<p>Sound alerts (a flash and a word for a doorbell, an alarm, a baby crying or a phone ringing) are in the OtoHearSay Android app for now. They are not in the web and desktop version yet.</p>`}`],
    ["other-room", "Hear and read another room", `<p><b>With one device:</b> switch on Sound boost, leave the ${phone ? "phone" : "device"} near the TV or the person talking, and wear Bluetooth earbuds.</p>
      <p><b>With two devices:</b> on the phone near the sound, open <b>More > Remote microphone</b> and share. On your own device connect to it, then tick <b>Play the sound from that phone too</b>. You read the captions and hear the sound, with your Sound boost loudness and tone. Both devices must be on the same Wi-Fi; use headphones.</p>
      <p><b>A recording, voicemail or video:</b> share it to OtoHearSay (or use Caption a recording). When it is captioned, press <b>Play</b> and then <b>🔊 Louder</b> to hear it louder and clearer while the words light up.</p>`],
    ["colors", "Colors: make it look the way you like", `<p>In <b>More > Settings</b>, <b>Look</b> has ready-made combinations (Dark blue, Light, Sunrise, Ocean, Violet night, System colors, High contrast).</p>
      <p>Under <b>Your own colors</b> you can then change two things: the <b>background</b> (the bars, panels and text are worked out from it, so text stays readable on light or dark) and the <b>accent</b> (buttons, highlights and lines). Tap a color, or <b>Any color…</b> for a free choice. <b>From the look</b> puts it back.</p>`],
    ["start", "Getting started", `<ol><li>Open the <b>Talk</b> tab and tap the big round <b>Listen</b> button. The first time, allow the microphone.</li>
      <li>Put the phone close to the person talking, on the table between you if you can. What they say appears in big letters.</li>
      <li>The ring around the button grows when the microphone hears sound, and the timer shows how long it has listened. Tap <b>Stop</b> to end.</li>
      <li>Every talk is saved by itself in <b>Saved</b>. Tap <b>✚ New talk</b> to start a fresh one.</li></ol>
      <p>Captions are made by a computer and can contain mistakes. Words with a dotted underline are ones the app was not sure of.</p>`],
    ["better", "Getting more words right", `<ul><li><b>Distance matters most.</b> Up close, about 95 words in 100 come out right; across a room with echo, many fewer. Move the phone closer, or use the <b>Remote microphone</b> (below).</li>
      <li><b>Teach it names:</b> More → Settings → <i>Names and words to listen for</i>. Add family names, places and words you use often.</li>
      <li><b>Try another engine:</b> More → Settings → <i>Speech engine</i>. "Private" never leaves the device. ${phone ? `"Phone's engine with internet" is often best for voices the private engine finds hard (the sound goes to Google).` : `"Browser's engine (online)" can be better for some voices (the sound goes to Google or Microsoft).`} Try each for a day and keep the one that misses fewer words.</li>
      <li><b>Other languages:</b> pick the language in Settings. The private engine knows English only, so other languages use the ${phone ? "phone's" : "browser's"} engine by themselves.</li></ul>`],
    ["fix", "Fixing a caption", `<ul><li><b>Tap any line</b> (live or in a saved talk) to type the right words, then <b>Save</b>. A small pencil marks fixed lines.</li>
      <li><b>🎤 Say it again:</b> while listening, tap a line, then Say it again. The next sentence heard replaces that line.</li>
      <li><b>Fix by voice:</b> turn it on in Settings, then say "replace <i>wrong word</i> with <i>right word</i>" to fix the last line.</li>
      <li><b>Fix a word everywhere:</b> in a saved talk, use the box "Fix a word everywhere in this talk".</li>
      <li>When you type a new name in a fix, the app offers to add it to your word list so it gets it right next time.</li></ul>`],
    ["reply", "Answering out loud", `<ul><li>Type in the box at the bottom of Talk and tap <b>Speak</b>: the phone says it out loud. While it speaks, captions pause for a moment, so the phone's own voice is not written down as the other person's words and plays smoothly; they carry on by themselves when it finishes. While the keyboard is open, the captions and the top bar move up above it and stay below the clock, so you can keep reading while you type.</li>
      <li>Tap a ready-made phrase (the round buttons above the box), or open the <b>Phrases</b> tab for more. Pin your favorites with ★ in Phrases (Edit).</li>
      <li><b>🪧 Show</b> puts your typed words in giant letters; <b>⇅ Flip</b> turns them around for the person across from you.</li></ul>`],
    ["tools", "The Talk tools", `<ul><li><b>🗣 New speaker:</b> marks that a different person started talking. Tap the speaker label to give them a name.</li>
      <li><b>A− / A+:</b> smaller or bigger captions (also in Settings).</li>
      <li><b>🔖 Mark:</b> bookmarks this moment (class, church, meetings).</li>
      <li><b>↓ Newest:</b> appears when you scroll back to re-read; tap it to jump to the latest words.</li>
      <li>Your name and alert words (Settings) make the phone buzz and flash when someone says them. The app also gives them to the speech engine so it hears them right more often, and with <b>Close spellings count</b> (on unless you turn it off) it still alerts when the captions spell the name a little differently or split it in two, for example "O tobon" for Otobong or "Catherine" for Katherine. Short words of four letters or fewer must match exactly. If it alerts too often, turn <b>Close spellings count</b> off in Settings.</li>
      <li><b>"The microphone hears almost nothing":</b> shows only while Listen is on, after about 8 seconds of near silence. Move the phone closer to the person talking. It goes away when you tap Stop or open another tab.</li></ul>`],
    ...(phone ? [["quick", "Start captions in one tap", `<ul><li><b>Home-screen widget:</b> touch and hold an empty spot on your home screen → Widgets → OtoHearSay → "Start captions".</li>
      <li><b>Quick-settings button:</b> swipe down twice from the top of the screen → tap the pencil (Edit) → drag <b>Captions</b> into your buttons.</li>
      <li><b>App icon:</b> touch and hold the OtoHearSay icon → <b>Start captions</b>.</li>
      <li>Captions keep running with the screen off; the latest caption shows in the notification, so a watch paired with your phone can show it too.</li></ul>`]] : []),
    ["calls", "Phone calls", `<p><b>No app can hear your phone calls:</b> Android (and iPhone) keep calls private from every app, OtoHearSay included. While you are on a call, OtoHearSay shows a reminder.</p>
      <p>Use your phone's own <b>Live Caption</b> instead (More → Captions on phone calls has the steps). It captions the <i>other</i> person's voice, not yours; that is normal.</p>
      <p>If Live Caption misses a lot, put the call on a good connection (Wi-Fi calling helps), ask the other person to talk a little slower, and try the services listed on the Captions on phone calls page.</p>`],
    ["saved", "Saved talks", `<ul><li>Search, star (★ Favorites), rename and add notes.</li>
      <li><b>Export:</b> Text, PDF or Word, or Text with times. Recordings you captioned can be saved as subtitles (SRT).</li>
      <li><b>Key points:</b> open "Key points" in a talk for the most important sentences, worked out on the device.</li>
      <li><b>Play it back:</b> turn on Settings → <i>Keep the sound of talks</i>. Then a saved talk has ▶ Play, and the words light up as you hear them. Tap a line → "Play this line". The sound stays on the device and is deleted with the talk.</li>
      <li><b>Caption a recording:</b> "🎧 Caption a voice message, recording or video", or share one to OtoHearSay from another app.</li></ul>`],
    ["read", "Read aloud", `<ul><li>Paste or type text, or share text to OtoHearSay from another app${phone ? `, or tap <b>📷 Read a page with the camera</b> (a clear, flat photo with good light works best)` : ""}.</li>
      <li>Tap <b>Read aloud</b>. Tap any word to start there; ⏮ ⏭ go back or forward a sentence, ↻ repeats it.</li>
      <li>Speed buttons 0.8× to 2.5×; <b>Reading options</b> has "speed up gradually", skipping links, footnote marks and brackets, the pause between sentences and a sleep timer.</li></ul>`],
    ["remote", "Remote microphone", `<p>Put a second phone near the speaker (teacher, pastor, meeting). On that phone: More → Remote microphone → <b>Share captions</b>. On your phone, tablet or computer on the same Wi-Fi, open the address it shows and type the 4-digit code. Nothing goes over the internet.</p>`],
    ["look", "Look and comfort", `<p>More → Settings → <b>Look</b>: Dark blue, Light, Sunrise, Ocean, Violet night, System colors (your phone's own colors) and High contrast (yellow on black). Caption size, line spacing and voice speed are there too.</p>`],
    ["practice", "Listening practice", `<p>More → Listening practice: the phone says a word or sentence through its speaker, your headphones or any Bluetooth listening device you use. Pick what you heard. Words you miss come back more often.</p>`],
    ["sync", "Sync across devices (Google Drive)", `<ol><li>More → <b>Sync across devices</b> → <b>Sign in to Google Drive and sync</b>. Pick your Google account and allow OtoHearSay to see the files it makes.</li>
      <li>Do the same on your other phone, tablet, the web version and the computer, with the <b>same Google account</b>.</li>
      <li>That is all. Each device syncs when you open it, a little after every change, and every 10 minutes while it is open. <b>Sync now</b> does it at once.</li>
      <li>Deleting a talk, phrase or alert word on one device deletes it on the others. If two devices change the same thing, the newest change wins; nothing else is overwritten.</li>
      <li>A talk you are captioning is sent when you tap Stop. Sound boost, places, the speech engine and kept sound stay on each device.</li>
      <li>To stop: More → Sync across devices → <b>Stop syncing on this device</b>. The data stays on the device and in your Drive (folder <b>OtoHearSay</b>).</li></ol>`],
    ["backup", "Backup and a new phone", `<ol><li>More → Backup and restore → <b>Back up</b>, and save the file to your Google Drive or OneDrive.</li>
      <li>On a new phone or computer, install OtoHearSay${upd ? " (from the same place you got it; your Drive keeps a copy of the app file)" : " from the store"}.</li>
      <li>On the first start, tap <b>Sync with Google Drive</b> (if you use sync, everything comes back by itself) or <b>Restore from a backup</b> and pick the file. Talks, phrases, info card and settings come back. Kept sound is not in backups (too big).</li></ol>`],
    ...(upd ? [["updates", "Updates", `<p>This copy updates itself: every few hours (or More → About → <b>Check for updates</b>) it looks for a new version, checks that it really is OtoHearSay signed with the same key, and installs it. The first time, Android asks you to allow OtoHearSay to install apps; tap <b>Allow</b>. It never installs while you are listening.</p>`]] : []),
    ["privacy", "Privacy", `<p>With the private engine, what people say never leaves the device. Talks, phrases, your card and settings are stored only on this device, in backups you choose and, if you turn on Sync across devices, in your own Google Drive. The only times sound leaves the device are when you choose an online speech engine.</p>`],
  ];
}

const LANGS = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["es-US", "Spanish (US)"], ["es-ES", "Spanish (Spain)"], ["fr-FR", "French"], ["de-DE", "German"], ["pt-BR", "Portuguese (Brazil)"]];
function renderMore(sub) {
  const back = `<button class="btn" id="back" style="margin-bottom:12px">‹ More</button>`;
  const wireBack = () => { $("#back").onclick = () => { location.hash = "more"; }; };
  if (sub === "settings") {
    view().innerHTML = back + `
      <label class="field"><span>Look</span><select id="theme">${THEMES.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
      <div class="box" id="ownColors">
        <h2>Your own colors</h2>
        <p class="muted small">Pick a look above, then change the background or the accent if you like. High contrast keeps its own colors.</p>
        <p class="small" style="margin:8px 0 4px">Background (bars, panels and text follow it)</p>
        <div class="swatches" id="wallSw"><button class="chip" data-c="" aria-pressed="${!settings.wall}">From the look</button>${WALLS.map(([c, n]) => `<button class="sw" data-c="${c}" aria-label="${n}" title="${n}" aria-pressed="${(settings.wall || "").toLowerCase() === c.toLowerCase()}" style="background:${c}"></button>`).join("")}<label class="chip anyc">Any color… <input type="color" id="wallAny" value="${Color.rgb(settings.wall) ? settings.wall : "#0f2238"}"></label></div>
        <p class="small" style="margin:12px 0 4px">Accent (buttons, highlights and lines)</p>
        <div class="swatches" id="accSw"><button class="chip" data-c="" aria-pressed="${!settings.accentColor}">From the look</button>${ACCENTS.map(([c, n]) => `<button class="sw" data-c="${c}" aria-label="${n}" title="${n}" aria-pressed="${(settings.accentColor || "").toLowerCase() === c.toLowerCase()}" style="background:${c}"></button>`).join("")}<label class="chip anyc">Any color… <input type="color" id="accAny" value="${Color.rgb(settings.accentColor) ? settings.accentColor : "#f2a900"}"></label></div>
      </div>
      <label class="field"><span>Caption size: <b id="capV">${settings.capSize}</b></span><input type="range" id="cap" min="18" max="72" step="2" value="${settings.capSize}" style="width:100%"></label>
      <label class="field"><span>Space between caption lines</span><select id="gap"><option value="1.15">Tight</option><option value="1.3">Normal</option><option value="1.6">Roomy</option></select></label>
      <label class="field"><span>Speaking speed: <b id="rateV">${settings.rate}</b></span><input type="range" id="rate" min="0.5" max="2" step="0.1" value="${settings.rate}" style="width:100%"></label>
      <label class="row" style="margin-bottom:12px"><input type="checkbox" id="keepSound" ${settings.keepSound ? "checked" : ""} style="width:auto;min-height:auto"> Keep the sound of talks, so you can play them back in Saved talks with the words lighting up (stays on this device; about 2 MB a minute${native && native.talkAudioMB ? `; now ${native.talkAudioMB().toFixed(0)} MB` : ""}). Works with the private engine.</label>
      ${native ? `<label class="row" style="margin-bottom:12px"><input type="checkbox" id="notifyCap" ${settings.notifyCaptions !== false ? "checked" : ""} style="width:auto;min-height:auto"> Show the latest caption in the notification, so it can be read on the lock screen (when you allow it) and on a watch paired with this phone</label>` : ""}
      <label class="row" style="margin-bottom:12px"><input type="checkbox" id="voiceFixOn" ${settings.voiceFix ? "checked" : ""} style="width:auto;min-height:auto"> Fix by voice: say "replace <i>wrong word</i> with <i>right word</i>" to fix the last line</label>
      <label class="field"><span>Language people speak</span><select id="lang">${LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
      <label class="field"><span>Names and words to listen for (one per line or separated by commas: family names, places, words you use often). Captions get these right more often.</span><textarea id="words" rows="3">${esc(settings.words || "")}</textarea></label>
      <label class="field"><span>Speech engine (if captions keep missing your words or someone's voice, try another)</span><select id="engineSel">
        <option value="private">Private: OtoHearSay's own engine, never leaves this device</option>
        ${native ? `<option value="phone">Phone's engine (Google or Samsung), on this phone</option>` : ""}
        ${native || Listener.browserSR() ? `<option value="online">${native ? "Phone's engine with internet" : "Browser's engine (online)"}: often best for voices the others find hard; the sound goes to Google${native ? "" : " or Microsoft"}</option>` : ""}
      </select></label>
      <label class="field"><span>Mark words the app is unsure of (dotted underline)</span><select id="unsure"><option value="off">Off</option><option value="normal">Normal</option><option value="more">More words</option></select></label>
      <label class="field"><span>Your name (the phone buzzes and flashes when someone says it)</span><input type="text" id="nm" value="${esc(settings.name)}"></label>
      <label class="field"><span>Other alert words, separated by commas (for example: boarding, next, a child's name)</span><input type="text" id="kw" value="${esc(settings.keywords.join(", "))}"></label>
      <label class="row" style="margin-bottom:12px"><input type="checkbox" id="alertClose" ${settings.alertClose !== false ? "checked" : ""} style="width:auto;min-height:auto"> Close spellings count: alert even when the captions spell the name a little differently or split it in two (for example "O tobon" for Otobong). Your name and alert words are also given to the speech engine, so it hears them right more often.</label>
      ${native ? `<label class="row" style="margin-bottom:12px"><input type="checkbox" id="scrOn" ${settings.screenOn !== false ? "checked" : ""} style="width:auto;min-height:auto"> Keep the screen on while listening (when off, captions keep running with the screen off and a notification shows)</label>` : ""}
      <label class="field"><span>Delete saved talks automatically after</span><select id="keep"><option value="0">Never</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></label>
      <div class="box">
        <h2>Pronunciation fixes</h2>
        <p class="muted small">If the voice says a name or word wrong, type how it is written and how to say it, for example "Otobong" as "Oh-toe-bong".</p>
        <ul class="list" id="pronList"></ul>
        <div class="row" style="margin-top:8px"><input type="text" id="pFrom" placeholder="Written as" style="flex:1;min-width:120px"><input type="text" id="pTo" placeholder="Say it like" style="flex:1;min-width:120px"><button class="btn" id="pAdd">Add</button><button class="btn" id="pTest">Hear it</button></div>
      </div>
      <button class="btn" id="test">Test the voice</button>`;
    wireBack();
    $("#theme").value = settings.theme;
    $("#lang").value = LANGS.some(l => l[0] === settings.lang) ? settings.lang : "en-US";
    $("#theme").onchange = e => { settings.theme = e.target.value; saveSettings(); };
    const own = (boxId, anyId, key) => {
      const mark = () => $("#" + boxId).querySelectorAll("[data-c]").forEach(b => b.setAttribute("aria-pressed", String((settings[key] || "").toLowerCase() === b.dataset.c.toLowerCase())));
      $("#" + boxId).onclick = e => { const b = e.target.closest("[data-c]"); if (!b) return; settings[key] = b.dataset.c; saveSettings(); mark(); };
      $("#" + anyId).oninput = e => { settings[key] = e.target.value; saveSettings(); mark(); };
    };
    own("wallSw", "wallAny", "wall"); own("accSw", "accAny", "accentColor");
    $("#cap").oninput = e => { settings.capSize = +e.target.value; $("#capV").textContent = settings.capSize; saveSettings(); };
    $("#rate").oninput = e => { settings.rate = +e.target.value; $("#rateV").textContent = settings.rate; saveSettings(); };
    $("#lang").onchange = e => { settings.lang = e.target.value; saveSettings(); };
    $("#words").onchange = e => { settings.words = e.target.value; saveSettings(); toast("Saved. The list is used from the next sentence."); };
    $("#engineSel").value = settings.engine || "private";
    if (!$("#engineSel").value) $("#engineSel").value = "private";
    $("#engineSel").onchange = e => {
      settings.engine = e.target.value; saveSettings(); applySettings();
      if (!native && listening) { Listener.stop(); Listener.start(); }
      toast(settings.engine === "private" ? "Using the private engine." : "Using the phone's engine. Compare which one gets your words right more often.");
    };
    $("#unsure").value = settings.unsure || "normal";
    $("#unsure").onchange = e => { settings.unsure = e.target.value; saveSettings(); };
    $("#nm").onchange = e => { settings.name = e.target.value.trim(); saveSettings(); };
    $("#kw").onchange = e => { settings.keywords = e.target.value.split(",").map(s => s.trim()).filter(Boolean); saveSettings(); };
    $("#alertClose").onchange = e => { settings.alertClose = e.target.checked; saveSettings(); };
    $("#test").onclick = () => Voice.speak("Hello! This is how I sound.");
    $("#gap").value = String([1.15, 1.3, 1.6].includes(settings.lineGap) ? settings.lineGap : 1.3);
    $("#gap").onchange = e => { settings.lineGap = +e.target.value; saveSettings(); };
    $("#keepSound").onchange = e => { settings.keepSound = e.target.checked; saveSettings(); toast(settings.keepSound ? "The sound of new talks is kept on this device." : "New talks are not recorded."); };
    if ($("#notifyCap")) $("#notifyCap").onchange = e => { settings.notifyCaptions = e.target.checked; saveSettings(); };
    $("#voiceFixOn").onchange = e => { settings.voiceFix = e.target.checked; saveSettings(); };
    if ($("#scrOn")) $("#scrOn").onchange = e => { settings.screenOn = e.target.checked; saveSettings(); };
    $("#keep").value = String(settings.keepDays || 0);
    $("#keep").onchange = e => { settings.keepDays = +e.target.value; saveSettings(); pruneOldTalks(); };
    const drawPron = () => {
      $("#pronList").innerHTML = (settings.pron || []).map((r, i) => `<li><span class="grow"><b>${esc(r.from)}</b> is said as <b>${esc(r.to)}</b></span><button class="btn danger iconbtn" data-pdel="${i}" aria-label="Delete">✕</button></li>`).join("") || `<li class="muted small">No fixes yet.</li>`;
    };
    drawPron();
    $("#pronList").onclick = e => { const b = e.target.closest("[data-pdel]"); if (b) { settings.pron.splice(+b.dataset.pdel, 1); saveSettings(); drawPron(); } };
    $("#pAdd").onclick = () => { const f = $("#pFrom").value.trim(), t = $("#pTo").value.trim(); if (!f || !t) return; settings.pron = [...(settings.pron || []).filter(r => r.from.toLowerCase() !== f.toLowerCase()), { from: f, to: t }]; saveSettings(); $("#pFrom").value = $("#pTo").value = ""; drawPron(); };
    $("#pTest").onclick = () => { const f = $("#pFrom").value.trim(), t = $("#pTo").value.trim(); Voice.speak(t || f || "Type a word first."); };
    return;
  }
  if (sub === "card") {
    view().innerHTML = back + `
      <p class="muted">Shown in big letters when you need it. Kept on this device only.</p>
      <label class="field"><span>Your name</span><input type="text" id="iName" value="${esc(info.name)}"></label>
      <label class="field"><span>Message</span><textarea id="iNote" rows="3">${esc(info.note)}</textarea></label>
      <label class="field"><span>Emergency contact (name and number)</span><input type="text" id="iContact" value="${esc(info.contact)}"></label>
      <button class="btn primary" id="iShow">Show my card</button>`;
    wireBack();
    const keep = () => { info = { name: $("#iName").value.trim(), note: $("#iNote").value.trim(), contact: $("#iContact").value.trim() }; store.set("info", info); };
    ["iName", "iNote", "iContact"].forEach(id => { $("#" + id).onchange = keep; });
    $("#iShow").onclick = () => { keep(); showCard([info.name, info.note, info.contact && "Emergency contact: " + info.contact].filter(Boolean).join("\n\n")); };
    return;
  }
  if (sub === "boost") {
    const draw = () => { view().innerHTML = back + Boost.html(true); wireBack(); Boost.wire(view(), true, draw); };
    draw();
    view().onclick = e => { const b = e.target.closest("[data-sub]"); if (b) location.hash = "more/" + b.dataset.sub; };
    return;
  }
  if (sub === "setup") { renderSoundSetup(); return; }
  if (sub === "diary") { renderDiary(back, wireBack); return; }
  if (sub === "alerts") { renderAlerts(back, wireBack); return; }
  if (sub === "manual") {
    const secs = manualSections();
    view().innerHTML = back + `<h2>How to use OtoHearSay</h2>
      <input type="search" id="mq" placeholder="Search the manual" aria-label="Search the manual" style="margin-bottom:10px">
      <div id="mlist">${secs.map(([id, t, body]) => `<details class="box msec" id="m-${id}"><summary><b>${t}</b></summary><div class="mbody">${body}</div></details>`).join("")}</div>`;
    wireBack();
    $("#mq").oninput = e => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll(".msec").forEach(d => { const hit = !q || d.textContent.toLowerCase().includes(q); d.hidden = !hit; d.open = !!q && hit; });
    };
    if (location.hash.split("/")[2]) { const d = $("#m-" + location.hash.split("/")[2]); if (d) { d.open = true; d.scrollIntoView(); } }
    return;
  }
  if (sub === "calls") {
    view().innerHTML = back + `
      <h2>Captions on phone calls</h2>
      <p><b>No app can hear phone calls.</b> Android and iPhone keep calls private from every app, so OtoHearSay cannot caption a call, even on speaker. Your phone's own <b>Live Caption</b> can, for free.</p>
      <p class="small muted">Live Caption shows the <i>other</i> person's words, not yours; that is normal. It works best on a clear connection (Wi-Fi calling helps) and when the other person talks a little slower.</p>
      <div class="box"><h2>Google Pixel</h2><p>Open <b>Settings</b>, tap <b>Accessibility</b>, then <b>Live Caption</b>. Turn on <b>Live Caption</b> and <b>Caption calls</b>. You can also press a volume button and tap the caption icon under the volume bar.</p></div>
      <div class="box"><h2>Samsung Galaxy</h2><p>Open <b>Settings</b>, tap <b>Accessibility</b>, then <b>Hearing enhancements</b>, then <b>Live Caption</b>, and turn it on (if you see <b>Caption calls</b>, turn that on too). During a call you can also press a volume button and tap the caption icon. Menu names can differ a little between models.</p></div>
      <div class="box"><h2>If Live Caption misses too much</h2><p>In the United States, people with hearing loss can get free phone captioning services, paid for by a federal program: an app gives you a phone number whose calls are captioned, often more accurately than Live Caption. Search the Play Store for "captioned telephone" or ask your audiologist. (They are separate services, not part of OtoHearSay.)</p></div>
      <div class="box"><h2>iPhone</h2><p>Open <b>Settings</b>, tap <b>Accessibility</b>, then <b>Live Captions</b>.</p></div>
      ${native ? `<button class="btn primary" id="openAcc">Open Accessibility settings</button>` : ""}`;
    wireBack();
    if (native) $("#openAcc").onclick = () => native.openAccessibilitySettings();
    return;
  }
  if (sub === "practice") { renderPractice(); return; }
  if (sub === "remote") {
    const st = native && native.shareStatus ? native.shareStatus() : "";
    const sharing = st ? JSON.parse(st) : null;
    view().innerHTML = back + `
      <h2>Remote microphone</h2>
      <p>Put one phone near the person talking (a teacher, a pastor, a doctor), or near the TV or a sleeping baby in another room, and read the captions on another phone, a tablet or a computer. The other device can also play the sound. Both must be on the same Wi-Fi. Nothing goes over the internet.</p>
      ${native ? `<div class="box">
        <h2>This phone is the microphone</h2>
        ${sharing ? `<p>Sharing captions. On the other device open OtoHearSay, More, Remote microphone, and enter:</p>
          <p style="font-size:1.6rem"><b>${esc(sharing.address)}</b> · code <b>${esc(sharing.code)}</b></p>
          <p class="muted small">Or open <b>http://${esc(sharing.address)}/?code=${esc(sharing.code)}</b> in any web browser on the same Wi-Fi.</p>
          <button class="btn danger" id="shStop">Stop sharing</button>`
        : `<button class="btn primary" id="shStart">Share this phone's captions</button>`}
      </div>` : ""}
      <div class="box">
        <h2>Show captions from another phone</h2>
        ${Remote.es ? `<p>Showing captions from <b>${esc(Remote.addr)}</b> on the Talk screen.</p>
          <label class="row" style="margin-bottom:12px"><input type="checkbox" id="rmSound" ${RemoteSound.on ? "checked" : ""} style="width:auto;min-height:auto"> Play the sound from that phone too (use headphones). It uses your Sound boost loudness, tone and each-ear levels.</label>
          <button class="btn" id="rmStop">Disconnect</button>` : `
        <div class="row"><input type="text" id="rmAddr" placeholder="Address, for example 192.168.1.20:8737" value="${esc(store.get("remoteAddr", ""))}" style="flex:2;min-width:180px">
        <input type="text" id="rmCode" placeholder="Code" inputmode="numeric" style="flex:1;min-width:90px">
        <button class="btn primary" id="rmGo">Connect</button></div>`}
        ${!native && location.protocol === "https:" ? `<p class="muted small">In a web browser, the easiest way is to open the address the sharing phone shows (it starts with http://).</p>` : ""}
      </div>`;
    wireBack();
    if ($("#shStart")) $("#shStart").onclick = () => {
      const r = native.startShare();
      if (!r) { toast("Connect this phone to Wi-Fi first."); return; }
      if (!listening) Listener.start();
      renderMore("remote");
    };
    if ($("#shStop")) $("#shStop").onclick = () => { native.stopShare(); renderMore("remote"); };
    if ($("#rmGo")) $("#rmGo").onclick = () => { const a = $("#rmAddr").value, c = $("#rmCode").value; if (!a || !c) { toast("Enter the address and the code shown on the sharing phone."); return; } Remote.connect(a, c); location.hash = "talk"; };
    if ($("#rmStop")) $("#rmStop").onclick = () => { Remote.disconnect(); renderMore("remote"); };
    if ($("#rmSound")) $("#rmSound").onchange = e => { if (e.target.checked) RemoteSound.start(Remote.addr, Remote.code); else RemoteSound.stop(); };
    return;
  }
  if (sub === "sync") {
    // sync.js loads after this file: opening the app straight on this screen waits for it
    if (typeof Sync === "undefined") { view().innerHTML = back; setTimeout(() => renderMore("sync"), 0); return; }
    const on = Sync.on();
    view().innerHTML = back + `
      <h2>Sync across devices</h2>
      <p>Sign in with the same Google account on each phone, tablet, the web version and the computer. Talks, quick phrases,
        your info card, alert words, settings, the listening diary and practice progress then stay the same everywhere. Add or
        delete something on one device and the others follow within a minute or so of opening the app.</p>
      <p class="small" id="syncState">${Sync.statusHtml()}</p>
      <div class="row" style="margin-bottom:12px">
        ${on ? `<button class="btn primary" id="syNow">Sync now</button><button class="btn" id="syOff">Stop syncing on this device</button>`
          : `<button class="btn primary" id="syOn">Sign in to Google Drive and sync</button>`}
      </div>
      <p class="muted small">Your data goes only to your own Google Drive, in a folder named <b>OtoHearSay</b> (file OtoHearSay-sync.json).
        OtoHearSay can see only the files it made there, nothing else in your Drive. Changes on two devices are combined, item by item; the newest change wins.
        Some settings stay on each device: sound boost and places, the speech engine, keeping sound, and the daily backup. Kept sound of talks is not synced (too big).
        ${GooglePass.native() ? "" : "In a browser Google's sign-in lasts about an hour; after that the next tap renews it (a Google window may flash)."}</p>`;
    wireBack();
    if ($("#syOn")) $("#syOn").onclick = () => Sync.connect();
    if ($("#syNow")) $("#syNow").onclick = () => Sync.run(true);
    if ($("#syOff")) $("#syOff").onclick = () => { Sync.disconnect(); renderMore("sync"); };
    return;
  }
  if (sub === "backup") {
    const last = Backup.last();
    view().innerHTML = back + `
      <h2>Backup and restore</h2>
      <p>One backup file keeps your talks, phrases, info card and settings. ${files ? "When the save screen opens, choose <b>Google Drive</b> or <b>OneDrive</b> (their apps must be on this phone) or a folder on the phone." : "On a computer, save it in your Google Drive or OneDrive folder."}</p>
      <p class="small" id="bkLast">${last ? `Last backup: <b>${esc(fmtDate(last.t))}</b> to <b>${esc(last.where || "a file")}</b>` : "No backup yet."}</p>
      <div class="row" style="margin-bottom:12px">
        <button class="btn primary" id="bkNow">Back up now</button>
        ${files && files.target() ? `<button class="btn" id="bkNew">Choose a new place</button>` : ""}
        <button class="btn" id="bkOpen">Restore from a backup file</button>
      </div>
      ${files ? `<label class="row"><input type="checkbox" id="bkAuto" ${settings.autoBackup ? "checked" : ""} style="width:auto;min-height:auto"> Back up automatically once a day to the same place</label>` : ""}
      <p class="muted small" style="margin-top:12px">${files ? "Android also copies OtoHearSay's data to your Google account backup, so a new phone signed in to the same account usually brings it back by itself. The backup file is the sure way." : "The phone and tablet app can back up automatically every day."}</p>`;
    wireBack();
    $("#bkNow").onclick = () => Backup.save(false);
    if ($("#bkNew")) $("#bkNew").onclick = () => Backup.save(true);
    $("#bkOpen").onclick = () => Backup.open();
    if ($("#bkAuto")) $("#bkAuto").onchange = e => { settings.autoBackup = e.target.checked; saveSettings(); if (settings.autoBackup && !files.target()) Backup.save(true); };
    return;
  }
  if (sub === "restore") {
    const d = pendingRestore;
    if (!d) { location.hash = "more/backup"; return; }
    const talks = d.sessions.filter(x => x.lines?.length).length;
    view().innerHTML = back + `
      <h2>Restore this backup?</h2>
      <p>Saved <b>${esc(fmtDate(d.savedAt || Date.now()))}</b> with <b>${talks}</b> ${talks === 1 ? "talk" : "talks"}.</p>
      <p class="muted">Talks in the backup are added to the ones on this device (nothing is deleted). Settings, phrases and your info card are replaced with the backup's.</p>
      <div class="row"><button class="btn primary" id="rsYes">Restore</button><button class="btn" id="rsNo">Cancel</button></div>`;
    wireBack();
    $("#rsYes").onclick = () => { Backup.restore(d); pendingRestore = null; toast("Restored."); location.hash = "history"; };
    $("#rsNo").onclick = () => { pendingRestore = null; location.hash = "more/backup"; };
    return;
  }
  if (sub === "about") {
    view().innerHTML = back + `
      <h2>OtoHearSay ${APP_VERSION}</h2>
      <p>Live captions of nearby speech, type to talk, and read text aloud. Your talks, phrases and card stay on this device.</p>
      <p class="muted">Captions are made by a computer and can contain mistakes. OtoHearSay is an accessibility tool, not a medical device.</p>
      <p class="muted small">${native || Listener.useEngine() ? "Captions are made on this device by a speech engine built into the app. What people say is never sent anywhere. In a browser the engine (about 79 MB) downloads once, then works offline." : "This browser cannot run the built-in engine, so captions use the browser's own speech recognition, which may send audio to the browser maker's servers. The phone and tablet app keeps everything on the device."}</p>
      <div class="box">
        <h2>Speech engine on this device</h2>
        <p class="small">Listening with: <b>${esc(Listener.name())}</b></p>
        <p class="small">Works without internet: <b>${native ? (Listener.name().includes("private") ? "Yes" : "Depends on your phone's speech service") : Listener.useEngine() ? "Yes, after the one-time download" : "No"}</b></p>
        <p class="small">Size: <b>about 80 MB</b> (English speech model 72 MB, punctuation model 7.5 MB)</p>
      </div>
      ${native && native.checkUpdate ? `<p><button class="btn" id="chkUpd">Check for updates</button></p>` : ""}
      <h2>Credits</h2>
      <ul class="list">
        <li><span class="grow"><b>sherpa-onnx</b> speech engine by the k2-fsa project, built without its text-to-speech part. Apache License 2.0.</span></li>
        <li><span class="grow"><b>ONNX Runtime</b> by Microsoft. MIT License.</span></li>
        <li><span class="grow"><b>Streaming Zipformer English model</b> (sherpa-onnx-streaming-zipformer-en-2023-06-26) by the k2-fsa / icefall project. Apache License 2.0.</span></li>
        <li><span class="grow"><b>Edge-Punct-Casing</b> punctuation and capitals model by Frank You. Apache License 2.0.</span></li>
        <li><span class="grow"><b>Audio-tagging Zipformer</b> (sherpa-onnx-zipformer-small-audio-tagging-2024-04-15) by the k2-fsa / icefall project, trained on AudioSet, used for sound alerts in the Android app. Apache License 2.0.</span></li>
        <li><span class="grow"><b>AndroidX WebKit</b> (Android app). Apache License 2.0.</span></li>
        <li><span class="grow"><b>Google Play services sign-in</b> (Android app, for Sync across devices) and <b>Google ML Kit text recognition</b> (Android app, reading a page from a photo). Google's Android SDK terms.</span></li>
        <li><span class="grow"><b>Google Identity Services</b> (web version, Google sign-in for Sync across devices), loaded from Google when you sign in. Google's terms.</span></li>
      </ul>
      <p class="muted small" style="margin-top:12px">© 2026 Michael's Crossing LLC.</p>`;
    wireBack();
    if ($("#chkUpd")) $("#chkUpd").onclick = () => { toast("Checking for updates..."); native.checkUpdate(true); };
    return;
  }
  view().innerHTML = `
    <ul class="list">
      <li><button class="link grow" data-sub="manual"><b>📖 How to use OtoHearSay</b><br><span class="muted small">The manual: every feature, step by step, and moving to a new phone</span></button></li>
      <li><button class="link grow" data-sub="settings"><b>Settings</b><br><span class="muted small">Look, caption size, voice speed, language, alert words</span></button></li>
      ${Boost.available() ? `<li><button class="link grow" data-sub="boost"><b>🎧 Sound boost</b><br><span class="muted small">Louder, clearer sound in your headphones while captions run; places, tone, each ear</span></button></li>` : ""}
      ${SoundAlerts.available() ? `<li><button class="link grow" data-sub="alerts"><b>🔔 Sound alerts</b><br><span class="muted small">A flash, a buzz and a word for a doorbell, an alarm, a baby crying or a phone ringing</span></button></li>` : ""}
      <li><button class="link grow" data-sub="diary"><b>Listening diary</b><br><span class="muted small">How long you listened this week, and where</span></button></li>
      <li><button class="link grow" data-sub="card"><b>My info card</b><br><span class="muted small">Your name, a message, and an emergency contact in big letters</span></button></li>
      <li><button class="link grow" data-sub="practice"><b>Listening practice</b><br><span class="muted small">Hear a word, pick what you heard; words you miss come back more often</span></button></li>
      <li><button class="link grow" data-sub="remote"><b>Remote microphone</b><br><span class="muted small">Use a second phone or tablet near the speaker, over Wi-Fi</span></button></li>
      <li><button class="link grow" data-sub="sync"><b>🔄 Sync across devices</b><br><span class="muted small">${typeof Sync !== "undefined" && Sync.on() ? "On: your phones, the web and the computer share the same data" : "Keep phones, web and computer the same through your Google Drive"}</span></button></li>
      <li><button class="link grow" data-sub="backup"><b>Backup and restore</b><br><span class="muted small">Save everything to Google Drive, OneDrive or a file, and bring it back on a new phone</span></button></li>
      <li><button class="link grow" data-sub="calls"><b>Captions on phone calls</b><br><span class="muted small">Turn on your phone's free call captions</span></button></li>
      <li><button class="link grow" data-sub="about"><b>About and credits</b></button></li>
    </ul>
`;
  view().onclick = e => { const b = e.target.closest("[data-sub]"); if (b) location.hash = "more/" + b.dataset.sub; };
}

// ---------- sound boost: the microphone played into headphones, louder and clearer, while captions run ----------
// Android does the sound work in Kotlin (SoundBoost.kt); a browser does the same steps with Web Audio. Both read the
// same settings. Nothing is recorded or sent anywhere. It is a sound amplifier for situations, not a medical device.
const BOOST_DEFAULT = { on: false, gain: 12, noise: 1, low: 0, mid: 0, high: 0, left: 0, right: 0, focus: false, background: 40, limit: 1, mic: "auto", place: "" };
// One tap sets the sound for a place. "Save my settings here" replaces a preset with the user's own (and the caption size).
const PLACES = [
  ["quiet", "Quiet room", { gain: 9, noise: 0, low: 0, mid: 0, high: 2, focus: false, background: 40 }],
  ["restaurant", "Restaurant", { gain: 12, noise: 2, low: -6, mid: 3, high: 3, focus: true, background: 25 }],
  ["church", "Church", { gain: 18, noise: 1, low: -3, mid: 3, high: 4, focus: false, background: 40 }],
  ["class", "Class", { gain: 18, noise: 1, low: -3, mid: 3, high: 3, focus: false, background: 40 }],
  ["tv", "TV", { gain: 12, noise: 1, low: -2, mid: 2, high: 4, focus: false, background: 40 }],
  ["car", "Car", { gain: 9, noise: 2, low: -9, mid: 3, high: 2, focus: true, background: 35 }],
];
const placeName = id => (PLACES.find(p => p[0] === id) || [0, ""])[1];
const Boost = {
  warned: false, state: "",
  cfg() { return { ...BOOST_DEFAULT, ...(settings.boost || {}) }; },
  available() { return native ? !!native.setBoost : WebEngine.supported(); },
  set(patch) {
    const c = { ...this.cfg(), ...patch };
    // changing the sound by hand means it is no longer the chosen place's sound
    if (!("place" in patch) && Object.keys(patch).some(k => !["on", "mic", "limit", "left", "right"].includes(k))) c.place = "";
    const micChanged = c.mic !== this.cfg().mic;
    settings.boost = c; saveSettings();
    if (micChanged && !native && listening && Listener.mode === "engine") { Listener.stop(); setTimeout(() => Listener.start(), 300); }
  },
  push() {
    const c = this.cfg();
    if (native) { if (native.setBoost) try { native.setBoost(JSON.stringify(c)); } catch { } }
    else WebBoost.update();
    if (!c.on) this.state = "";
    this.pill();
  },
  info() {
    if (native) { try { return JSON.parse(native.boostInfo()); } catch { return { works: false }; } }
    return { works: Listener.useEngine(), headphones: null, bluetooth: false, headsetMic: false };
  },
  usePlace(id) {
    const p = PLACES.find(x => x[0] === id); if (!p) return;
    const { capSize, ...snd } = (settings.places || {})[id] || p[2];
    const c = this.cfg();
    settings.boost = { ...c, ...snd, place: id };
    if (capSize) settings.capSize = capSize;
    saveSettings();
  },
  savePlace(id) {
    const { on, place, limit, left, right, ...snd } = this.cfg();
    settings.places = { ...(settings.places || {}), [id]: { ...snd, capSize: settings.capSize } };
    settings.boost = { ...this.cfg(), place: id };
    saveSettings();
  },
  resetPlace(id) { const p = { ...(settings.places || {}) }; delete p[id]; settings.places = p; this.usePlace(id); },
  toggle(on) {
    if (on && !native && !this.warned) {
      if (!confirm("Put on headphones first.\n\nSound boost plays the microphone into your headphones. Through loudspeakers it would feed back into the microphone and squeal.\n\nAre your headphones on?")) return false;
      this.warned = true;
    }
    this.set({ on });
    if (!on) return true;
    const i = this.info();
    if (!i.works) toast("Sound boost works with the private speech engine and English. Choose it in More > Settings > Speech engine.");
    else if (native && !i.headphones) toast("Connect headphones (wired or Bluetooth). Sound boost never plays through the phone's speaker.");
    else if (!listening) toast("Sound boost is ready. Tap Listen to start.");
    return true;
  },
  pill() {
    const b = $("#boostBtn"); if (!b) return;
    const c = this.cfg();
    b.setAttribute("aria-pressed", c.on ? "true" : "false");
    b.classList.toggle("live", c.on && (this.state === "boost-on" || this.state === "boost-bluetooth"));
  },
  // the controls, used by the small panel on the Talk screen (full = false) and by More > Sound boost (full = true)
  html(full) {
    const c = this.cfg(), i = this.info();
    const rng = (id, label, min, max, val, unit = "") => `<label class="field"><span>${label}: <b id="${id}V">${val > 0 && min < 0 ? "+" : ""}${val}${unit}</b></span><input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${val}" style="width:100%"></label>`;
    return `
      <label class="row" style="margin-bottom:10px;font-size:1.05rem"><input type="checkbox" id="bOn" ${c.on ? "checked" : ""} style="width:auto;min-height:auto"> <b>Sound boost</b></label>
      <p class="muted small" style="margin:0 0 10px">Plays what the microphone hears into your headphones, louder and clearer, while the captions keep running. ${native ? "Headphones only: it never plays through the phone's speaker." : "Use headphones: loudspeakers would squeal."}</p>
      ${!i.works ? `<p class="small warnline">Sound boost needs the private speech engine and English (More > Settings).</p>` : ""}
      ${rng("bGain", "Louder by", 0, 30, c.gain, " dB")}
      <div class="chips wrap" id="bPlaces" role="group" aria-label="Places">${PLACES.map(([id, n]) => `<button class="chip" data-place="${id}" aria-pressed="${c.place === id}">${n}${(settings.places || {})[id] ? " ✎" : ""}</button>`).join("")}</div>
      <label class="row" style="margin:10px 0;flex-wrap:nowrap;align-items:flex-start"><input type="checkbox" id="bFocus" ${c.focus ? "checked" : ""} style="width:auto;min-height:auto;margin-top:4px"> <span>One-on-one: keep the nearest, loudest voice and turn the background down</span></label>
      ${full ? `
      <div id="bBackWrap" ${c.focus ? "" : "hidden"}>${rng("bBack", "Background kept in one-on-one", 0, 100, c.background, "%")}</div>
      <label class="field"><span>Noise reduction (steady hum, rumble and hiss)</span><select id="bNoise"><option value="0">Off</option><option value="1">Normal</option><option value="2">Strong</option></select></label>
      <div class="box"><h2>Tone</h2>
        ${rng("bLow", "Low sounds (rumble, deep voices)", -12, 12, c.low, " dB")}
        ${rng("bMid", "Middle sounds (most speech)", -12, 12, c.mid, " dB")}
        ${rng("bHigh", "High sounds (s, f, th, children's voices)", -12, 12, c.high, " dB")}
      </div>
      <div class="box"><h2>Each ear</h2>
        ${rng("bLeft", "Left ear", -24, 12, c.left, " dB")}
        ${rng("bRight", "Right ear", -24, 12, c.right, " dB")}
        <button class="btn" data-sub="setup">Sound setup: tune each ear with beeps</button>
      </div>
      <label class="field"><span>Loudness limit (sudden loud sounds are held under this)</span><select id="bLimit"><option value="0">Low (safest)</option><option value="1">Medium</option><option value="2">High</option></select></label>
      <label class="field"><span>Microphone</span><select id="bMic"></select></label>
      <div class="box"><h2>This place</h2>
        <p class="muted small">Tap a place above to use its sound. To make a place your own, set the sound and caption size the way you like, then save it here.</p>
        <div class="row"><select id="bSaveTo" style="flex:1;min-width:140px">${PLACES.map(([id, n]) => `<option value="${id}" ${c.place === id ? "selected" : ""}>${n}</option>`).join("")}</select>
        <button class="btn" id="bSave">Save my settings here</button><button class="btn" id="bReset">Back to the built-in sound</button></div>
      </div>
      <p class="muted small">Good to know: wired headphones keep the sound in step with people's lips; Bluetooth adds a short delay. Start low and turn up slowly. Loud sound for a long time can harm hearing. Sound boost is an amplifier for everyday situations, not a medical device, and it does not replace care from a hearing professional.</p>`
      : `<div class="row"><button class="btn" id="bAll">All sound settings</button><button class="btn primary" id="bClose">Close</button></div>`}`;
  },
  wire(root, full, redraw) {
    const q = id => root.querySelector("#" + id);
    q("bOn").onchange = e => { if (!this.toggle(e.target.checked)) e.target.checked = false; this.pill(); };
    const slide = (id, key, unit) => { const el = q(id); if (!el) return; el.oninput = () => { const v = +el.value; q(id + "V").textContent = (v > 0 && +el.min < 0 ? "+" : "") + v + unit; this.set({ [key]: v }); root.querySelectorAll("[data-place]").forEach(b => b.setAttribute("aria-pressed", "false")); }; };
    slide("bGain", "gain", " dB"); slide("bBack", "background", "%"); slide("bLow", "low", " dB"); slide("bMid", "mid", " dB"); slide("bHigh", "high", " dB");
    const ear = (id, key) => { const el = q(id); if (!el) return; el.oninput = () => { const v = +el.value; q(id + "V").textContent = (v > 0 ? "+" : "") + v + " dB"; this.set({ [key]: v }); }; };
    ear("bLeft", "left"); ear("bRight", "right");
    q("bPlaces").onclick = e => { const b = e.target.closest("[data-place]"); if (!b) return; this.usePlace(b.dataset.place); toast(placeName(b.dataset.place) + " sound is set."); redraw(); };
    q("bFocus").onchange = e => { this.set({ focus: e.target.checked }); redraw(); };
    if (!full) { q("bAll").onclick = () => { root.remove(); location.hash = "more/boost"; }; q("bClose").onclick = () => root.remove(); return; }
    q("bNoise").value = this.cfg().noise; q("bNoise").onchange = e => { this.set({ noise: +e.target.value }); redraw(); };
    q("bLimit").value = this.cfg().limit; q("bLimit").onchange = e => this.set({ limit: +e.target.value });
    q("bSave").onclick = () => { const id = q("bSaveTo").value; this.savePlace(id); toast("Saved as your " + placeName(id) + " sound."); redraw(); };
    q("bReset").onclick = () => { const id = q("bSaveTo").value; this.resetPlace(id); toast(placeName(id) + " is back to the built-in sound."); redraw(); };
    const mic = q("bMic"), cur = this.cfg().mic;
    const fill = list => { mic.innerHTML = list.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join(""); mic.value = list.some(l => l[0] === cur) ? cur : "auto"; };
    if (native) fill([["auto", "Automatic"], ["phone", "This phone's microphone"], ["headset", "Wired or USB headset microphone" + (this.info().headsetMic ? "" : " (none plugged in)")]]);
    else {
      fill([["auto", "Automatic"]]);
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) navigator.mediaDevices.enumerateDevices().then(ds => {
        const ins = ds.filter(d => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.label);
        fill([["auto", "Automatic"], ...ins.map(d => [d.deviceId, d.label])]);
      }).catch(() => { });
    }
    mic.onchange = () => this.set({ mic: mic.value });
  },
  sheet() {
    let d = $("#boostSheet"); if (d) { d.remove(); return; }
    d = document.createElement("div"); d.id = "boostSheet"; d.className = "box callnote boostsheet";
    const draw = () => { d.innerHTML = this.html(false); this.wire(d, false, draw); };
    draw(); document.body.appendChild(d);
  },
};
OtoEvents.on("engineStatus", st => {
  if (!/^boost-/.test(st || "")) return;
  const was = Boost.state; Boost.state = st; Boost.pill();
  if (st === was) return;
  if (st === "boost-headphones") toast("Sound boost is waiting for headphones. Nothing is played through the phone's speaker.");
  if (st === "boost-bluetooth") toast("Sound boost is on. Bluetooth adds a short delay; wired headphones keep the sound in step with lips.");
  if (st === "boost-on") toast("Sound boost is on.");
  if (st === "boost-failed") toast("Sound boost could not start on this device. Captions keep running.");
});
OtoEvents.on("listenState", on => { if (!on) { Boost.state = ""; Boost.pill(); } });

// The browser's version of the same sound chain: filters, a gate for background sound, a gain for each ear and a limiter.
const WebBoost = {
  ctx: null, src: null, n: null, timer: 0,
  attach(ctx, src) { this.ctx = ctx; this.src = src; this.update(); },
  detach() { this.teardown(); this.ctx = this.src = null; },
  teardown() {
    clearInterval(this.timer);
    if (!this.n) return;
    try { this.src.disconnect(this.n.hp); } catch { }
    Object.values(this.n).forEach(x => { try { x.disconnect(); } catch { } });
    this.n = null;
  },
  update() {
    const c = Boost.cfg(), ctx = this.ctx;
    if (!ctx || !this.src || !c.on) { this.teardown(); return; }
    if (!this.n) {
      const f = type => { const b = ctx.createBiquadFilter(); b.type = type; return b; };
      const n = { hp: f("highpass"), lo: f("lowshelf"), md: f("peaking"), hi: f("highshelf"), lp: f("lowpass"), pk: f("peaking"),
        tap: ctx.createAnalyser(), gate: ctx.createGain(), l: ctx.createGain(), r: ctx.createGain(), merge: ctx.createChannelMerger(2), lim: ctx.createDynamicsCompressor() };
      n.tap.fftSize = 512;
      this.src.connect(n.hp); n.hp.connect(n.lo); n.lo.connect(n.md); n.md.connect(n.hi); n.hi.connect(n.lp); n.lp.connect(n.pk);
      n.pk.connect(n.tap); n.pk.connect(n.gate); n.gate.connect(n.l); n.gate.connect(n.r);
      n.l.connect(n.merge, 0, 0); n.r.connect(n.merge, 0, 1); n.merge.connect(n.lim); n.lim.connect(ctx.destination);
      this.n = n;
      const buf = new Float32Array(512); let floor = 0.001, peak = 0;
      this.timer = setInterval(() => {
        if (!this.n) return;
        const k = Boost.cfg();
        n.tap.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const env = Math.sqrt(s / buf.length);
        floor = env < floor ? floor + (env - floor) * 0.5 : floor * 1.0023 + 1e-9;
        peak = env > peak ? env : peak * 0.993;
        let want = 1;
        if (k.focus || k.noise > 0) {
          const depth = k.focus ? Math.pow(10, -(100 - k.background) * 0.26 / 20) : [1, 0.45, 0.2][k.noise];
          const thr = k.focus ? Math.max(floor * 3, peak * 0.3) : floor * (k.noise === 2 ? 3 : 2);
          want = env >= thr || thr <= 0 ? 1 : Math.max(depth, env / thr);
        }
        n.gate.gain.setTargetAtTime(want, ctx.currentTime, 0.02);
      }, 20);
      OtoEvents.emit("engineStatus", "boost-on");
    }
    const n = this.n, t = ctx.currentTime, db = v => Math.pow(10, v / 20);
    n.hp.frequency.value = c.focus ? 280 : [70, 140, 220][c.noise];
    n.lo.frequency.value = 250; n.lo.gain.value = c.low;
    n.md.frequency.value = 1500; n.md.Q.value = 0.9; n.md.gain.value = c.mid;
    n.hi.frequency.value = 4000; n.hi.gain.value = c.high;
    n.lp.frequency.value = c.focus ? 4500 : 12000;
    n.pk.frequency.value = 2200; n.pk.Q.value = 0.8; n.pk.gain.value = c.focus ? 4 : 0;
    n.l.gain.setTargetAtTime(db(c.gain + c.left), t, 0.03); n.r.gain.setTargetAtTime(db(c.gain + c.right), t, 0.03);
    n.lim.threshold.value = [-20, -12, -5][c.limit]; n.lim.knee.value = 0; n.lim.ratio.value = 20; n.lim.attack.value = 0.002; n.lim.release.value = 0.1;
  },
};

// ---------- sound setup: beeps in each ear set the left/right levels and the tone ----------
// The user slides each beep down until it can only just be heard. Ears or headphones that need a beep louder get a
// little more boost there (half of the difference). It tunes Sound boost to these headphones and ears; it measures nothing medical.
const SoundSetup = {
  ctx: null, osc: null, gain: null, timer: 0, FREQS: [500, 1000, 2000, 4000],
  stop() {
    clearInterval(this.timer);
    try { this.osc && this.osc.stop(); } catch { }
    if (this.ctx) this.ctx.close().catch(() => { });
    this.ctx = this.osc = this.gain = null;
  },
  tone(freq, ear, db) {
    this.stop();
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
    const ctx = this.ctx = new AC(), osc = this.osc = ctx.createOscillator(), g = this.gain = ctx.createGain();
    osc.frequency.value = freq; g.gain.value = 0;
    const merge = ctx.createChannelMerger(2);
    osc.connect(g); g.connect(merge, 0, ear === "left" ? 0 : 1); merge.connect(ctx.destination);
    osc.start(); this.level = db; let onNow = false;
    this.timer = setInterval(() => { onNow = !onNow; g.gain.setTargetAtTime(onNow ? Math.pow(10, this.level / 20) : 0, ctx.currentTime, 0.02); }, 350);
    return true;
  },
  result(lv) {
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length, clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v)));
    const mL = mean(lv.left), mR = mean(lv.right);
    const avg = this.FREQS.map((_, i) => (lv.left[i] + lv.right[i]) / 2);
    return { left: clamp(Math.max(0, mL - mR) / 2, 0, 12), right: clamp(Math.max(0, mR - mL) / 2, 0, 12),
      low: clamp((avg[0] - avg[1]) / 2, -6, 9), mid: 0, high: clamp(((avg[2] + avg[3]) / 2 - avg[1]) / 2, -6, 12) };
  },
};
function renderSoundSetup(step = -1, lv = { left: [], right: [] }) {
  const back = `<button class="btn" id="back" style="margin-bottom:12px">‹ Sound boost</button>`;
  const leave = () => { SoundSetup.stop(); location.hash = "more/boost"; };
  const total = SoundSetup.FREQS.length * 2;
  if (step < 0) {
    view().innerHTML = back + `<h2>Sound setup</h2>
      <p>This tunes Sound boost to your headphones and your two ears. You will hear soft beeps, first in the left ear and then in the right. For each one, slide down until you can <b>only just</b> hear it.</p>
      <ol><li>Sit somewhere quiet and put your headphones on the right way round.</li><li>Set the device's volume to about the middle and leave it there.</li><li>It takes about two minutes.</li></ol>
      <p class="muted small">This is not a hearing test. It does not measure or check your hearing, and it cannot find or rule out a hearing problem. If you are worried about your hearing, see a hearing professional.</p>
      <button class="btn primary" id="ssGo">Start</button>`;
    $("#back").onclick = leave; $("#ssGo").onclick = () => renderSoundSetup(0, lv);
    return;
  }
  if (step >= total) {
    SoundSetup.stop();
    const r = SoundSetup.result(lv), sg = v => (v > 0 ? "+" : "") + v + " dB";
    view().innerHTML = back + `<h2>Sound setup: result</h2>
      <ul class="list"><li><span class="grow">Left ear: <b>${sg(r.left)}</b></span></li><li><span class="grow">Right ear: <b>${sg(r.right)}</b></span></li>
      <li><span class="grow">Low sounds: <b>${sg(r.low)}</b></span></li><li><span class="grow">High sounds: <b>${sg(r.high)}</b></span></li></ul>
      <p class="muted small" style="margin-top:10px">These settings make Sound boost more comfortable with these headphones. They say nothing medical about your hearing. You can change them by hand at any time.</p>
      <div class="row"><button class="btn primary" id="ssUse">Use these settings</button><button class="btn" id="ssNo">Do not change anything</button></div>`;
    $("#back").onclick = leave; $("#ssNo").onclick = leave;
    $("#ssUse").onclick = () => { Boost.set({ ...r }); toast("Sound boost is tuned to your headphones."); leave(); };
    return;
  }
  const ear = step < SoundSetup.FREQS.length ? "left" : "right", fi = step % SoundSetup.FREQS.length, freq = SoundSetup.FREQS[fi];
  const names = ["a low beep", "a middle beep", "a higher beep", "a high beep"];
  view().innerHTML = back + `<h2>${ear === "left" ? "Left" : "Right"} ear: ${names[fi]}</h2>
    <p class="muted">Step ${step + 1} of ${total}. Slide down until you can only just hear the beeps in your <b>${ear}</b> ear.</p>
    <label class="field"><span>Beep loudness</span><input type="range" id="ssLv" min="-80" max="-10" step="1" value="-40" style="width:100%"></label>
    <div class="row"><button class="btn primary" id="ssNext">I can only just hear it</button><button class="btn" id="ssNone">I cannot hear it at all</button></div>`;
  if (!SoundSetup.tone(freq, ear, -40)) { toast("This device cannot play the beeps."); leave(); return; }
  $("#ssLv").oninput = e => { SoundSetup.level = +e.target.value; };
  const next = v => { lv[ear][fi] = v; renderSoundSetup(step + 1, lv); };
  $("#ssNext").onclick = () => next(SoundSetup.level);
  $("#ssNone").onclick = () => next(-10);
  $("#back").onclick = leave;
}

// ---------- listening diary: how long the app listened each day, and where ----------
const Diary = {
  since: 0, place: "",
  day(t = Date.now()) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
  mark(on) {
    if (on) { if (!this.since) { this.since = Date.now(); const c = Boost.cfg(); this.place = c.on ? c.place : ""; } return; }
    if (!this.since) return;
    const secs = Math.round((Date.now() - this.since) / 1000); this.since = 0;
    if (secs < 5) return;
    const log = store.get("diary", []), d = this.day();
    const row = log.find(r => r.d === d && r.p === this.place && (!r.dev || r.dev === deviceId)); // rows from other devices come by sync
    if (row) row.s += secs; else log.push({ d, p: this.place, s: secs });
    store.set("diary", log.slice(-800));
  },
  week(offset) { // offset 0 = the last 7 days, 1 = the 7 days before
    const end = Date.now() - offset * 7 * 86400000, days = new Set();
    for (let i = 0; i < 7; i++) days.add(this.day(end - i * 86400000));
    const sum = {};
    store.get("diary", []).forEach(r => { if (days.has(r.d)) sum[r.p] = (sum[r.p] || 0) + r.s; });
    return sum;
  },
  fmt(s) { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; },
};
OtoEvents.on("listenState", on => Diary.mark(!!on));
window.addEventListener("pagehide", () => Diary.mark(false));
function renderDiary(back, wireBack) {
  const block = (title, sum) => {
    const keys = Object.keys(sum).sort((a, b) => sum[b] - sum[a]), total = keys.reduce((t, k) => t + sum[k], 0);
    return `<div class="box"><h2>${title}: ${total ? Diary.fmt(total) : "nothing yet"}</h2>${keys.length ? `<ul class="list">${keys.map(k => `<li><span class="grow">${esc(placeName(k) || "Talks")}</span><b>${Diary.fmt(sum[k])}</b></li>`).join("")}</ul>` : ""}</div>`;
  };
  view().innerHTML = back + `<h2>Listening diary</h2>
    <p class="muted small">How long OtoHearSay listened, by the place chosen in Sound boost. Kept on this device only.</p>
    ${block("Last 7 days", Diary.week(0))}${block("The 7 days before", Diary.week(1))}
    <button class="btn" id="dyClear">Clear the diary</button>`;
  wireBack();
  $("#dyClear").onclick = () => { store.set("diary", []); renderDiary(back, wireBack); };
}

// ---------- shared sound output: the Sound boost tone, loudness and each-ear levels for played-back sound ----------
// Used for sound arriving from the remote microphone and for "Louder" in a saved talk's player.
function boostOut(ctx) {
  const c = Boost.cfg(), db = v => Math.pow(10, v / 20);
  const f = (type, freq, gain) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = freq; b.gain.value = gain; return b; };
  const lo = f("lowshelf", 250, c.low), md = f("peaking", 1500, c.mid), hi = f("highshelf", 4000, c.high);
  const l = ctx.createGain(), r = ctx.createGain(), merge = ctx.createChannelMerger(2), lim = ctx.createDynamicsCompressor();
  l.gain.value = db(c.gain + c.left); r.gain.value = db(c.gain + c.right);
  lim.threshold.value = [-20, -12, -5][c.limit]; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
  lo.connect(md); md.connect(hi); hi.connect(l); hi.connect(r); l.connect(merge, 0, 0); r.connect(merge, 0, 1); merge.connect(lim); lim.connect(ctx.destination);
  return lo;
}
// 16 kHz mono samples as a WAV file (kept sound of a captioned recording in the browser)
function wavBlob(samples, rate = 16000) {
  const n = samples.length, dv = new DataView(new ArrayBuffer(44 + n * 2)), put = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  put(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); put(8, "WAVEfmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Blob([dv.buffer], { type: "audio/wav" });
}

// ---------- sound from the remote microphone: hear the other room as well as read it ----------
const RemoteSound = {
  ctx: null, ctl: null, on: false,
  async start(addr, code) {
    this.stop();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !window.ReadableStream) { toast("This device cannot play the sound from the other phone."); return; }
    const ctx = this.ctx = new AC(), out = boostOut(ctx), ctl = this.ctl = new AbortController();
    this.on = true;
    try {
      const res = await fetch(`http://${addr}/audio?code=${encodeURIComponent(code)}`, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error("no sound");
      const rd = res.body.getReader(); let next = 0, carry = null;
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        let v = value;
        if (carry) { const m = new Uint8Array(v.length + 1); m[0] = carry[0]; m.set(v, 1); v = m; carry = null; }
        const n = v.length >> 1; if (v.length & 1) carry = v.slice(-1); if (!n) continue;
        const buf = ctx.createBuffer(1, n, 16000), ch = buf.getChannelData(0), dv = new DataView(v.buffer, v.byteOffset, n * 2);
        for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
        const t = ctx.currentTime; if (next < t + 0.05 || next > t + 1.2) next = t + 0.2; // keep about a fifth of a second in hand
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(out); src.start(next); next += n / 16000;
      }
    } catch { }
    if (this.ctx === ctx) { if (this.on && !ctl.signal.aborted) toast("The sound from the other phone stopped."); this.stop(); }
  },
  stop() {
    this.on = false;
    if (this.ctl) { try { this.ctl.abort(); } catch { } this.ctl = null; }
    if (this.ctx) { this.ctx.close().catch(() => { }); this.ctx = null; }
  },
};

// ---------- sound alerts: a doorbell, an alarm, a baby crying or a phone ringing shows as a flash, a buzz and a word ----------
const ALERT_KINDS = [["door", "Doorbell or a knock", "🔔 Doorbell or knock"], ["alarm", "Smoke or fire alarm, siren", "🚨 An alarm is sounding"], ["baby", "Baby crying", "👶 Baby crying"], ["phone", "Phone ringing", "📞 Phone ringing"]];
const SoundAlerts = {
  available() { return !!(native && native.setSoundAlerts); },
  cfg() { return { on: false, door: true, alarm: true, baby: true, phone: true, more: false, ...(settings.alerts || {}) }; },
  set(patch) { settings.alerts = { ...this.cfg(), ...patch }; saveSettings(); },
  push() { if (this.available()) try { native.setSoundAlerts(JSON.stringify(this.cfg())); } catch { } },
  show(kind) {
    const k = ALERT_KINDS.find(x => x[0] === kind); if (!k) return;
    alertUser(); setTimeout(alertUser, 900);
    let d = $("#soundNote"); if (d) d.remove();
    d = document.createElement("div"); d.id = "soundNote"; d.className = "box callnote soundnote"; d.setAttribute("role", "alert");
    d.innerHTML = `<b>${k[2]}</b> <button class="btn" id="snOk">OK</button>`;
    document.body.appendChild(d);
    const gone = () => d.remove(); $("#snOk").onclick = gone; setTimeout(gone, 20000);
    if (current) { addLine("bookmark", ""); }
  },
};
OtoEvents.on("soundAlert", kind => SoundAlerts.show(kind));
function renderAlerts(back, wireBack) {
  const c = SoundAlerts.cfg(), box = (id, on, text) => `<label class="row" style="margin-bottom:12px"><input type="checkbox" id="${id}" ${on ? "checked" : ""} style="width:auto;min-height:auto"> ${text}</label>`;
  view().innerHTML = back + `<h2>Sound alerts</h2>
    <p>While <b>Listen</b> is on, OtoHearSay can also notice some everyday sounds and tell you with a flash, a buzz and a word on the screen${settings.notifyCaptions !== false ? " (and in the notification, so a paired watch shows it)" : ""}. It works on this phone only; nothing is sent anywhere.</p>
    ${box("saOn", c.on, "<b>Sound alerts</b>")}
    ${ALERT_KINDS.map(([id, n]) => box("sa_" + id, c[id], n)).join("")}
    ${box("saMore", c.more, "Alert sooner (catches more, with more false alarms)")}
    <p class="muted small"><b>Important:</b> sound alerts can miss a sound or be wrong, they only work while the app is listening, and the phone must be able to hear the sound. Never rely on them as your only warning of a fire. Keep working smoke alarms, and consider alarms made for deaf and hard-of-hearing people (with a strobe light or a bed shaker).</p>
    <button class="btn" id="saTest">Show me what an alert looks like</button>`;
  wireBack();
  $("#saOn").onchange = e => { SoundAlerts.set({ on: e.target.checked }); if (e.target.checked && !listening) toast("Sound alerts are on. They work while Listen is on."); };
  ALERT_KINDS.forEach(([id]) => { $("#sa_" + id).onchange = e => SoundAlerts.set({ [id]: e.target.checked }); });
  $("#saMore").onchange = e => SoundAlerts.set({ more: e.target.checked });
  $("#saTest").onclick = () => SoundAlerts.show("door");
}

// ---------- listening practice ----------
// The app says a word or sentence (through the phone's voice, so it reaches headphones and Bluetooth listening devices and
// cochlear implant streamers too), with optional background noise; the user picks what they heard. Items missed come
// back more often (simple spaced practice). It is practice, not a hearing test.
const PRACTICE_SETS = {
  words: { name: "Everyday words", items: ["water", "coffee", "doctor", "kitchen", "window", "money", "sister", "morning", "pizza", "garden", "paper", "music", "table", "chicken", "yellow", "phone", "school", "dinner", "button", "pocket"] },
  numbers: { name: "Numbers", items: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "thirteen", "thirty", "fourteen", "forty", "fifteen", "fifty", "sixteen", "sixty", "a hundred", "a thousand"] },
  days: { name: "Days and months", items: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "January", "March", "June", "July", "August", "September", "November", "December"] },
  pairs: { name: "Sound-alike words", pairs: [["bat", "pat"], ["ship", "chip"], ["fan", "van"], ["sea", "she"], ["thin", "fin"], ["pear", "bear"], ["cap", "cab"], ["coat", "goat"], ["mice", "nice"], ["day", "they"], ["light", "right"], ["wet", "vet"], ["sink", "think"], ["back", "bag"], ["pin", "bin"], ["tea", "key"], ["sip", "zip"], ["mat", "map"]] },
  sentences: { name: "Short sentences", items: ["Can you pass the salt?", "The bus is running late.", "I left my keys at home.", "Let's meet at noon.", "The store closes at nine.", "Please turn off the lights.", "My phone is almost dead.", "Do you want some tea?", "It might rain tomorrow.", "Where did you park the car?"] },
  mine: { name: "My phrases" },
};
const Practice = {
  set: "words", noise: "off", round: 0, total: 10, right: 0, target: "", choices: [], answered: false, ctx: null, noiseNode: null,
  items(set) {
    const def = PRACTICE_SETS[set];
    if (set === "mine") return [...new Set([...pins, ...phrases.flatMap(c => c.items)])].filter(x => x.length < 80);
    if (def.pairs) return def.pairs.flat();
    return def.items;
  },
  boxes() { return store.get("practiceBoxes", {}); },
  pick() {
    const items = this.items(this.set), boxes = this.boxes();
    // items in a low box (missed before) are three times as likely to come up
    const weighted = items.flatMap(x => (boxes[x] ?? 1) <= 0 ? [x, x, x] : [x]);
    this.target = weighted[Math.floor(Math.random() * weighted.length)];
    let others;
    const pair = PRACTICE_SETS[this.set].pairs?.find(p => p.includes(this.target));
    if (pair) others = [pair.find(x => x !== this.target), ...items.filter(x => !pair.includes(x)).sort(() => Math.random() - .5).slice(0, 2)];
    else others = items.filter(x => x !== this.target).sort(() => Math.random() - .5).slice(0, 3);
    this.choices = [this.target, ...others].sort(() => Math.random() - .5);
    this.answered = false;
  },
  say(slow) {
    const keep = settings.rate;
    if (slow) settings.rate = Math.max(0.5, keep * 0.75);
    Voice.speak(this.target, "p" + (++speakSeq));
    settings.rate = keep;
  },
  startNoise() {
    this.stopNoise();
    if (this.noise === "off") return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0; // pink noise, softer than plain hiss
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056; d[i] = (b0 + b1 + b2 + w * 0.05) * 0.6; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = this.noise === "light" ? 0.15 : 0.4;
    src.connect(g); g.connect(ctx.destination); src.start();
    this.noiseNode = src;
  },
  stopNoise() { try { this.noiseNode?.stop(); } catch { } this.noiseNode = null; if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; } },
  answer(choice) {
    if (this.answered) return;
    this.answered = true;
    const ok = choice === this.target;
    if (ok) this.right++;
    const boxes = this.boxes();
    boxes[this.target] = ok ? Math.min(5, (boxes[this.target] ?? 1) + 1) : 0;
    store.set("practiceBoxes", boxes);
    return ok;
  },
  finish() {
    this.stopNoise();
    const log = store.get("practiceLog", []);
    log.unshift({ t: Date.now(), set: this.set, noise: this.noise, right: this.right, total: this.total });
    store.set("practiceLog", log.slice(0, 200));
  },
};
function renderPractice(state) {
  const P = Practice;
  const back = `<button class="btn" id="back" style="margin-bottom:12px">‹ More</button>`;
  if (state === "play") {
    view().innerHTML = back + `
      <p class="muted small">Round ${P.round} of ${P.total} · ${esc(PRACTICE_SETS[P.set].name)} · ${P.right} right so far</p>
      <div class="row" style="margin-bottom:14px"><button class="btn primary" id="again">🔊 Play again</button><button class="btn" id="slow">🐢 Slower</button></div>
      <div class="phrase-grid" id="choices">${P.choices.map((c, i) => `<button class="phrase" data-c="${i}">${esc(c)}</button>`).join("")}</div>
      <p id="result" style="font-size:1.3rem;margin-top:14px" aria-live="polite"></p>
      <div class="row"><button class="btn primary" id="next" hidden>${P.round >= P.total ? "See my score" : "Next"}</button><button class="btn" id="quit">Stop</button></div>`;
    $("#back").onclick = () => { P.stopNoise(); location.hash = "more"; };
    $("#again").onclick = () => P.say(false);
    $("#slow").onclick = () => P.say(true);
    $("#quit").onclick = () => { P.finish(); renderPractice("done"); };
    $("#choices").onclick = e => {
      const b = e.target.closest("[data-c]"); if (!b || P.answered) return;
      const ok = P.answer(P.choices[+b.dataset.c]);
      $("#result").innerHTML = ok ? "✓ Right!" : `✗ It was <b>${esc(P.target)}</b>.`;
      b.style.outline = "3px solid " + (ok ? "var(--live)" : "var(--danger)");
      $("#next").hidden = false; $("#next").focus();
    };
    $("#next").onclick = () => {
      if (P.round >= P.total) { P.finish(); renderPractice("done"); return; }
      P.round++; P.pick(); renderPractice("play"); setTimeout(() => P.say(false), 300);
    };
    return;
  }
  const log = store.get("practiceLog", []);
  const recent = log.filter(x => Date.now() - x.t < 14 * 86400000);
  const pct = recent.length ? Math.round(100 * recent.reduce((a, x) => a + x.right, 0) / recent.reduce((a, x) => a + x.total, 0)) : null;
  view().innerHTML = back + `
    <h2>Listening practice</h2>
    ${state === "done" ? `<div class="box"><p style="font-size:1.4rem">You got <b>${P.right} of ${P.total}</b> right.</p></div>` : ""}
    <p>The phone says a word or sentence through its speaker, your headphones or any Bluetooth listening device you use. Pick what you heard. Words you miss come back more often.</p>
    <label class="field"><span>What to practice</span><select id="pSet">${Object.entries(PRACTICE_SETS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Background noise</span><select id="pNoise"><option value="off">None</option><option value="light">Light</option><option value="busy">Busy room</option></select></label>
    <button class="btn primary" id="pGo">Start (10 rounds)</button>
    <h2>My progress</h2>
    <p class="small">${pct == null ? "No practice yet." : `Last 14 days: <b>${pct}%</b> right over ${recent.length} ${recent.length === 1 ? "session" : "sessions"}.`}</p>
    <ul class="list">${log.slice(0, 8).map(x => `<li><span class="grow">${esc(fmtDate(x.t))} · ${esc(PRACTICE_SETS[x.set]?.name || x.set)}${x.noise !== "off" ? " · with noise" : ""}</span><b>${x.right}/${x.total}</b></li>`).join("")}</ul>
    <p class="muted small" style="margin-top:12px">For everyday practice only. It is not a hearing test, and it does not replace advice from your audiologist.</p>`;
  $("#back").onclick = () => { P.stopNoise(); location.hash = "more"; };
  $("#pSet").value = P.set; $("#pNoise").value = P.noise;
  $("#pGo").onclick = () => {
    P.set = $("#pSet").value; P.noise = $("#pNoise").value;
    if (P.items(P.set).length < 4) { toast("Add a few more phrases first (at least 4)."); return; }
    P.round = 1; P.right = 0; P.pick(); P.startNoise();
    renderPractice("play"); setTimeout(() => P.say(false), 400);
  };
}

// ---------- captions for recordings and videos ----------
// Android decodes the file and runs the phone's engine; a browser decodes it with Web Audio and runs the WebAssembly
// engine. Either way the result becomes a saved talk with times, so it can be saved as subtitles (SRT).
const FileCaption = {
  session: null, busy: false,
  pick() {
    if (this.busy) { toast("A recording is already being captioned."); return; }
    if (native && native.pickMedia) { native.pickMedia(); return; }
    if (!Listener.useEngine()) { toast("This browser cannot run the speech engine needed to caption recordings."); return; }
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "audio/*,video/*";
    inp.onchange = () => { const f = inp.files[0]; if (f) this.webFile(f); };
    inp.click();
  },
  async webFile(f) {
    OtoEvents.emit("fileStart", { name: f.name });
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const decoded = await ac.decodeAudioData(await f.arrayBuffer());
      ac.close();
      const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
      const samples = (await off.startRendering()).getChannelData(0);
      // keep the sound beside the captions, so the recording can be played back louder and clearer
      const fs = FileCaption.session;
      if (fs) { fs.fileKey = fs.id + ":file"; SoundDB.put(fs.fileKey, wavBlob(samples)).catch(() => { fs.fileKey = ""; }); }
      const w = WebEngine.getWorker();
      w.postMessage({ type: "file", samples }, [samples.buffer]);
    } catch { OtoEvents.emit("fileError", "decode-failed"); }
  },
};
OtoEvents.on("fileStart", m => {
  FileCaption.busy = true;
  FileCaption.session = { id: m.key || Date.now().toString(36), started: Date.now(), title: m.name || "Recording", source: "file", names: {}, lines: [] };
  if (m.key) FileCaption.session.fileKey = m.key; // Android kept the sound under this name
  sessions.unshift(FileCaption.session);
  location.hash = "history/" + FileCaption.session.id;
  toast("Captioning " + (m.name || "the recording") + "...");
});
OtoEvents.on("fileProgress", pct => { const e = $("#fileStatus"); if (e) e.textContent = `Captioning... ${pct}%`; });
OtoEvents.on("fileSegment", m => {
  const s = FileCaption.session; if (!s) return;
  const line = { who: "them", text: m.text, t: Date.now(), at: m.start, end: m.end };
  if (s.fileKey) { line.a = [m.start, m.end]; line.ak = s.fileKey; }
  s.lines.push(line);
  saveSessions();
  const box = $("#hcaps");
  if (box && location.hash === "#history/" + s.id) { box.appendChild(lineEl(s.lines.at(-1), s)); }
});
OtoEvents.on("fileDone", () => {
  const s = FileCaption.session; FileCaption.busy = false; FileCaption.session = null;
  if (!s) return;
  store.set("sessions", sessions);
  toast(s.lines.length ? "Done. Save it as subtitles or text from here." : "No speech was found in that recording.");
  if (location.hash === "#history/" + s.id) renderHistory(s.id);
});
OtoEvents.on("fileError", code => {
  FileCaption.busy = false;
  const s = FileCaption.session; FileCaption.session = null;
  if (s && !s.lines.length) { sessions = sessions.filter(x => x !== s); store.set("sessions", sessions); }
  toast({ "no-audio": "That file has no sound to caption.", "no-engine": "Captioning recordings needs the built-in engine, which this phone cannot run.", "engine-load": "The speech engine could not start." }[code] || "That file could not be read. Try another recording.");
  if (location.hash.startsWith("#history/")) location.hash = "history";
});

// ---------- remote microphone ----------
// The phone near the speaker shares its captions over Wi-Fi; this device shows them (OtoHearSay on another phone or
// tablet, or any browser at the sharing phone's address).
const Remote = {
  es: null, addr: "",
  connect(addr, code) {
    this.disconnect();
    addr = addr.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!/:\d+$/.test(addr)) addr += ":8737";
    let es;
    try { es = new EventSource(`http://${addr}/events?code=${encodeURIComponent(code.trim())}`); }
    catch { toast("That address could not be opened."); return; }
    this.es = es; this.addr = addr; this.code = code.trim();
    es.addEventListener("partial", e => setPartial(JSON.parse(e.data)));
    es.addEventListener("final", e => { setPartial(""); const t = JSON.parse(e.data); if (t) addLine("them", t); });
    es.addEventListener("marker", () => addLine("marker", ""));
    es.onopen = () => { toast("Connected. Captions from the other phone will appear on Talk."); OtoEvents.emit("engine", "Captions from " + addr); };
    es.onerror = () => { const e = $("#engine"); if (e) e.textContent = "Waiting for " + addr + "..."; };
    store.set("remoteAddr", addr);
  },
  disconnect() { RemoteSound.stop(); if (this.es) { this.es.close(); this.es = null; this.addr = ""; OtoEvents.emit("engine", Listener.name()); } },
};

// ---------- backup and restore ----------
// One file holds everything (settings, phrases, pins, info card, talks). On Android the phone's own save screen lets the
// user choose Google Drive, OneDrive or the phone; the place is remembered for "Back up now" and the daily backup.
// In a browser the file is saved with the browser's save screen (on a computer, pick a Google Drive or OneDrive folder).
const files = window.OtoFiles || null;
const Backup = {
  data() {
    return JSON.stringify({ app: "OtoHearSay", version: APP_VERSION, savedAt: Date.now(), settings, phrases, pins, info, sessions });
  },
  fileName() { return "OtoHearSay backup " + new Date().toISOString().slice(0, 10) + ".json"; },
  last() { return store.get("lastBackup", null); },
  mark(where) { store.set("lastBackup", { t: Date.now(), where }); },
  handle: null,
  async save(chooseNew) {
    if (files) {
      if (!chooseNew && files.saveAgain(this.data())) return;
      files.saveAs(this.fileName(), this.data());
      return;
    }
    if (window.showSaveFilePicker) {
      try {
        if (chooseNew || !this.handle) this.handle = await showSaveFilePicker({ suggestedName: "OtoHearSay backup.json", types: [{ description: "OtoHearSay backup", accept: { "application/json": [".json"] } }] });
        const w = await this.handle.createWritable(); await w.write(this.data()); await w.close();
        this.mark(this.handle.name); toast("Backed up to " + this.handle.name + ".");
        if ($("#bkLast")) renderMore("backup");
        return;
      } catch (e) { if (e && e.name === "AbortError") return; }
    }
    exportFile(this.fileName(), this.data(), "application/json");
    this.mark("your downloads"); toast("Backup file saved to your downloads. Move it to Google Drive or OneDrive to keep it safe.");
  },
  open() {
    if (files) { files.open(); return; }
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = () => { const f = inp.files[0]; if (f) f.text().then(t => this.offer(t)); };
    inp.click();
  },
  parse(text) {
    try { const d = JSON.parse(text); return d && d.app === "OtoHearSay" && Array.isArray(d.sessions) ? d : null; } catch { return null; }
  },
  offer(text) {
    const d = this.parse(text);
    if (!d) { toast("That file is not an OtoHearSay backup."); return; }
    pendingRestore = d;
    location.hash = "more/restore";
    if (location.hash === "#more/restore") renderMore("restore");
  },
  restore(d) {
    const byId = new Map(sessions.map(x => [x.id, x]));
    for (const x of d.sessions) { const mine = byId.get(x.id); if (!mine || (x.lines?.length || 0) > mine.lines.length) byId.set(x.id, x); }
    sessions = [...byId.values()].sort((a, b) => b.started - a.started);
    settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    if (Array.isArray(d.phrases)) phrases = d.phrases;
    if (Array.isArray(d.pins)) pins = d.pins;
    if (d.info) info = d.info;
    current = null;
    ["sessions", "settings", "phrases", "pins", "info"].forEach(k => store.set(k, ({ sessions, settings, phrases, pins, info })[k]));
    store.set("welcomed", true);
    applySettings();
  },
};
let pendingRestore = null;
OtoEvents.on("backupSaved", r => {
  if (r.canceled) return;
  if (r.ok) { Backup.mark(r.where); if (!r.auto) toast("Backed up to " + r.where + "."); }
  else toast(r.auto ? "The daily backup could not be saved. Open More, Backup and restore." : "The backup could not be saved. Try another place.");
  if ($("#bkLast")) renderMore("backup");
});
OtoEvents.on("fileOpened", text => { if (text == null) toast("That file could not be opened."); else Backup.offer(text); });
function autoBackup() {
  if (!settings.autoBackup) return;
  const last = Backup.last();
  if (last && Date.now() - last.t < 86400000) return;
  if (files && files.target()) files.saveAgain(Backup.data());
}
// ---------- PDF and Word export (made on the device, nothing is uploaded) ----------
const latin = t => String(t).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-")
  .replace(/\u2026/g, "...").replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "");
function makePdf(title, text) {
  const wrap = (line, max) => { const out = []; let cur = ""; for (const w of line.split(/\s+/)) { if ((cur + " " + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); } out.push(cur); return out; };
  const body = latin(text).split(/\n/).flatMap(l => l.trim() ? wrap(l, 92) : [""]);
  const pages = []; let cur = [], first = true;
  for (const l of body) { cur.push(l); if (cur.length >= (first ? 56 : 60)) { pages.push(cur); cur = []; first = false; } }
  if (cur.length || !pages.length) pages.push(cur);
  const pe = t => t.replace(/[\\()]/g, m => "\\" + m);
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  pages.forEach((lines, pi) => {
    let c = "BT /F1 10 Tf 12 TL 50 742 Td ";
    if (pi === 0) c = `BT /F2 16 Tf 50 750 Td (${pe(latin(title))}) Tj /F1 10 Tf 12 TL 0 -30 Td `;
    c += lines.map(l => `(${pe(l)}) Tj T*`).join(" ") + ` ET BT /F1 8 Tf 50 30 Td (OtoHearSay - page ${pi + 1} of ${pages.length}) Tj ET`;
    objs.push(`<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(objs.length);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Uint8Array.from(pdf, ch => ch.charCodeAt(0) & 255);
}
// Word opens this (a .doc written as a web page); so do Google Docs and LibreOffice.
function makeDoc(title, s) {
  const lines = s.lines.map(l => l.who === "marker" ? `<h3>${esc(speakerName(s, l.spk || 2))}</h3>`
    : l.who === "bookmark" ? `<p style="color:#b05a00"><b>Bookmark</b> ${esc(clock(l.t))} ${esc(l.text || "")}</p>`
    : `<p><span style="color:#888">${esc(clock(l.t))}</span> ${l.who === "me" ? "<b>Me:</b> " : ""}${esc(l.text)}</p>`).join("\n");
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Calibri,Arial,sans-serif;font-size:12pt"><h1>${esc(title)}</h1><p style="color:#666">${esc(fmtDate(s.started))} &middot; made with OtoHearSay</p>
${lines}${s.note ? `<h3>Notes</h3><p>${esc(s.note)}</p>` : ""}</body></html>`;
  return new TextEncoder().encode(html);
}
function exportBytes(name, mime, bytes) {
  if (files && files.exportFile) {
    let bin = ""; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    files.exportFile(name, mime, btoa(bin)); return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
OtoEvents.on("exported", r => toast(r && r.ok ? `Saved ${r.name}.` : "Could not save the file."));
function exportFile(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- show-to-them card, back button ----------
$("#cardFlip").onclick = () => $("#cardText").classList.toggle("flipped");
$("#cardClose").onclick = () => { $("#card").hidden = true; };
window.otoBack = () => {
  if (!$("#card").hidden) { $("#card").hidden = true; return true; }
  const h = location.hash.slice(1) || "talk";
  if (h.includes("/")) { location.hash = h.split("/")[0]; return true; }
  if (h !== "talk") { location.hash = "talk"; return true; }
  return false;
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#card").hidden) $("#card").hidden = true; });

// ---------- start ----------
applySettings();
pruneOldTalks();
route();
if (/[?&]listen=1/.test(location.search)) OtoEvents.emit("autoListen");
// Personal edition only: the phone checks the owner's site for a newer build (the store edition has no checkUpdate).
OtoEvents.on("updateStatus", m => toast(m.text));
if (native && native.checkUpdate) setTimeout(() => { try { native.checkUpdate(false); } catch { } }, 5000);
setTimeout(autoBackup, 3000);
if (native) { try { openShared(native.takeSharedText()); } catch { } }
if (!native && "serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => { });
