"use strict";
// OtoHearSay: automatic sync through the user's own Google Drive (phone, tablet, web and desktop).
//
// How it works (the same idea as OtoScheduler's sync): everything the app keeps is cut into small records
// ("set:capSize", "talk:<id>", "phr:<group> <text>", ...). Each record carries the time it last changed. Deleting
// something leaves a "tombstone" record (deleted, with the time), so the delete reaches the other devices instead of the
// item coming back. Every sync reads the shared file in Drive, merges it record by record with this device (the newer
// change wins; nothing is replaced wholesale), and writes the merged copy back. Each device keeps its own full copy of
// the records, so a change lost in a write race is sent again on that device's next sync.
//
// Google permission: drive.file only (the app sees only the files it made, never the rest of the Drive). The file is
// "OtoHearSay-sync.json" in the Drive folder "OtoHearSay". Sign-in: on Android, Google Play services (OtoDrive in
// DriveAuth.kt, renews by itself); in a browser, Google's sign-in window (a pass lasts about an hour; the next tap renews it).

// ---------- the merge (pure; also run by tools/sync-test.js in Node) ----------
const SyncCore = (() => {
  // Settings that belong to one device (its headphones, its speech engine, its storage), never copied to the others.
  const DEVICE_ONLY = ["boost", "places", "autoBackup", "engine", "keepSound"];
  const TOMBSTONE_DAYS = 400; // a device away longer than this could bring a deleted item back
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const keyOf = x => typeof x === "string" ? x : JSON.stringify(x);
  const SEP = "\u0001";

  /** The app's data as { recordKey: value }. dev = this device's id (diary rows are counted per device). */
  function values(st, dev) {
    const v = {};
    for (const [k, x] of Object.entries(st.settings || {})) if (!DEVICE_ONLY.includes(k) && x !== undefined) v["set:" + k] = x;
    if (st.info) v.info = st.info;
    (st.phrases || []).forEach((g, gi) => {
      const { items, ...meta } = g;
      v["grp:" + g.name] = { ...meta, i: gi };
      (items || []).forEach((t, ti) => { v["phr:" + g.name + SEP + keyOf(t)] = { g: g.name, x: t, i: ti }; });
    });
    (st.pins || []).forEach((p, i) => { v["pin:" + keyOf(p)] = { x: p, i }; });
    (st.sessions || []).forEach(s => { if (s && s.id != null && s.lines && s.lines.length) v["talk:" + s.id] = s; });
    (st.diary || []).forEach(r => { const d = r.dev || dev; v["dia:" + d + "|" + r.d + "|" + r.p] = { ...r, dev: d }; });
    for (const [k, n] of Object.entries(st.practiceBoxes || {})) v["box:" + k] = n;
    (st.practiceLog || []).forEach(e => { v["plog:" + e.t] = e; });
    return v;
  }

  /** Bring the records up to date with the app's data: changed or new values get time now, missing ones a tombstone.
   *  On a device's very first sync (no records yet) whatever Drive already has wins (it came from the devices that were
   *  syncing already, including their deletes), and things only this device has are added, dated as old. */
  function stamp(recs, vals, now, remote) {
    const first = !recs || !Object.keys(recs).length;
    const out = { ...(recs || {}) };
    let changed = false;
    for (const [k, x] of Object.entries(vals)) {
      const r = out[k];
      if (r && !r.d && same(r.v, x)) continue;
      if (first && remote && remote[k]) continue;
      const t = first ? (k.startsWith("talk:") ? (x.started || 1) : 1) : Math.max(now, r ? r.t + 1 : 0);
      out[k] = { t, v: clone(x) };
      changed = true;
    }
    if (!first) for (const [k, r] of Object.entries(out)) if (!r.d && !(k in vals)) { out[k] = { t: Math.max(now, r.t + 1), d: 1 }; changed = true; }
    return { recs: out, changed };
  }

  /** Merge two record sets: per record the newer change wins; on a tie a delete wins, then the larger value (so every
   *  device reaches the same answer). Tombstones older than TOMBSTONE_DAYS are dropped. */
  function merge(a, b, now) {
    const out = {};
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const x = (a || {})[k], y = (b || {})[k];
      let w;
      if (!x) w = y; else if (!y) w = x;
      else if (x.t !== y.t) w = x.t > y.t ? x : y;
      else if (!!x.d !== !!y.d) w = x.d ? x : y;
      else w = JSON.stringify(x.v) >= JSON.stringify(y.v) ? x : y;
      if (w.d && now && now - w.t > TOMBSTONE_DAYS * 86400000) continue;
      out[k] = w;
    }
    return out;
  }

  /** Turn records back into the app's data. local = this device's current data (its device-only settings are kept). */
  function data(recs, local, defaults) {
    const live = Object.entries(recs).filter(([, r]) => !r.d);
    const settings = { ...defaults };
    for (const k of DEVICE_ONLY) if (local.settings && local.settings[k] !== undefined) settings[k] = local.settings[k];
    let info = null;
    const groups = new Map(), items = [], pins = [], sessions = [], diary = [], practiceBoxes = {}, practiceLog = [];
    for (const [k, r] of live) {
      const v = clone(r.v), c = k.indexOf(":"), kind = c < 0 ? k : k.slice(0, c), rest = c < 0 ? "" : k.slice(c + 1);
      if (kind === "set") settings[rest] = v;
      else if (kind === "info") info = v;
      else if (kind === "grp") groups.set(v.name, v);
      else if (kind === "phr") items.push(v);
      else if (kind === "pin") pins.push(v);
      else if (kind === "talk") sessions.push(v);
      else if (kind === "dia") diary.push(v);
      else if (kind === "box") practiceBoxes[rest] = v;
      else if (kind === "plog") practiceLog.push(v);
    }
    // an item added on one device to a group another device deleted brings the group back
    for (const it of items) if (!groups.has(it.g)) groups.set(it.g, { name: it.g, i: 1e9 });
    const phrases = [...groups.values()].sort((a, b) => a.i - b.i || (a.name < b.name ? -1 : 1)).map(g => {
      const { i, ...meta } = g;
      return { ...meta, items: items.filter(it => it.g === g.name).sort((a, b) => a.i - b.i).map(it => it.x) };
    });
    return {
      settings, info: info || local.info, phrases, sessions: sessions.sort((a, b) => b.started - a.started),
      pins: pins.sort((a, b) => a.i - b.i).map(p => p.x), diary: diary.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)),
      practiceBoxes, practiceLog: practiceLog.sort((a, b) => b.t - a.t),
    };
  }

  return { DEVICE_ONLY, values, stamp, merge, data, same };
})();
if (typeof module !== "undefined") module.exports = SyncCore;

