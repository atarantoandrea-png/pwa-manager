const express = require('express');
const router = express.Router();
const db = require('../db/db');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3000';

// CORS for all public routes
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function getApp(slug) {
  return db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug);
}

// ─── MANIFEST ────────────────────────────────────────────────────────────────

router.get('/:slug/manifest.json', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Not found' });

  const base = BASE_URL();
  const iconUrl = app.icon_path ? base + app.icon_path : null;

  const manifest = {
    name: app.name,
    short_name: app.name,
    description: app.description,
    start_url: app.site_url || '/',
    scope: '/',
    display: app.display || 'standalone',
    orientation: app.orientation || 'any',
    background_color: app.bg_color || '#ffffff',
    theme_color: app.theme_color || '#6366f1',
    icons: iconUrl ? [
      { src: iconUrl, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ] : [],
    categories: ['utilities']
  };

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(manifest);
});

// ─── SERVICE WORKER CORE (loaded via importScripts) ──────────────────────────

router.get('/:slug/sw-core.js', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('Not found');

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
// PWA Manager SW Core — ${app.name}
self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  const title = data.title || '${app.name}';
  const options = {
    body: data.body || '',
    icon: data.icon || '',
    badge: data.icon || '',
    image: data.image || undefined,
    data: { url: data.url || '${app.site_url || '/'}' },
    requireInteraction: false,
    vibrate: [200, 100, 200]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '${app.site_url || '/'}';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cl) {
    for (const c of cl) {
      if (c.url === url && 'focus' in c) return c.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(clients.claim()); });
`);
});

// ─── SERVICE WORKER (to place on target site) ─────────────────────────────

router.get('/:slug/sw.js', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('Not found');
  const base = BASE_URL();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`importScripts('${base}/${app.slug}/sw-core.js');`);
});

// ─── INIT SCRIPT (add to target site <head>) ──────────────────────────────

router.get('/:slug/init.js', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('Not found');
  const base = BASE_URL();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
(function() {
  var SLUG = '${app.slug}';
  var BASE = '${base}';
  var VAPID = '${app.vapid_public}';
  var SUBSCRIBE_URL = BASE + '/' + SLUG + '/subscribe';

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function getPlatform() {
    var ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  async function subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    var reg = await navigator.serviceWorker.ready;
    var existing = await reg.pushManager.getSubscription();
    if (existing) return existing;
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') return null;
    var sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID)
    });
    await fetch(SUBSCRIBE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub,
        platform: getPlatform(),
        userAgent: navigator.userAgent
      })
    });
    return sub;
  }

  window.PWAManager = { subscribe: subscribe, slug: SLUG };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(BASE + '/' + SLUG + '/sw.js', { scope: '/' });
  }
})();
`);
});

// ─── SUBSCRIBE ENDPOINT ───────────────────────────────────────────────────────

router.post('/:slug/subscribe', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Not found' });

  const { subscription, platform, userAgent } = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  try {
    db.prepare(`
      INSERT INTO subscriptions (app_id, endpoint, p256dh, auth, platform, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET platform=excluded.platform, user_agent=excluded.user_agent
    `).run(app.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth,
           platform || 'unknown', userAgent || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:slug/unsubscribe', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const { endpoint } = req.body;
  if (endpoint) db.prepare('DELETE FROM subscriptions WHERE endpoint = ? AND app_id = ?').run(endpoint, app.id);
  res.json({ ok: true });
});

// ─── VAPID PUBLIC KEY ─────────────────────────────────────────────────────────

router.get('/:slug/vapid-public', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).json({ error: 'Not found' });
  res.json({ publicKey: app.vapid_public });
});

// ─── INSTALL PAGE ─────────────────────────────────────────────────────────────

