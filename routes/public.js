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
  const iconUrl = app.icon_path ? base + app.icon_path : '';
  res.send(`
(function() {
  var SLUG = '${app.slug}';
  var BASE = '${base}';
  var VAPID = '${app.vapid_public}';
  var SUBSCRIBE_URL = BASE + '/' + SLUG + '/subscribe';
  var APP_NAME = ${JSON.stringify(app.name || '')};
  var ICON_URL = ${JSON.stringify(iconUrl)};
  var THEME = ${JSON.stringify(app.theme_color || '#6366f1')};
  var BG = ${JSON.stringify(app.bg_color || '#ffffff')};
  var SITE_URL = ${JSON.stringify(app.site_url || '')};

  // ─── iOS / PWA: inietta i tag che servono per la modalità standalone ─────────
  // Senza "apple-mobile-web-app-capable" iOS apre l'icona come scorciatoia Safari
  // (con barra indietro/condividi/ricarica). Questo la rende un'app full-screen,
  // esattamente come fa Progressier. Nessun file da caricare sul sito.
  (function injectPwaTags() {
    var head = document.head || document.documentElement;

    // Override tramite window.__pwaManagerOverride (impostato dall'embed PRIMA che
    // questo script carichi — document.currentScript è null per script asincroni)
    var ov = window.__pwaManagerOverride || {};
    var effectiveIconUrl = ov.iconUrl || ICON_URL;
    var effectiveName    = ov.appName  || APP_NAME;
    var overrideStartUrl = ov.startUrl || null;

    // Imposta un meta, sostituendo qualsiasi valore già presente (es. da systeme.io)
    function meta(name, content) {
      var existing = document.querySelector('meta[name="' + name + '"]');
      if (existing) existing.parentNode.removeChild(existing);
      var m = document.createElement('meta');
      m.setAttribute('name', name);
      m.setAttribute('content', content);
      head.appendChild(m);
    }
    meta('apple-mobile-web-app-capable', 'yes');
    meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    if (effectiveName) meta('apple-mobile-web-app-title', effectiveName);
    if (THEME) meta('theme-color', THEME);
    // Sostituisce apple-touch-icon esistente (systeme.io ne mette uno suo)
    if (effectiveIconUrl) {
      var existingIcon = document.querySelector('link[rel="apple-touch-icon"]');
      if (existingIcon) existingIcon.parentNode.removeChild(existingIcon);
      var l = document.createElement('link');
      l.setAttribute('rel', 'apple-touch-icon');
      l.setAttribute('href', effectiveIconUrl);
      head.appendChild(l);
    }
    // Manifest SAME-ORIGIN via Blob: iOS/Android vietano un manifest cross-origin
    // (start_url/scope devono essere stesso origin del documento). Generandolo come
    // Blob sul dominio del sito, start_url punta al sito stesso ed è valido.
    try {
      var origin = window.location.origin;
      var startUrl = overrideStartUrl ||
        ((SITE_URL && SITE_URL.indexOf(origin) === 0) ? SITE_URL : (origin + '/'));
      var mf = {
        name: effectiveName,
        short_name: effectiveName,
        start_url: startUrl,
        scope: origin + '/',
        display: 'standalone',
        background_color: BG,
        theme_color: THEME,
        icons: effectiveIconUrl ? [
          { src: effectiveIconUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: effectiveIconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' }
        ] : []
      };
      var blob = new Blob([JSON.stringify(mf)], { type: 'application/manifest+json' });
      var blobUrl = URL.createObjectURL(blob);
      var existing = document.querySelector('link[rel="manifest"]');
      if (existing) existing.parentNode.removeChild(existing);
      var ml = document.createElement('link');
      ml.setAttribute('rel', 'manifest');
      ml.setAttribute('href', blobUrl);
      head.appendChild(ml);
    } catch (e) { /* Blob non supportato: i meta apple bastano comunque per iOS */ }
  })();

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
    var isOnManager = (window.location.hostname === new URL(BASE).hostname);
    if (isOnManager) {
      navigator.serviceWorker.register('/' + SLUG + '/sw.js', { scope: '/' + SLUG + '/' }).catch(function(e) {
        console.warn('[PWAManager] SW registration failed:', e);
      });
    } else {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function(e) {
        console.warn('[PWAManager] SW registration failed:', e);
      });
    }
  }

  // ─── Auto-prompt notifiche (standalone, prima apertura) ─────────────────────
  (function() {
    var SNOOZE_KEY = 'pwa_notif_snooze_' + SLUG;
    var SHOWN_KEY  = 'pwa_notif_shown_'  + SLUG;

    function isStandalone() {
      return window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }

    function shouldShow() {
      if (!('Notification' in window)) return false;
      if (Notification.permission !== 'default') return false;
      if (!isStandalone()) return false;
      var snooze = localStorage.getItem(SNOOZE_KEY);
      if (snooze && Date.now() < parseInt(snooze, 10)) return false;
      return true;
    }

    function showPrompt() {
      if (!shouldShow()) return;
      if (document.getElementById('pwa-notif-sheet')) return;

      var sheet = document.createElement('div');
      sheet.id = 'pwa-notif-sheet';
      sheet.style.cssText = [
        'position:fixed;bottom:0;left:0;right:0;z-index:2147483647',
        'padding:0 12px calc(16px + env(safe-area-inset-bottom))',
        'pointer-events:none'
      ].join(';');

      sheet.innerHTML = [
        '<style>',
        '@keyframes pwa-slide{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}',
        '</style>',
        '<div id="pwa-notif-card" style="',
          'background:rgba(22,18,32,.97);',
          'border:1px solid rgba(185,163,227,.22);',
          'border-radius:20px;padding:18px 18px 16px;',
          'display:flex;align-items:center;gap:14px;',
          'box-shadow:0 -4px 40px rgba(0,0,0,.6);',
          'pointer-events:all;',
          'animation:pwa-slide .38s cubic-bezier(.2,.8,.25,1) both;',
          'font-family:-apple-system,BlinkMacSystemFont,sans-serif;',
        '">',
          '<div style="font-size:26px;flex-shrink:0">🔔</div>',
          '<div style="flex:1;min-width:0">',
            '<div style="font-size:15px;font-weight:600;color:#e8e2f0;line-height:1.3">Resta in contatto</div>',
            '<div style="font-size:13px;color:#9d94ab;margin-top:3px;line-height:1.4">Ricevi un avviso quando ci sono nuovi contenuti</div>',
          '</div>',
          '<div style="display:flex;gap:8px;flex-shrink:0">',
            '<button id="pwa-notif-later" style="',
              'background:transparent;border:1px solid rgba(185,163,227,.3);',
              'color:#9d94ab;border-radius:10px;padding:8px 13px;',
              'font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;',
            '">Più tardi</button>',
            '<button id="pwa-notif-ok" style="',
              'background:linear-gradient(135deg,#c9b3ef,#a98fd6);',
              'border:none;color:#1c1428;border-radius:10px;padding:8px 14px;',
              'font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;',
            '">Attiva</button>',
          '</div>',
        '</div>'
      ].join('');

      document.body.appendChild(sheet);

      document.getElementById('pwa-notif-ok').addEventListener('click', async function() {
        document.getElementById('pwa-notif-ok').textContent = '…';
        document.getElementById('pwa-notif-ok').disabled = true;
        try {
          var sub = await subscribe();
          if (sub) { localStorage.setItem(SHOWN_KEY, '1'); }
        } catch(e) {}
        sheet.remove();
      });

      document.getElementById('pwa-notif-later').addEventListener('click', function() {
        localStorage.setItem(SNOOZE_KEY, String(Date.now() + 3 * 24 * 60 * 60 * 1000));
        sheet.remove();
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { setTimeout(showPrompt, 3500); });
    } else {
      setTimeout(showPrompt, 3500);
    }
  })();
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

// Genera l'HTML della pagina install (riusato da /:slug/install e /:slug/install.html)
function buildInstallHtml(app, base) {
  const iconUrl = app.icon_path ? base + app.icon_path : '';
  const siteUrl = app.site_url || '';
  const subCount = db.prepare('SELECT COUNT(*) as n FROM subscriptions WHERE app_id = ?').get(app.id).n;
  const accent = app.theme_color || '#6366f1';
  const bg = app.bg_color || '#ffffff';
  return `<!DOCTYPE html>` + `
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Installa ${app.name}</title>
<!-- Se già installata (standalone), apri subito l'app vera.
     Su iPhone NON installato: rimanda al sito vero, perché iOS blocca la modalità
     full-screen al dominio dell'install. Installando dal sito (dove gira init.js)
     l'app si apre senza barra Safari. -->
<script>
(function(){
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var site = '${siteUrl}';
  if (standalone && site) { window.location.replace(site); }
})();
</script>
<link rel="manifest" href="${base}/${app.slug}/manifest.json" crossorigin="use-credentials">
<meta name="theme-color" content="${accent}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${app.name}">
${iconUrl ? `<link rel="apple-touch-icon" href="${iconUrl}">` : ''}
<script src="${base}/${app.slug}/init.js" defer><\/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--accent:${accent};--bg:${bg}}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f0f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:white;border-radius:24px;padding:40px 32px;max-width:400px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.12)}
.app-icon{width:100px;height:100px;border-radius:22px;margin:0 auto 20px;object-fit:cover;background:var(--accent);display:flex;align-items:center;justify-content:center;overflow:hidden}
.app-icon img{width:100%;height:100%;object-fit:cover}
.icon-placeholder{font-size:48px;color:white;font-weight:700}
h1{font-size:24px;font-weight:700;color:#111;margin-bottom:8px}
.desc{font-size:15px;color:#666;margin-bottom:8px;line-height:1.5}
.sub-count{font-size:13px;color:#999;margin-bottom:28px}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:white;border:none;border-radius:14px;padding:14px 28px;font-size:16px;font-weight:600;cursor:pointer;width:100%;justify-content:center;transition:opacity .2s}
.btn:hover{opacity:.88}.btn:disabled{opacity:.5;cursor:default}
.divider{height:1px;background:#eee;margin:24px 0}
.steps{text-align:left}
.steps h3{font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.step{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px}
.step-num{width:24px;height:24px;border-radius:50%;background:var(--accent);color:white;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step p{font-size:14px;color:#444;line-height:1.5}
.step p strong{color:#111}
.notif-btn{margin-top:16px;background:white;color:var(--accent);border:2px solid var(--accent);border-radius:14px;padding:13px 28px;font-size:15px;font-weight:600;cursor:pointer;width:100%;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .2s}
.notif-btn:hover{background:var(--accent);color:white}
.success-badge{display:inline-flex;align-items:center;gap:6px;background:#d1fae5;color:#065f46;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;margin-top:12px}
footer{margin-top:24px;font-size:12px;color:#aaa}
</style>
</head>
<body>
<div class="card">
  <div class="app-icon">
    ${iconUrl ? `<img src="${iconUrl}" alt="${app.name}">` : `<div class="icon-placeholder">${app.name[0]}</div>`}
  </div>
  <h1>${app.name}</h1>
  ${app.description ? `<p class="desc">${app.description}</p>` : ''}
  ${subCount > 0 ? `<p class="sub-count">Unisciti a ${subCount.toLocaleString()} ${subCount === 1 ? 'persona' : 'persone'} che hanno già installato l'app</p>` : ''}

  <div id="ios-steps" class="steps" style="display:none">
    <h3>Installa su iPhone / iPad</h3>
    ${siteUrl ? `<div class="step"><div class="step-num">1</div><p>Apri <strong><a href="${siteUrl}" style="color:var(--accent);text-decoration:none">${siteUrl.replace(/^https?:\/\//, '')}</a></strong> in Safari</p></div>
    <div class="step"><div class="step-num">2</div><p>Tocca il pulsante <strong>Condividi</strong> &#x2197; nella barra di Safari</p></div>
    <div class="step"><div class="step-num">3</div><p>Scorri e tocca <strong>"Aggiungi a Home"</strong></p></div>
    <div class="step"><div class="step-num">4</div><p>Tocca <strong>Aggiungi</strong> — l'icona apparirà sulla schermata Home</p></div>` : `<div class="step"><div class="step-num">1</div><p>Tocca il pulsante <strong>Condividi</strong> &#x2197; nella barra di Safari</p></div>
    <div class="step"><div class="step-num">2</div><p>Scorri e tocca <strong>"Aggiungi a Home"</strong></p></div>
    <div class="step"><div class="step-num">3</div><p>Tocca <strong>Aggiungi</strong> — l'icona apparirà sulla schermata Home</p></div>`}
  </div>

  <div id="android-steps" class="steps" style="display:none">
    <h3>Installa su Android</h3>
    <div class="step"><div class="step-num">1</div><p>Tocca <strong>⋮</strong> in alto a destra del browser</p></div>
    <div class="step"><div class="step-num">2</div><p>Tocca <strong>"Installa app"</strong></p></div>
    <div class="step"><div class="step-num">3</div><p>Tocca <strong>Installa</strong></p></div>
  </div>

  <button class="btn" id="install-btn" style="display:none">📲 Installa l'app</button>
  <div id="installed-badge" class="success-badge" style="display:none">✓ App installata!</div>

  <div class="divider"></div>
  <button class="notif-btn" id="notif-btn">🔔 Attiva le notifiche</button>
  <div id="notif-ok" class="success-badge" style="display:none">✓ Notifiche attivate!</div>
</div>
<footer>Powered by PWA Manager</footer>
<script>
(function(){
  var ua = navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  var isAndroid = /Android/.test(ua);
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) { document.getElementById('installed-badge').style.display='inline-flex'; }
  else if (isIOS) { document.getElementById('ios-steps').style.display='block'; }
  else { document.getElementById('android-steps').style.display='block'; }
  var deferred;
  window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); deferred=e; document.getElementById('install-btn').style.display='inline-flex'; });
  document.getElementById('install-btn').addEventListener('click', async function(){
    if(!deferred)return; deferred.prompt();
    var r=await deferred.userChoice;
    if(r.outcome==='accepted'){document.getElementById('install-btn').style.display='none';document.getElementById('installed-badge').style.display='inline-flex';}
    deferred=null;
  });
  window.addEventListener('appinstalled',function(){document.getElementById('install-btn').style.display='none';document.getElementById('installed-badge').style.display='inline-flex';});
  var nb=document.getElementById('notif-btn');
  if(!('Notification' in window)){nb.style.display='none';}
  else if(Notification.permission==='granted'){nb.style.display='none';document.getElementById('notif-ok').style.display='inline-flex';}
  nb.addEventListener('click', async function(){
    nb.disabled=true; nb.textContent='Attivazione…';
    try{var s=await window.PWAManager.subscribe();if(s){nb.style.display='none';document.getElementById('notif-ok').style.display='inline-flex';}else{nb.textContent='🔔 Attiva le notifiche';nb.disabled=false;}}
    catch(e){nb.textContent='🔔 Attiva le notifiche';nb.disabled=false;}
  });
})();
</script>
</body>
</html>`;
}

// /:slug/install → reindirizza alla pagina /install SELF-HOSTED sul dominio del sito.
// iOS, quando fai "Aggiungi a Home", apre solo URL dello stesso dominio dell'app:
// se l'install page sta sul manager (cross-origin), l'app installata apre Safari
// con la barra invece del full-screen. Per questo il link deve rimbalzare al sito,
// dove i meta apple statici + manifest same-origin fanno partire lo standalone.
// (Le app servite da piattaforme senza /install — es. systeme.io — non usano questa route.)
router.get('/:slug/install', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('App not found');
  if (app.site_url) {
    try {
      const origin = new URL(app.site_url).origin;
      return res.redirect(302, origin + '/install');
    } catch (e) { /* site_url non valido: mostra la pagina locale del manager */ }
  }
  const base = BASE_URL();
  res.setHeader('Content-Type', 'text/html');
  res.send(buildInstallHtml(app, base));
});

// /:slug/install.html → scarica la pagina install pre-configurata da mettere sul sito target
router.get('/:slug/install.html', (req, res) => {
  const app = getApp(req.params.slug);
  if (!app) return res.status(404).send('App not found');
  const base = BASE_URL();
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="install.html"`);
  res.send(buildInstallHtml(app, base));
});

module.exports = router;
