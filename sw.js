// Keeps the web and desktop app working offline. The cache name carries the version, so a new version replaces it.
const CACHE = "otohearsay-1.5.0";
const FILES = ["./", "index.html", "styles.css?v=1.5.0", "app.js?v=1.5.0", "sync.js?v=1.5.0", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys =>
  Promise.all(keys.filter(k => k !== CACHE && !k.startsWith("ohs-models")).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // the speech engine files are large, so they are saved on first use rather than at install
  const engine = new URL(e.request.url).pathname.includes("/engine/");
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (engine && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); }
    return res;
  })));
});