router.get('/:slug/install', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('App not found');
  const base = BASE_URL();
  const iconUrl = app.icon_path ? base + app.icon_path : '';
  const subCount = db.prepare('SELECT COUNT(*) as n FROM subscriptions WHERE app_id = ?').get(app.id).n;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Installa ${app.name}</title>
<link rel="manifest" href="${base}/${app.slug}/manifest.json" crossorigin="use-credentials">
<meta name="theme-color" content="${app.theme_color}">
<script src="${base}/${app.slug}/init.js" defer></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --accent: ${app.theme_color};
    --bg: ${app.bg_color};
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f0f5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 24px; padding: 40px 32px; max-width: 400px; width: 100%; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.12); }
  .app-icon { width: 100px; height: 100px; border-radius: 22px; margin: 0 auto 20px; object-fit: cover; background: var(--accent); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .app-icon img { width: 100%; height: 100%; object-fit: cover; }
  .app-icon-placeholder { font-size: 48px; color: white; font-weight: 700; }
  h1 { font-size: 24px; font-weight: 700; color: #111; margin-bottom: 8px; }
  .desc { font-size: 15px; color: #666; margin-bottom: 8px; line-height: 1.5; }
  .sub-count { font-size: 13px; color: #999; margin-bottom: 28px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; background: var(--accent); color: white; border: none; border-radius: 14px; padding: 14px 28px; font-size: 16px; font-weight: 600; cursor: pointer; width: 100%; justify-content: center; transition: opacity .2s; }
  .btn:hover { opacity: .88; }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn-outline { background: transparent; color: var(--accent); border: 2px solid var(--accent); margin-top: 10px; }
  .divider { height: 1px; background: #eee; margin: 24px 0; }
  .steps { text-align: left; }
  .steps h3 { font-size: 13px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 14px; }
  .step { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
  .step-num { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); color: white; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .step p { font-size: 14px; color: #444; line-height: 1.5; }
  .step p strong { color: #111; }
  .notif-btn { margin-top: 16px; background: white; color: var(--accent); border: 2px solid var(--accent); border-radius: 14px; padding: 13px 28px; font-size: 15px; font-weight: 600; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .2s; }
  .notif-btn:hover { background: var(--accent); color: white; }
  .success-badge { display: inline-flex; align-items: center; gap: 6px; background: #d1fae5; color: #065f46; border-radius: 8px; padding: 8px 16px; font-size: 14px; font-weight: 600; margin-top: 12px; }
  .platform-ios .android-only { display: none; }
  .platform-android .ios-only { display: none; }
  footer { margin-top: 24px; font-size: 12px; color: #aaa; }
  footer a { color: #aaa; text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <div class="app-icon">
    ${iconUrl ? `<img src="${iconUrl}" alt="${app.name}">` : `<div class="app-icon-placeholder">${app.name[0]}</div>`}
  </div>
  <h1>${app.name}</h1>
  ${app.description ? `<p class="desc">${app.description}</p>` : ''}
  ${subCount > 0 ? `<p class="sub-count">Unisciti a ${subCount.toLocaleString()} ${subCount === 1 ? 'persona' : 'persone'} che hanno già installato l'app</p>` : ''}

  <div id="ios-instructions" class="steps ios-only" style="display:none">
    <h3>Come installare su iPhone / iPad</h3>
    <div class="step"><div class="step-num">1</div><p>Tocca il pulsante <strong>Condividi</strong> nella barra in basso di Safari</p></div>
    <div class="step"><div class="step-num">2</div><p>Scorri e tocca <strong>"Aggiungi a Home"</strong></p></div>
    <div class="step"><div class="step-num">3</div><p>Tocca <strong>Aggiungi</strong> — l'icona apparirà sulla schermata Home</p></div>
  </div>

  <div id="android-instructions" class="steps android-only" style="display:none">
    <h3>Come installare su Android</h3>
    <div class="step"><div class="step-num">1</div><p>Tocca il pulsante <strong>⋮</strong> in alto a destra del browser</p></div>
    <div class="step"><div class="step-num">2</div><p>Tocca <strong>"Installa app"</strong> o <strong>"Aggiungi a schermata Home"</strong></p></div>
    <div class="step"><div class="step-num">3</div><p>Tocca <strong>Installa</strong> — pronto!</p></div>
  </div>

  <button class="btn" id="install-btn" style="display:none">📲 Installa l'app</button>
  <div id="installed-badge" class="success-badge" style="display:none">✓ App installata!</div>

  <div class="divider"></div>

  <button class="notif-btn" id="notif-btn">🔔 Attiva le notifiche</button>
  <div id="notif-ok" class="success-badge" style="display:none">✓ Notifiche attivate!</div>
</div>
<footer>Powered by <a href="https://pwa.elisasoulmedium.com">PWA Manager</a></footer>

<script>
(function() {
  var ua = navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua);
  var isAndroid = /Android/.test(ua);
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

  if (isIOS) document.body.classList.add('platform-ios');
  if (isAndroid) document.body.classList.add('platform-android');

  if (isStandalone) {
    document.getElementById('installed-badge').style.display = 'inline-flex';
  } else if (isIOS) {
    document.getElementById('ios-instructions').style.display = 'block';
  } else if (isAndroid) {
    document.getElementById('android-instructions').style.display = 'block';
  }

  // Install prompt (Chrome/Android)
  var deferredPrompt;
  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('install-btn').style.display = 'inline-flex';
  });

  document.getElementById('install-btn').addEventListener('click', async function() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    var result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      document.getElementById('install-btn').style.display = 'none';
      document.getElementById('installed-badge').style.display = 'inline-flex';
    }
    deferredPrompt = null;
  });

  // Notifications
  var notifBtn = document.getElementById('notif-btn');
  if (!('Notification' in window)) {
    notifBtn.style.display = 'none';
  } else if (Notification.permission === 'granted') {
    document.getElementById('notif-btn').style.display = 'none';
    document.getElementById('notif-ok').style.display = 'inline-flex';
  }

  notifBtn.addEventListener('click', async function() {
    notifBtn.disabled = true;
    notifBtn.textContent = 'Attivazione...';
    try {
      var sub = await window.PWAManager.subscribe();
      if (sub) {
        notifBtn.style.display = 'none';
        document.getElementById('notif-ok').style.display = 'inline-flex';
      } else {
        notifBtn.textContent = '🔔 Attiva le notifiche';
        notifBtn.disabled = false;
      }
    } catch(e) {
      notifBtn.textContent = '🔔 Attiva le notifiche';
      notifBtn.disabled = false;
    }
  });
})();
</script>
</body>
</html>`);
});

module.exports = router;
