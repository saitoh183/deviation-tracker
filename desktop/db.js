const Database = require('better-sqlite3');
const path = require('path');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char_name TEXT NOT NULL,
  name TEXT NOT NULL,
  variant TEXT DEFAULT '',
  trait1 TEXT DEFAULT '',
  trait2 TEXT DEFAULT '',
  trait3 TEXT DEFAULT '',
  trait4 TEXT DEFAULT '',
  trait5 TEXT DEFAULT '',
  skill INTEGER DEFAULT 0,
  activity INTEGER DEFAULT 0,
  eland INTEGER DEFAULT 0,
  fusion INTEGER DEFAULT 0,
  locked INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_traits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  effect TEXT DEFAULT '',
  neg INTEGER DEFAULT 0,
  deviants TEXT DEFAULT 'ALL',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trait_assignments (
  deviant_name TEXT NOT NULL,
  trait_name TEXT NOT NULL,
  PRIMARY KEY (deviant_name, trait_name)
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  qty INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0
);
`;

function initDB(userDataPath) {
  const dbPath = path.join(userDataPath, 'deviation-tracker.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function getDB() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

module.exports = { initDB, getDB };
