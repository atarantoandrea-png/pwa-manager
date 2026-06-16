// Scheduler per notifiche programmate (ricorrenti) — invio automatico lato server.
// Gli orari sono in ora italiana (Europe/Rome); convertiti in UTC tenendo conto dell'ora legale.
const webpush = require('web-push');
const db = require('../db/db');

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3000';
const TZ = 'Europe/Rome';

// ─── Helper fuso orario (Europe/Rome ↔ UTC) ─────────────────────────────────
function romeParts(utcMs) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour12: false });
  const o = {};
  for (const p of f.formatToParts(new Date(utcMs))) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
  return { y: o.year, mo: o.month - 1, d: o.day };
}
function romeOffsetMs(utcMs) {
  const d = new Date(utcMs);
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return local.getTime() - utc.getTime();
}
function romeWallToUtc(y, mo, d, hh, mm) {
  const guess = Date.UTC(y, mo, d, hh, mm, 0);
  const off = romeOffsetMs(guess);
  let utc = guess - off;
  const off2 = romeOffsetMs(utc);
  if (off2 !== off) utc = guess - off2;
  return utc;
}
function parseHHMM(s) {
  const parts = String(s || '09:00').split(':');
  let h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || h < 0 || h > 23) h = 9;
  if (isNaN(m) || m < 0 || m > 59) m = 0;
  return [h, m];
}

// Primo invio: oggi all'orario indicato se è ancora futuro, altrimenti domani.
function firstNextRun(hhmm, fromMs) {
  const [hh, mm] = parseHHMM(hhmm);
  const p = romeParts(fromMs);
  let utc = romeWallToUtc(p.y, p.mo, p.d, hh, mm);
  let guard = 0;
  while (utc <= fromMs && guard++ < 5) {
    const np = romeParts(utc + 24 * 3600 * 1000);
    utc = romeWallToUtc(np.y, np.mo, np.d, hh, mm);
  }
  return Math.floor(utc / 1000);
}

// Avanza al prossimo invio (ogni N giorni), saltando eventuali invii persi (no spam).
function advanceRun(prevSec, hhmm, everyN) {
  const [hh, mm] = parseHHMM(hhmm);
  const nowSec = Math.floor(Date.now() / 1000);
  const step = Math.max(1, parseInt(everyN, 10) || 1);
  let cur = prevSec;
  let guard = 0;
  do {
    const p = romeParts(cur * 1000);
    cur = Math.floor(romeWallToUtc(p.y, p.mo, p.d + step, hh, mm) / 1000);
  } while (cur <= nowSec && guard++ < 2000);
  return cur;
}

// ─── Invio push a tutti gli iscritti di un'app ──────────────────────────────
async function sendToApp(app, n) {
  let subject;
  try { subject = app.site_url ? `mailto:admin@${new URL(app.site_url).hostname}` : 'mailto:admin@pwa-manager.local'; }
  catch (e) { subject = 'mailto:admin@pwa-manager.local'; }
  webpush.setVapidDetails(subject, app.vapid_public, app.vapid_private);

  const subs = db.prepare('SELECT * FROM subscriptions WHERE app_id = ?').all(app.id);
  const payload = JSON.stringify({
    title: n.title,
    body: n.body || '',
    icon: n.icon_url || (app.icon_path ? BASE_URL() + app.icon_path : ''),
    url: n.action_url || app.site_url || '/',
    image: n.image_url || ''
  });

  let sent = 0, failed = 0;
  const removeIds = [];
  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      sent++;
    } catch (e) {
      failed++;
      if (e.statusCode === 410 || e.statusCode === 404) removeIds.push(sub.id);
    }
  }));
  if (removeIds.length) {
    const ph = removeIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM subscriptions WHERE id IN (${ph})`).run(...removeIds);
  }
  db.prepare(`INSERT INTO notifications (app_id, title, body, icon_url, action_url, image_url, sent_count, failed_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(app.id, n.title, n.body || '', n.icon_url || '', n.action_url || '', n.image_url || '', sent, failed);
  return { sent, failed };
}

// ─── Loop ───────────────────────────────────────────────────────────────────
let _timer = null;
async function tick() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const due = db.prepare('SELECT * FROM scheduled_notifications WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now);
    for (const n of due) {
      const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(n.app_id);
      if (!app) { db.prepare('UPDATE scheduled_notifications SET active = 0 WHERE id = ?').run(n.id); continue; }
      let res = { sent: 0, failed: 0 };
      try { res = await sendToApp(app, n); } catch (e) { console.error('[scheduler] send error', e.message); }
      const next = advanceRun(n.next_run_at, n.time_hhmm, n.every_n_days);
      db.prepare('UPDATE scheduled_notifications SET last_run_at = ?, last_sent = ?, next_run_at = ? WHERE id = ?')
        .run(now, res.sent, next, n.id);
      console.log(`[scheduler] inviata "${n.title}" (app ${app.slug}) → ${res.sent} iscritti; prossima: ${new Date(next * 1000).toISOString()}`);
    }
  } catch (e) {
    console.error('[scheduler] tick error', e);
  }
}

function start() {
  if (_timer) return;
  _timer = setInterval(tick, 60 * 1000);
  setTimeout(tick, 5000); // primo giro poco dopo l'avvio
  console.log('[scheduler] avviato (controllo ogni 60s, fuso ' + TZ + ')');
}

module.exports = { start, firstNextRun, advanceRun };
