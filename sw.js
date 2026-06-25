const CACHE = 'rs-v5';
const ASSETS = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // No interceptar las llamadas a Monday (API y archivos)
  if (req.url.includes('monday.com')) return;

  // HTML / navegación: RED PRIMERO, caché solo como respaldo offline.
  // Así los celulares siempre reciben la versión más nueva al recargar.
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto de archivos: caché primero, red como respaldo
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
