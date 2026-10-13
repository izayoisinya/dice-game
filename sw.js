// ダイス戦記 Service Worker
//   ホーム画面へのインストール（PWA）とオフライン起動のため。
//   更新がすぐ届くように「まずネットから取り、つながらなければ保存済みのものを使う」方式。
const CACHE = 'dice-senki-v23';
const FILES = ['./', './index.html', './style.css', './main.js', './setup.js', './strategy.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // GitHub Pages はファイルを10分ほどブラウザに覚えさせるので、毎回サーバーに確認する（no-cache）。
    // そうしないと更新直後に新しいファイルと古いファイルが混ざり、ボタンが反応しなくなることがある
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))),
  );
});
