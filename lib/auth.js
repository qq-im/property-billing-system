'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const TOKEN_EXPIRES = '7d';

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function signToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function authMiddleware(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload) return null;
  return payload;
}

async function getDefaultUser() {
  const rows = await query('SELECT id, username, role FROM users WHERE username = ?', ['admin']);
  return rows[0] || null;
}

async function ensureDefaultUser() {
  const rows = await query('SELECT id FROM users WHERE username = ?', ['admin']);
  if (rows.length === 0) {
    const hash = hashPassword(process.env.DEFAULT_PASSWORD || 'admin123');
    await query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      ['admin', hash, 'admin']
    );
    console.log('[auth] 已创建默认管理员账号：admin / ' + (process.env.DEFAULT_PASSWORD || 'admin123'));
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  authMiddleware,
  getDefaultUser,
  ensureDefaultUser
};
