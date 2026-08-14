const CACHE_NAME = "samrat-xtreme-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./samrat-logo.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Never cache live market APIs; always use the network.
  if (
    url.hostname.includes("binance.vision") ||
    url.hostname.includes("xaus.com")
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Same-origin app files: network first, cache fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(
            cached => cached || caches.match("./index.html")
          )
        )
    );
  }
});