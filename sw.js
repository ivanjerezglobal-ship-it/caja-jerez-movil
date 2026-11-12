/* Comercializadora Jerez · app del celular por internet (M-71)
   Guarda la app en el teléfono para que abra sin internet. Los datos (Supabase) no pasan por aquí:
   la app los guarda aparte y los sincroniza sola. */
const CACHE = "caja-jerez-movil-20261111-211433";
const APP = ["./", "index.html", "app.js", "nube.js", "estilo.css", "manifest.webmanifest", "icono.svg"];
const LECTOR = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET") return;
  const url = new URL(r.url);
  // la app: primero internet (para tener siempre la última versión), si no hay, la copia guardada
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(r)
        .then(res => {
          const copia = res.clone();
          caches.open(CACHE).then(c => c.put(r, copia));
          return res;
        })
        .catch(() => caches.match(r, { ignoreSearch: true }).then(x => x || caches.match("index.html")))
    );
    return;
  }
  // lector de códigos (respaldo cuando el teléfono no trae lector propio): se guarda la primera vez
  if (r.url === LECTOR) {
    e.respondWith(caches.match(r).then(x => x || fetch(r).then(res => {
      const copia = res.clone();
      caches.open(CACHE).then(c => c.put(r, copia));
      return res;
    })));
  }
});
