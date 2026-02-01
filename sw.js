const CACHE_NAME = 'tukmol-chat-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/style.css',
  '/script.js',
  '/settings.html',
  '/settings.js',
  '/login.js',
  '/supabase-init.js',
  '/emojis.js',
  '/full-emoji-list.json',
  '/image-viewer.html',
  '/Logo-192.jpg',
  '/Logo-512.jpg',

  // textures
  '/textures/always-grey.png',
  '/textures/axiom-pattern.png',
  '/textures/black-thread-light.png',
  '/textures/black-twill.png',
  '/textures/cartographer.png',
  '/textures/checkered-pattern.png',
  '/textures/crisp-paper-ruffles.png',
  '/textures/crissxcross.png',
  '/textures/cubes.png',
  '/textures/cutcube.png',
  '/textures/dark-brick-wall.png',
  '/textures/dark-leather.png',
  '/textures/diagmonds-light.png',
  '/textures/diagmonds.png',
  '/textures/diagonal-striped-brick.png',
  '/textures/diamond-upholstery.png',
  '/textures/elastoplast.png',
  '/textures/food.png',
  '/textures/grid-me.png',
  '/textures/light-wool.png',
  '/textures/padded.png',
  '/textures/pineapple-cut.png',
  '/textures/pinstripe-dark.png',
  '/textures/shattered-dark.png',
  '/textures/shattered.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('SW: failed to cache', url, err);
          }),
        ),
      ),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // network-first for Supabase / API calls
  if (req.url.includes('supabase.co')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // cache-first for static assets
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
