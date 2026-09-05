'use strict';

const mysql = require('mysql2/promise');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'property_billing',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  dateStrings: true
};

let pool = null;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
  }
  return pool;
}

async function query(sql, params) {
  const p = await getPool();
  const [rows] = await p.execute(sql, params);
  return rows;
}

async function transaction(fn) {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function initDb() {
  const p = await getPool();
  const conn = await p.getConnection();
  try {
    const [tables] = await conn.query(`
      SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('users','settings','tenants','meters','readings')
    `, [dbConfig.database]);
    const existing = new Set(tables.map(t => t.TABLE_NAME));
    if (!existing.has('users')) {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(50) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          role ENUM('admin','user') NOT NULL DEFAULT 'admin',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    if (!existing.has('settings')) {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS settings (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          company_name VARCHAR(200) NOT NULL DEFAULT '示例物业服务有限公司',
          phone VARCHAR(50) DEFAULT '0571-88888888',
          bank_name VARCHAR(200) DEFAULT '中国工商银行杭州分行',
          account_holder VARCHAR(200) DEFAULT '示例物业服务有限公司',
          bank_account VARCHAR(100) DEFAULT '1202 0200 0990 0000 000',
          wechat_qr LONGTEXT,
          alipay_qr LONGTEXT,
          seal_image LONGTEXT,
          due_days INT NOT NULL DEFAULT 5,
          reminder_note TEXT,
          footer_note TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`INSERT INTO settings (id) VALUES (1)`);
    }
    if (!existing.has('tenants')) {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS tenants (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          name VARCHAR(200) NOT NULL,
          room VARCHAR(200) NOT NULL,
          phone VARCHAR(50) DEFAULT '',
          contract_start DATE DEFAULT NULL,
          contract_end DATE DEFAULT NULL,
          rent DECIMAL(12,2) NOT NULL DEFAULT 0,
          parking DECIMAL(12,2) NOT NULL DEFAULT 0,
          garbage DECIMAL(12,2) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    if (!existing.has('meters')) {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS meters (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          tenant_id VARCHAR(36) NOT NULL,
          name VARCHAR(200) NOT NULL,
          type ENUM('electricity','water') NOT NULL,
          price DECIMAL(12,4) NOT NULL DEFAULT 0,
          unit VARCHAR(20) NOT NULL DEFAULT '',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
    if (!existing.has('readings')) {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS readings (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          meter_id VARCHAR(36) NOT NULL,
          month CHAR(7) NOT NULL,
          value DECIMAL(12,2) NOT NULL DEFAULT 0,
          reading_time DATETIME DEFAULT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_meter_month (meter_id, month),
          FOREIGN KEY (meter_id) REFERENCES meters(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    }
  } finally {
    conn.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
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
