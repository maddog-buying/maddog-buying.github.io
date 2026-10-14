// 更新前端檔案後，把版本號 +1
const VERSION = 'v13';
const CACHE = 'shipment-tracker-' + VERSION;
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './config.js', './mock-api.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './icons/logo-96.webp', './icons/hero.webp', './icons/favicon-64.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' 略過瀏覽器的 HTTP 快取，確保存到的是最新檔案
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('shipment-tracker-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 本站靜態檔：網路優先（永遠拿最新版），離線或網路太慢時才用快取；API 與 Google 登入不經過這裡
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise(r => setTimeout(r, 4000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch {}
    return (await cache.match(req, { ignoreSearch: true })) || network;
  })());
});
