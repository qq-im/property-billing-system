'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'app.db');

let db = null;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA foreign_keys = ON');
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function execute(sql, params = []) {
  return new Promise((resolve, reject) => {
    const trimmed = sql.trim().toLowerCase();
    if (trimmed.startsWith('select')) {
      getDb().all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve([rows]);
      });
    } else {
      getDb().run(sql, params, function(err) {
        if (err) return reject(err);
        resolve([{ lastID: this.lastID, changes: this.changes }]);
      });
    }
  });
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function transaction(fn) {
  const d = getDb();
  await run('BEGIN TRANSACTION');
  try {
    const result = await fn({
      execute: (sql, params) => run(sql, params)
    });
    await run('COMMIT');
    return result;
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
}

async function initDb() {
  const fs = require('fs');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const d = getDb();
  const tables = await query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','settings','tenants','meters','readings')`);
  const existing = new Set(tables.map(t => t.name));

  if (!existing.has('users')) {
    await run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  if (!existing.has('settings')) {
    await run(`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL DEFAULT '示例物业服务有限公司',
        phone TEXT DEFAULT '0571-88888888',
        bank_name TEXT DEFAULT '中国工商银行杭州分行',
        account_holder TEXT DEFAULT '示例物业服务有限公司',
        bank_account TEXT DEFAULT '1202 0200 0990 0000 000',
        wechat_qr TEXT,
        alipay_qr TEXT,
        seal_image TEXT,
        due_days INTEGER NOT NULL DEFAULT 5,
        reminder_note TEXT,
        footer_note TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await run(`INSERT INTO settings (id) VALUES (1)`);
  }
  if (!existing.has('tenants')) {
    await run(`
      CREATE TABLE tenants (
        id TEXT NOT NULL PRIMARY KEY,
        name TEXT NOT NULL,
        room TEXT NOT NULL,
        phone TEXT DEFAULT '',
        contract_start DATE DEFAULT NULL,
        contract_end DATE DEFAULT NULL,
        rent REAL NOT NULL DEFAULT 0,
        parking REAL NOT NULL DEFAULT 0,
        garbage REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  if (!existing.has('meters')) {
    await run(`
      CREATE TABLE meters (
        id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        price REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);
  }
  if (!existing.has('readings')) {
    await run(`
      CREATE TABLE readings (
        id TEXT NOT NULL PRIMARY KEY,
        meter_id TEXT NOT NULL,
        month TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0,
        reading_time DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meter_id, month),
        FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE CASCADE
      )
    `);
  }
}

function closePool() {
  return new Promise((resolve) => {
    if (db) {
      db.close((err) => {
        db = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function getPool() {
  return { getConnection: () => Promise.resolve({ execute, release: () => {}, commit: () => Promise.resolve(), rollback: () => Promise.resolve(), beginTransaction: () => Promise.resolve() }) };
}



async function upsert(table, data, keyColumn) {
  const existing = await query(`SELECT ${keyColumn} FROM ${table} WHERE ${keyColumn} = ?`, [data[keyColumn]]);
  if (existing.length > 0) {
    const keys = Object.keys(data).filter(k => k !== keyColumn);
    const setClause = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => data[k]);
    await query(`UPDATE ${table} SET ${setClause} WHERE ${keyColumn} = ?`, [...values, data[keyColumn]]);
  } else {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    await query(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`, Object.values(data));
  }
}

module.exports = { query, transaction, initDb, closePool, getPool, upsert };
