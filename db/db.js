const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/pwa-manager.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    site_url TEXT DEFAULT '',
    icon_path TEXT DEFAULT '',
    bg_color TEXT DEFAULT '#ffffff',
    theme_color TEXT DEFAULT '#6366f1',
    display TEXT DEFAULT 'standalone',
    orientation TEXT DEFAULT 'any',
    vapid_public TEXT,
    vapid_private TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    platform TEXT DEFAULT 'unknown',
    user_agent TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    icon_url TEXT DEFAULT '',
    action_url TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    sent_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
  );
`);

// Migrations
try { db.exec(`ALTER TABLE apps ADD COLUMN install_url TEXT DEFAULT ''`); } catch(e) {}

module.exports = db;
