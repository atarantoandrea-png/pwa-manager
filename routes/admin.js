const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const db = require('../db/db');
const { firstNextRun } = require('../lib/scheduler');

// Multer for icon uploads
const storage = multer.diskStorage({
  destination: path.join(__dirname, '../public/uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `icon-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Auth middleware
const requireAuth = (req, res, next) => {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: 'Non autorizzato' });
};

// ─── AUTH ───────────────────────────────────────────────────────────────────

router.post('/auth/login', (req, res) => {
  const { password } = req.body;
  const okPass = (process.env.ADMIN_PASSWORD || 'Angra.120');
  if (password === okPass) {
    req.session.admin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Credenziali non valide' });
  }
});

router.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  res.json({ admin: !!req.session?.admin });
});

// ─── APPS ────────────────────────────────────────────────────────────────────

router.get('/apps', requireAuth, (req, res) => {
  const apps = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM subscriptions WHERE app_id = a.id) as sub_count,
      (SELECT COUNT(*) FROM notifications WHERE app_id = a.id) as notif_count
    FROM apps a ORDER BY a.created_at DESC
  `).all();
  res.json(apps);
});

router.post('/apps', requireAuth, (req, res) => {
  const { name, slug, description, site_url, bg_color, theme_color, display } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Nome e slug obbligatori' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Slug: solo lettere minuscole, numeri e trattini' });

  const keys = webpush.generateVAPIDKeys();
  try {
    const result = db.prepare(`
      INSERT INTO apps (name, slug, description, site_url, bg_color, theme_color, display, vapid_public, vapid_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, slug, description || '', site_url || '', bg_color || '#ffffff', theme_color || '#6366f1', display || 'standalone', keys.publicKey, keys.privateKey);
    const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(result.lastInsertRowid);
    res.json(app);
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Slug già in uso' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/apps/:id', requireAuth, (req, res) => {
  const app = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM subscriptions WHERE app_id = a.id) as sub_count,
      (SELECT COUNT(*) FROM notifications WHERE app_id = a.id) as notif_count,
      (SELECT COUNT(*) FROM subscriptions WHERE app_id = a.id AND platform = 'ios') as ios_count,
      (SELECT COUNT(*) FROM subscriptions WHERE app_id = a.id AND platform = 'android') as android_count,
      (SELECT COUNT(*) FROM subscriptions WHERE app_id = a.id AND platform = 'desktop') as desktop_count
    FROM apps a WHERE a.id = ?
  `).get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });
  res.json(app);
});

router.put('/apps/:id', requireAuth, (req, res) => {
  const { name, description, site_url, install_url, bg_color, theme_color, display } = req.body;
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });
  db.prepare(`
    UPDATE apps SET name=?, description=?, site_url=?, install_url=?, bg_color=?, theme_color=?, display=?
    WHERE id=?
  `).run(name || app.name, description ?? app.description, site_url ?? app.site_url,
         install_url ?? app.install_url ?? '', bg_color || app.bg_color,
         theme_color || app.theme_color, display || app.display, req.params.id);
  res.json(db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id));
});

router.delete('/apps/:id', requireAuth, (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });
  if (app.icon_path) {
    const iconFile = path.join(__dirname, '../public/uploads', path.basename(app.icon_path));
    if (fs.existsSync(iconFile)) fs.unlinkSync(iconFile);
  }
  db.prepare('DELETE FROM apps WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Icon upload
router.post('/apps/:id/icon', requireAuth, upload.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file' });
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });
  if (app.icon_path) {
    const old = path.join(__dirname, '../public/uploads', path.basename(app.icon_path));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const iconPath = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE apps SET icon_path = ? WHERE id = ?').run(iconPath, req.params.id);
  res.json({ icon_path: iconPath });
});

// ─── SUBSCRIBERS ─────────────────────────────────────────────────────────────

router.get('/apps/:id/subscribers', requireAuth, (req, res) => {
  const subs = db.prepare(`
    SELECT id, endpoint, platform, user_agent, created_at
    FROM subscriptions WHERE app_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(req.params.id);
  res.json(subs);
});

router.delete('/apps/:id/subscribers/:subId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE id = ? AND app_id = ?').run(req.params.subId, req.params.id);
  res.json({ ok: true });
});

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────

