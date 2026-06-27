/*
 * sw.js — Service Worker do Hama Beads Creator
 * --------------------------------------------------------------------------
 * Faz o app funcionar offline e instalável (PWA). Estratégia simples e segura
 * para um site estático: cache-first com fallback de rede. Ao publicar uma nova
 * versão, troque CACHE_VERSION para forçar a atualização dos arquivos.
 * --------------------------------------------------------------------------
 */
const CACHE_VERSION = 'hama-v8';

// App shell — tudo que o app precisa para abrir e converter offline.
const ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/sample-image.js',
  'js/colors.js',
  'js/palette.js',
  'js/imaging.js',
  'js/pipeline.js',
  'js/render.js',
  'js/crop.js',
  'js/export.js',
  'js/app.js',
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// Instala: pré-carrega o app shell no cache.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Ativa: remove caches de versões antigas.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Busca: cache-first. Navegações caem no index.html quando offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Guarda no cache as respostas válidas do próprio site.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline e sem cache: para navegação, devolve a página principal.
          if (req.mode === 'navigate') return caches.match('index.html');
        });
    })
  );
});