// ---------- Google Drive (drive.file) ----------
const DriveFiles = {
  API: "https://www.googleapis.com/drive/v3",
  UPLOAD: "https://www.googleapis.com/upload/drive/v3/files",
  FOLDER: "OtoHearSay",
  FILE: "OtoHearSay-sync.json",
  async call(token, url, init = {}) {
    const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + token } });
    if (res.status === 401) { const e = new Error("Your Google sign-in ran out."); e.expired = true; throw e; }
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json()).error.message || ""; } catch { }
      if (/has not been used|is disabled/i.test(msg)) throw new Error("The Google Drive API is switched off in the Google project.");
      if (/storageQuota/i.test(msg)) throw new Error("Your Google Drive is full.");
      throw new Error("Google Drive said " + res.status + (msg ? ": " + msg : ""));
    }
    return res;
  },
  q: s => encodeURIComponent(s),
  /** Every copy of the sync file this app can see (normally one; two devices starting at the same moment can make two). */
  async list(token) {
    const r = await (await this.call(token, `${this.API}/files?q=${this.q(`name='${this.FILE}' and trashed=false`)}&orderBy=createdTime&fields=files(id)`)).json();
    return r.files || [];
  },
  async read(token, id) { return (await this.call(token, `${this.API}/files/${id}?alt=media`)).text(); },
  async folder(token) {
    const r = await (await this.call(token, `${this.API}/files?q=${this.q(`mimeType='application/vnd.google-apps.folder' and name='${this.FOLDER}' and trashed=false`)}&fields=files(id)`)).json();
    if (r.files && r.files[0]) return r.files[0].id;
    const made = await (await this.call(token, `${this.API}/files?fields=id`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.FOLDER, mimeType: "application/vnd.google-apps.folder" }) })).json();
    return made.id;
  },
  async write(token, id, text) {
    const b = "ohs" + Date.now();
    const meta = id ? {} : { name: this.FILE, mimeType: "application/json", parents: [await this.folder(token)] };
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
    const url = id ? `${this.UPLOAD}/${id}?uploadType=multipart&fields=id` : `${this.UPLOAD}?uploadType=multipart&fields=id`;
    return (await (await this.call(token, url, { method: id ? "PATCH" : "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body })).json()).id;
  },
  async remove(token, id) { await this.call(token, `${this.API}/files/${id}`, { method: "DELETE" }); },
  async email(token) {
    try { return (await (await this.call(token, `${this.API}/about?fields=user(emailAddress)`)).json()).user.emailAddress || ""; } catch { return ""; }
  },
};

// ---------- the Google pass (sign-in) ----------
// The web client is the owner's existing "OtoScheduler Web" client (Google project "OtoScheduler"; allowed origin
// https://otobong77-del.github.io, where both web addresses of OtoHearSay live). The Android app gets its pass from
// Google Play services through the Android client of the same project (package app.otohearsay + the sideload key), so
// the phones and the web see the same Drive file.
const GOOGLE_WEB_CLIENT_ID = "636128672113-hadg05trh1ntoeib01o5gairra9qokpv.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GooglePass = {
  native: () => window.OtoDrive || null,
  saved() { const p = store.get("drivePass", null); return p && p.until > Date.now() + 60000 ? p.token : null; },
  msLeft() { const p = store.get("drivePass", null); return p ? Math.max(0, p.until - Date.now()) : 0; },
  forget(token) {
    store.set("drivePass", null);
    const n = this.native(); if (n && token) try { n.forget(token); } catch { }
  },
  waiting: null,
  /** A pass for Drive. interactive = may open Google's window (only after a tap). Rejects with .needsTap when it cannot. */
  get(interactive) {
    const n = this.native();
    if (!n) { const t = this.saved(); if (t) return Promise.resolve(t); }
    if (this.waiting) return this.waiting;
    this.waiting = (n ? this.fromPhone(n, interactive) : this.fromBrowser(interactive)).finally(() => { this.waiting = null; });
    return this.waiting;
  },
  fromPhone(n, interactive) {
    return new Promise((resolve, reject) => {
      const off = OtoEvents.on("driveToken", r => {
        off();
        if (r && r.token) resolve(r.token);
        else { const e = new Error(GooglePass.why(r && r.error)); e.needsTap = r && r.error === "signin"; reject(e); }
      });
      try { n.token(!!interactive); } catch (e) { off(); reject(e); }
    });
  },
  why(code) {
    code = String(code || "");
    if (code === "signin") return "Tap Sync now to sign in to Google.";
    if (code === "canceled") return "Google sign-in was closed before it finished.";
    if (/\b10\b|DEVELOPER/i.test(code)) return "Google sign-in is not set up for this copy of the app yet (code 10).";
    if (/\b7\b|NETWORK/i.test(code)) return "No internet connection. Sync will try again later.";
    return "Google sign-in did not work (" + code + ").";
  },
  gis: null,
  loadGoogle() {
    return this.gis || (this.gis = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => resolve(window.google);
      s.onerror = () => { this.gis = null; reject(new Error("Could not reach Google (are you online?)")); };
      document.head.appendChild(s);
    }));
  },
  async fromBrowser(interactive) {
    if (!interactive) { const e = new Error("Tap Sync now to renew the Google sign-in."); e.needsTap = true; throw e; }
    const g = await this.loadGoogle();
    const hint = store.get("syncAccount", "");
    return new Promise((resolve, reject) => {
      const client = g.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_WEB_CLIENT_ID, scope: DRIVE_SCOPE, ...(hint ? { login_hint: hint } : {}),
        callback: r => {
          if (!r.access_token) return reject(new Error(r.error === "access_denied" ? "Google Drive access was not allowed." : "Google sign-in did not work (" + (r.error || "unknown") + ")."));
          store.set("drivePass", { token: r.access_token, until: Date.now() + ((r.expires_in || 3600) - 60) * 1000 });
          resolve(r.access_token);
        },
        error_callback: e => reject(new Error(e && e.type === "popup_closed" ? "The Google sign-in window was closed." : "Google sign-in did not work (" + (e && e.type) + ").")),
      });
      client.requestAccessToken({ prompt: "", ...(hint ? { login_hint: hint } : {}) });
    });
  },
};

