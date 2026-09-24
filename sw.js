// Network-first service worker: players always get the latest deploy when online,
// and the cached copy when offline. Bump CACHE when the precache list changes.
const CACHE = "woodcutter-v0.8.0";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./src/main.js",
  "./src/game.js",
  "./src/data.js",
  "./src/util.js",
  "./src/save.js",
  "./src/render.js",
  "./src/sprites.js",
  "./src/ui.js",
  "./src/audio.js",
  "./src/input.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("woodcutter-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./index.html"))),
  );
});
