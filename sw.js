const CACHE_NAME = 'banva-etiquetas-v3';
const ASSETS = ['/', '/index.html', '/locks.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  // addAll es atomico: un solo asset caido (deploy a medias) rechazaria el
  // install completo y el navegador se quedaria en la version vieja del cache.
  // Precache best-effort por asset; el fetch handler es network-first igual.
  e.waitUntil(caches.open(CACHE_NAME).then(c =>
    Promise.allSettled(ASSETS.map(a => c.add(a)))
  ));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  if (e.request.method !== 'GET') {
    e.respondWith(fetch(e.request));
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(e.request))
  );
});