// ---------- sync ----------
const SYNC_KEYS = ["settings", "phrases", "pins", "info", "sessions", "diary", "practiceBoxes", "practiceLog"];
const Sync = {
  on: () => !!store.get("syncOn", false),
  status: () => store.get("syncStatus", { t: 0, ok: true, text: "" }),
  busy: false,
  again: false,
  timer: 0,
  applying: false,
  local() {
    return { settings, phrases, pins, info, sessions: sessions.filter(s => s.lines && s.lines.length),
      diary: store.get("diary", []), practiceBoxes: store.get("practiceBoxes", {}), practiceLog: store.get("practiceLog", []) };
  },
  /** Called whenever the app saves one of its own things: date the change now and sync a little later. */
  changed(key) {
    if (this.applying || !SYNC_KEYS.includes(key) || !this.on()) return;
    // date the change now (so an older change made offline on another device does not win), send it in 20 seconds
    clearTimeout(this.stampTimer);
    this.stampTimer = setTimeout(() => this.stampNow(), 1500);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(false), 20000);
  },
  stampTimer: 0,
  /** remote = what Drive has (only during a sync; a device's very first records need it). */
  stampNow(remote) {
    const recs = store.get("syncRecs", {});
    if (!remote && !Object.keys(recs).length) return recs;
    const r = SyncCore.stamp(recs, SyncCore.values(this.local(), deviceId), Date.now(), remote);
    if (r.changed) this.saveRecs(r.recs);
    return r.recs;
  },
  saveRecs(recs) { try { localStorage.setItem("ohs.syncRecs", JSON.stringify(recs)); } catch { } },
  setStatus(ok, text) {
    store.set("syncStatus", { t: ok ? Date.now() : this.status().t, ok, text });
    const el = document.getElementById("syncState"); if (el) el.innerHTML = Sync.statusHtml();
    const pill = document.getElementById("syncPill"); if (pill) pill.hidden = ok;
  },
  statusHtml() {
    if (!this.on()) return "Not connected. Each device keeps its own data.";
    const s = this.status(), who = store.get("syncAccount", "");
    const last = s.t ? `Last synced <b>${esc(fmtDate(s.t))}</b>` : "Not synced yet";
    return `${who ? `Connected to <b>${esc(who)}</b>. ` : "Connected. "}${last}.${!s.ok && s.text ? `<br><span class="warn">${esc(s.text)}</span>` : ""}`;
  },
  /** One sync: read Drive, merge, write back if Drive lacks something, and use the merged data here. */
  async run(interactive, quiet) {
    if (!this.on() && !interactive) return;
    if (this.busy) { this.again = true; return; }
    // a talk being captioned changes every few seconds; it is sent once listening stops
    if (!interactive && typeof listening !== "undefined" && listening) { this.again = true; return; }
    this.busy = true; clearTimeout(this.timer); clearTimeout(this.stampTimer);
    try {
      let token = await GooglePass.get(interactive);
      let files;
      try { files = await DriveFiles.list(token); }
      catch (e) { if (!e.expired) throw e; GooglePass.forget(token); token = await GooglePass.get(interactive); files = await DriveFiles.list(token); }
      if (!store.get("syncAccount", "")) { const em = await DriveFiles.email(token); if (em) store.set("syncAccount", em); }
      const now = Date.now();
      let remote = {};
      for (const f of files) {
        try { const d = JSON.parse(await DriveFiles.read(token, f.id)); if (d && d.app === "OtoHearSay" && d.recs) remote = SyncCore.merge(remote, d.recs, now); } catch { }
      }
      const mine = this.stampNow(remote);
      const merged = SyncCore.merge(mine, remote, now);
      if (files.length !== 1 || !SyncCore.same(merged, remote)) {
        const id = await DriveFiles.write(token, files[0] ? files[0].id : null, JSON.stringify({ app: "OtoHearSay", kind: "sync", format: 1, savedAt: now, recs: merged }));
        for (const f of files.slice(1)) if (f.id !== id) try { await DriveFiles.remove(token, f.id); } catch { }
      }
      this.apply(merged);
      store.set("syncOn", true);
      this.setStatus(true, "");
      if (interactive && !quiet) toast("Synced with Google Drive.");
    } catch (e) {
      const text = (e && e.message) || "Sync did not work.";
      this.setStatus(false, text);
      if (interactive && !quiet) toast(text);
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; if (!(typeof listening !== "undefined" && listening)) this.timer = setTimeout(() => this.run(false), 3000); }
    }
  },
  /** Use the merged records on this device (only the parts that changed). */
  apply(recs) {
    this.saveRecs(recs);
    const before = this.local();
    const d = SyncCore.data(recs, before, DEFAULT_SETTINGS);
    let changed = false;
    this.applying = true;
    try {
      if (!SyncCore.same(SyncCore.values({ settings: d.settings }, deviceId), SyncCore.values({ settings: before.settings }, deviceId))) { settings = d.settings; store.set("settings", settings); applySettings(); changed = true; }
      if (!SyncCore.same(d.info, info)) { info = d.info; store.set("info", info); changed = true; }
      if (!SyncCore.same(d.phrases, phrases)) { phrases = d.phrases; store.set("phrases", phrases); if (phraseCat >= phrases.length) phraseCat = 0; changed = true; }
      if (!SyncCore.same(d.pins, pins)) { pins = d.pins; store.set("pins", pins); changed = true; }
      if (!SyncCore.same(d.sessions, before.sessions)) {
        // keep this device's own talk objects where nothing changed, and an empty talk just started here
        const byId = new Map(sessions.map(s => [s.id, s]));
        const next = d.sessions.map(s => { const m = byId.get(s.id); return m && SyncCore.same(m, s) ? m : s; });
        const empty = sessions.filter(s => !(s.lines && s.lines.length));
        sessions = [...empty, ...next].sort((a, b) => b.started - a.started);
        if (current) current = sessions.find(s => s.id === current.id) || null;
        store.set("sessions", sessions); changed = true;
      }
      for (const k of ["diary", "practiceBoxes", "practiceLog"]) if (!SyncCore.same(d[k], before[k])) { store.set(k, d[k]); changed = true; }
    } finally { this.applying = false; }
    // show the new data, unless the user is typing somewhere
    const a = document.activeElement;
    if (changed && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && typeof route === "function") route();
  },
  async connect() {
    store.set("syncOn", true);
    await this.run(true);
    if (!this.status().ok) { store.set("syncOn", false); }
    if (location.hash.startsWith("#more/sync")) renderMore("sync");
  },
  disconnect() {
    GooglePass.forget(store.get("drivePass", null) && store.get("drivePass", null).token);
    ["syncOn", "syncAccount", "syncStatus"].forEach(k => store.set(k, null));
    localStorage.removeItem("ohs.syncRecs");
    toast("This device no longer syncs. Its data stays here.");
  },
};

// load Google's sign-in script early in a browser, so a tap can open its window at once
if (!GooglePass.native() && Sync.on()) setTimeout(() => GooglePass.loadGoogle().catch(() => { }), 1000);
// sync on start, when the app comes back to the front, and every 10 minutes while it is open
setTimeout(() => Sync.run(false), 2500);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - Sync.status().t > 60000) Sync.run(false); });
setInterval(() => { if (document.visibilityState === "visible") Sync.run(false); }, 600000);
OtoEvents.on("listenState", on => { if (!on && Sync.on()) { clearTimeout(Sync.timer); Sync.timer = setTimeout(() => Sync.run(false), 5000); } });
// In a browser the Google pass lasts about an hour and renewing it needs a tap (it opens Google's window for a moment):
// when it has under 10 minutes left, the next tap anywhere renews it (not more than once every 2 minutes).
let lastRenewTry = 0;
document.addEventListener("click", () => {
  if (GooglePass.native() || !Sync.on() || GooglePass.msLeft() > 600000 || Date.now() - lastRenewTry < 120000) return;
  const a = document.activeElement; if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
  lastRenewTry = Date.now();
  Sync.run(true, true).catch(() => { });
}, true);
