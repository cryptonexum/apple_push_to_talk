// Service Worker for Walkie-Talkie Web Push Notifications
const CACHE_NAME = 'walkie-talkie-v2';
const ASSETS = ['/', '/style.css', '/app.js', '/manifest.json', '/sw.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

// ── Incoming Push: show notification with sound ───────────────────────────────
self.addEventListener('push', (e) => {
  const data  = e.data?.json() || {};
  const title = data.title || '🎙️ Walkie-Talkie';
  const body  = data.body  || 'Someone is speaking — Tap to listen!';
  const room  = data.room  || '';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag:              'walkie-talkie-incoming',
      icon:             '/icon-192.png',
      badge:            '/icon-192.png',
      vibrate:          [100, 50, 100, 50, 200],
      requireInteraction: true,     // stays until tapped
      silent:           false,
      data:             { room, autoOpen: true }
    })
  );
});

// ── Tap on notification → open app, auto-rejoin channel ─────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const room = e.notification.data?.room || '';
  const url  = room ? `/?room=${room}&autoJoin=1` : '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const c of all) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.postMessage({ type: 'AUTO_JOIN', room });
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
