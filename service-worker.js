/* İlaç Hatırlatıcı — Service Worker
   Görevleri:
   1) Uygulama dosyalarını önbelleğe alıp çevrimdışı çalıştırmak
   2) Aksiyon butonlu bildirimleri göstermek
   3) Bildirimdeki Tamam / 15 dk Ertele / 30 dk Ertele seçimlerini uygulamaya iletmek
*/

const CACHE = 'ilac-takip-v5';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.error('Önbellek hatası:', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Ağ öncelikli, hata durumunda önbellek (güncellemeler hemen görünsün) */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});

/* ---------------- Bildirim gösterme ---------------- */

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'show-notification') return;
  const p = msg.payload || {};

  event.waitUntil(
    self.registration.showNotification(p.title || 'İlaç saati', {
      body: p.body || '',
      tag: p.tag || ('ilac-' + p.logId),
      renotify: true,
      requireInteraction: true,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      vibrate: [300, 150, 300],
      data: { logId: p.logId },
      actions: [
        { action: 'confirm',  title: 'Tamam' },
        { action: 'snooze15', title: '15 dk Ertele' },
        { action: 'snooze30', title: '30 dk Ertele' }
      ]
    })
  );
});

/* ---------------- Bildirime tıklama ---------------- */

self.addEventListener('notificationclick', (event) => {
  const action = event.action;                    // '' | confirm | snooze15 | snooze30
  const logId = (event.notification.data || {}).logId;
  event.notification.close();

  event.waitUntil(handleAction(action, logId));
});

async function handleAction(action, logId) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  // Bildirimin gövdesine tıklandıysa sadece uygulamayı aç
  if (!action) {
    if (clientList.length) return clientList[0].focus();
    return self.clients.openWindow('./index.html');
  }

  if (!logId) return;

  // Uygulama açıksa doğrudan ona ilet
  if (clientList.length) {
    clientList.forEach((c) => c.postMessage({
      type: 'notification-action', action: action, logId: logId, at: Date.now()
    }));
    return;
  }

  // Uygulama kapalıysa sıraya yaz; uygulama açıldığında işlenecek
  await queueAction(action, logId);
}

/* ---------------- Bekleyen aksiyon kuyruğu (IndexedDB) ---------------- */

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ilacTakipDB', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pendingActions')) {
        db.createObjectStore('pendingActions', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueAction(action, logId) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('pendingActions', 'readwrite');
      tx.objectStore('pendingActions').add({ action: action, logId: logId, at: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.error('Aksiyon kuyruğa yazılamadı:', err);
  }
}