router.get('/apps/:id/notifications', requireAuth, (req, res) => {
  const notifs = db.prepare(`
    SELECT * FROM notifications WHERE app_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.id);
  res.json(notifs);
});

router.post('/apps/:id/notify', requireAuth, async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });

  const { title, body, icon_url, action_url, image_url } = req.body;
  if (!title) return res.status(400).json({ error: 'Titolo obbligatorio' });

  const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
  const subject = app.site_url ? `mailto:admin@${new URL(app.site_url).hostname}` : `mailto:admin@pwa-manager.local`;

  webpush.setVapidDetails(subject, app.vapid_public, app.vapid_private);

  const subs = db.prepare('SELECT * FROM subscriptions WHERE app_id = ?').all(app.id);
  const payload = JSON.stringify({
    title,
    body: body || '',
    icon: icon_url || (app.icon_path ? BASE_URL + app.icon_path : ''),
    url: action_url || app.site_url || '/',
    image: image_url || ''
  });

  let sent = 0, failed = 0;
  const removeIds = [];

  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, payload);
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

  const notif = db.prepare(`
    INSERT INTO notifications (app_id, title, body, icon_url, action_url, image_url, sent_count, failed_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(app.id, title, body || '', icon_url || '', action_url || '', image_url || '', sent, failed);

  res.json({ ok: true, sent, failed, removed: removeIds.length });
});

// ─── NOTIFICHE PROGRAMMATE (ricorrenti) ───────────────────────────────────────

router.get('/apps/:id/scheduled', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM scheduled_notifications WHERE app_id = ? ORDER BY active DESC, next_run_at ASC
  `).all(req.params.id);
  res.json(rows);
});

router.post('/apps/:id/scheduled', requireAuth, (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'App non trovata' });

  const { title, body, icon_url, action_url, image_url, time_hhmm } = req.body;
  if (!title) return res.status(400).json({ error: 'Titolo obbligatorio' });
  let everyN = parseInt(req.body.every_n_days, 10);
  if (isNaN(everyN) || everyN < 1) everyN = 1;
  const time = /^\d{1,2}:\d{2}$/.test(time_hhmm || '') ? time_hhmm : '09:00';

  const nextRun = firstNextRun(time, Date.now());
  const info = db.prepare(`
    INSERT INTO scheduled_notifications (app_id, title, body, icon_url, action_url, image_url, time_hhmm, every_n_days, active, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(app.id, title, body || '', icon_url || '', action_url || '', image_url || '', time, everyN, nextRun);

  res.json(db.prepare('SELECT * FROM scheduled_notifications WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/apps/:id/scheduled/:sid', requireAuth, (req, res) => {
  const cur = db.prepare('SELECT * FROM scheduled_notifications WHERE id = ? AND app_id = ?').get(req.params.sid, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Notifica non trovata' });

  const title = req.body.title != null ? req.body.title : cur.title;
  const body = req.body.body != null ? req.body.body : cur.body;
  const icon_url = req.body.icon_url != null ? req.body.icon_url : cur.icon_url;
  const action_url = req.body.action_url != null ? req.body.action_url : cur.action_url;
  const image_url = req.body.image_url != null ? req.body.image_url : cur.image_url;
  const time = /^\d{1,2}:\d{2}$/.test(req.body.time_hhmm || '') ? req.body.time_hhmm : cur.time_hhmm;
  let everyN = req.body.every_n_days != null ? parseInt(req.body.every_n_days, 10) : cur.every_n_days;
  if (isNaN(everyN) || everyN < 1) everyN = 1;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : cur.active;

  // Ricalcola il prossimo invio se cambia orario, o se viene riattivata
  let nextRun = cur.next_run_at;
  const timeChanged = time !== cur.time_hhmm;
  const reactivated = active === 1 && cur.active === 0;
  if (timeChanged || reactivated || !nextRun) nextRun = firstNextRun(time, Date.now());

  db.prepare(`
    UPDATE scheduled_notifications
    SET title=?, body=?, icon_url=?, action_url=?, image_url=?, time_hhmm=?, every_n_days=?, active=?, next_run_at=?
    WHERE id=?
  `).run(title, body, icon_url, action_url, image_url, time, everyN, active, nextRun, cur.id);

  res.json(db.prepare('SELECT * FROM scheduled_notifications WHERE id = ?').get(cur.id));
});

router.delete('/apps/:id/scheduled/:sid', requireAuth, (req, res) => {
  db.prepare('DELETE FROM scheduled_notifications WHERE id = ? AND app_id = ?').run(req.params.sid, req.params.id);
  res.json({ ok: true });
});

module.exports = router;
