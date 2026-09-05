'use strict';

/* ============================================================
 * 物业与租户综合账单管理系统 — Node.js + MySQL 服务端
 * 运行方式: node server.js   (默认 http://localhost:3000)
 * 环境变量: .env
 * ============================================================ */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readXlsx, writeXlsx } = require('./lib/xlsx');
const { createImporter } = require('./lib/importer');
const { query, transaction, initDb, closePool, upsert } = require('./lib/db');
const { hashPassword, verifyPassword, signToken, authMiddleware, ensureDefaultUser } = require('./lib/auth');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 30 * 1024 * 1024;
const MAX_IMAGE_DATA_URL = 8 * 1024 * 1024;

/* ---------------- 工具函数 ---------------- */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const uid = () => crypto.randomUUID();

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toNum(v, def = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function str(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function isDataUrl(v) {
  if (typeof v !== 'string' || !v) return '';
  if (v.length > MAX_IMAGE_DATA_URL) return '';
  if (!/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,/.test(v)) return '';
  return v;
}

function currentMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fmtDateTime(d) {
  return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeTime(v) {
  if (typeof v !== 'string') return '';
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(v.trim());
  return m ? m[1] + ' ' + m[2] : '';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : fmtDate(d);
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  const text = buf.toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('JSON 格式错误');
  }
}

/* ---------------- 人民币大写 ---------------- */
function rmbUpper(amount) {
  const D = '零壹贰叁肆伍陆柒捌玖';
  const U = ['', '拾', '佰', '仟'];
  const B = ['', '万', '亿', '兆'];
  const cents = Math.round((Number(amount) + Number.EPSILON) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return '零元整';

  function sectionCn(sec) {
    let out = '';
    let pendingZero = false;
    for (let pos = 3; pos >= 0; pos--) {
      const d = Math.floor(sec / Math.pow(10, pos)) % 10;
      if (d === 0) {
        if (out) pendingZero = true;
      } else {
        if (pendingZero) out += '零';
        pendingZero = false;
        out += D[d] + U[pos];
      }
    }
    return out;
  }

  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  let out = '';
  if (yuan > 0) {
    let tmp = yuan;
    let sectionIndex = 0;
    const sections = [];
    while (tmp > 0) {
      sections.push(tmp % 10000);
      tmp = Math.floor(tmp / 10000);
    }
    for (let i = sections.length - 1; i >= 0; i--) {
      const sec = sections[i];
      if (sec !== 0) {
        out += sectionCn(sec) + B[i];
      } else if (out && i > 0 && sections[i - 1] !== 0) {
        out += '零';
      }
    }
    out += '元';
  }
  if (jiao > 0) out += D[jiao] + '角';
  if (fen > 0) out += D[fen] + '分';
  if (jiao === 0 && fen === 0) out += '整';
  return out;
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(res, pathname) {
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC_DIR, safe);
  if (safe === '' || safe.endsWith('/')) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(file).toLowerCase();
  const content = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(content);
}

/* ---------------- 数据库格式化 ---------------- */

async function loadSettings() {
  const rows = await query('SELECT * FROM settings WHERE id = 1');
  if (rows.length === 0) {
    await query('INSERT INTO settings (id) VALUES (1)');
    return loadSettings();
  }
  const s = rows[0];
  return {
    companyName: s.company_name,
    phone: s.phone,
    bankName: s.bank_name,
    accountHolder: s.account_holder,
    bankAccount: s.bank_account,
    wechatQr: s.wechat_qr || '',
    alipayQr: s.alipay_qr || '',
    sealImage: s.seal_image || '',
    dueDays: s.due_days,
    reminderNote: s.reminder_note || '',
    footerNote: s.footer_note || ''
  };
}

async function saveSettings(payload) {
  await query(`
    UPDATE settings SET
      company_name = ?, phone = ?, bank_name = ?, account_holder = ?, bank_account = ?,
      wechat_qr = ?, alipay_qr = ?, seal_image = ?, due_days = ?, reminder_note = ?, footer_note = ?
    WHERE id = 1
  `, [
    str(payload.companyName), str(payload.phone), str(payload.bankName),
    str(payload.accountHolder), str(payload.bankAccount),
    isDataUrl(payload.wechatQr) || '', isDataUrl(payload.alipayQr) || '', isDataUrl(payload.sealImage) || '',
    Math.max(0, parseInt(payload.dueDays, 10) || 0),
    str(payload.reminderNote, 500), str(payload.footerNote, 500)
  ]);
  return loadSettings();
}

async function loadTenants() {
  const tenantRows = await query('SELECT * FROM tenants ORDER BY created_at DESC');
  const meterRows = await query('SELECT * FROM meters ORDER BY created_at ASC');
  const metersByTenant = {};
  for (const m of meterRows) {
    if (!metersByTenant[m.tenant_id]) metersByTenant[m.tenant_id] = [];
    metersByTenant[m.tenant_id].push({
      id: m.id,
      name: m.name,
      type: m.type,
      price: Number(m.price),
      unit: m.unit
    });
  }
  return tenantRows.map(t => ({
    id: t.id,
    name: t.name,
    room: t.room,
    phone: t.phone,
    contractStart: t.contract_start,
    contractEnd: t.contract_end,
    rent: Number(t.rent),
    parking: Number(t.parking),
    garbage: Number(t.garbage),
    meters: metersByTenant[t.id] || []
  }));
}

async function findTenant(id) {
  const tenants = await loadTenants();
  return tenants.find(t => t.id === id) || null;
}

async function saveTenant(t, meters) {
  await transaction(async (conn) => {
    const tenantData = {
      id: t.id, name: t.name, room: t.room, phone: t.phone,
      contract_start: t.contractStart, contract_end: t.contractEnd,
      rent: t.rent, parking: t.parking, garbage: t.garbage
    };
    const existing = await conn.execute('SELECT id FROM tenants WHERE id = ?', [t.id]);
    if (existing[0] && existing[0].length > 0) {
      await conn.execute(`
        UPDATE tenants SET name=?, room=?, phone=?, contract_start=?, contract_end=?, rent=?, parking=?, garbage=?
        WHERE id = ?
      `, [t.name, t.room, t.phone, t.contractStart, t.contractEnd, t.rent, t.parking, t.garbage, t.id]);
    } else {
      await conn.execute(`
        INSERT INTO tenants (id, name, room, phone, contract_start, contract_end, rent, parking, garbage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [t.id, t.name, t.room, t.phone, t.contractStart, t.contractEnd, t.rent, t.parking, t.garbage]);
    }
    await conn.execute('DELETE FROM meters WHERE tenant_id = ?', [t.id]);
    for (const m of meters) {
      await conn.execute(`
        INSERT INTO meters (id, tenant_id, name, type, price, unit) VALUES (?, ?, ?, ?, ?, ?)
      `, [m.id, t.id, m.name, m.type, m.price, m.unit || (m.type === 'electricity' ? '度' : '吨')]);
    }
  });
}

async function deleteTenant(id) {
  await query('DELETE FROM tenants WHERE id = ?', [id]);
}

async function loadReadings(month) {
  const sql = month
    ? 'SELECT * FROM readings WHERE month = ?'
    : 'SELECT * FROM readings';
  const params = month ? [month] : [];
  return await query(sql, params);
}

async function saveReadingBatch(month, items) {
  for (const item of items) {
      const id = item.id || uid();
      await upsert('readings', {
        id,
        meter_id: item.meterId,
        month,
        value: item.value,
        reading_time: normalizeTime(item.readingTime) || null
      }, 'id');
    }
}

async function deleteReadings(month) {
  await query('DELETE FROM readings WHERE month = ?', [month]);
}

async function monthsWithData() {
  const rows = await query('SELECT DISTINCT month FROM readings ORDER BY month DESC');
  const months = rows.map(r => r.month);
  const cur = currentMonth();
  if (!months.includes(cur)) months.unshift(cur);
  return months.sort().reverse();
}

/* ---------------- 账单计算 ---------------- */

function computeBill(tenant, month, settings) {
  const fixedTotal = round2(tenant.rent + tenant.parking + tenant.garbage);
  let meterTotal = 0;
  const meterDetails = [];
  const recordedMeters = [];
  const missingMeters = [];
  const notes = [];

  for (const meter of tenant.meters) {
    const current = meterReadingsMap[month + ':' + meter.id];
    const prevMonth = prevMonthStr(month);
    const prev = prevMonth ? meterReadingsMap[prevMonth + ':' + meter.id] : null;
    const prevValue = prev ? prev.value : 0;
    const prevMonthLabel = prev ? prev.month : '';

    if (!current) {
      missingMeters.push(meter.name);
      continue;
    }
    const usage = round2(current.value - prevValue);
    if (usage < 0) {
      notes.push(meter.name + ' 本期读数 (' + current.value + ') 低于上月 (' + prevValue + ')，请核对');
    }
    const amount = round2(Math.max(0, usage) * meter.price);
    meterTotal += amount;
    recordedMeters.push(meter.name);
    meterDetails.push({
      id: meter.id,
      name: meter.name,
      type: meter.type,
      current: current.value,
      prev: prevValue,
      prevMonth: prevMonthLabel,
      usage: Math.max(0, usage),
      price: meter.price,
      unit: meter.unit || (meter.type === 'electricity' ? '度' : '吨'),
      amount
    });
  }

  meterTotal = round2(meterTotal);
  const total = round2(fixedTotal + meterTotal);
  return {
    fixedTotal,
    meterTotal,
    total,
    totalCn: rmbUpper(total),
    meterDetails,
    recordedMeters,
    meterCount: tenant.meters.length,
    missingMeters,
    notes
  };
}

let meterReadingsMap = {};

async function refreshReadingsMap() {
  const rows = await query('SELECT r.*, m.tenant_id, m.name AS meter_name, m.type, m.price, m.unit FROM readings r JOIN meters m ON r.meter_id = m.id');
  meterReadingsMap = {};
  for (const r of rows) {
    meterReadingsMap[r.month + ':' + r.meter_id] = {
      id: r.id,
      meterId: r.meter_id,
      tenantId: r.tenant_id,
      name: r.meter_name,
      type: r.type,
      month: r.month,
      value: Number(r.value),
      readingTime: r.reading_time,
      price: Number(r.price),
      unit: r.unit
    };
  }
}

function prevMonthStr(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

function buildBillData(tenant, month) {
  const settings = loadSettingsSync;
  const bill = computeBill(tenant, month, settings);
  const dueDate = fmtDate(addDays(new Date(), settings.dueDays));
  return {
    month,
    billNo: 'ZD' + month.replace(/-/g, '') + '-' + tenant.id.slice(0, 6).toUpperCase(),
    generatedAt: fmtDateTime(new Date()),
    company: {
      name: settings.companyName,
      phone: settings.phone,
      bankName: settings.bankName,
      accountHolder: settings.accountHolder,
      bankAccount: settings.bankAccount,
      sealImage: settings.sealImage,
      wechatQr: settings.wechatQr,
      alipayQr: settings.alipayQr
    },
    tenant: {
      name: tenant.name,
      room: tenant.room,
      phone: tenant.phone,
      contractStart: tenant.contractStart,
      contractEnd: tenant.contractEnd
    },
    dueDate,
    reminderNote: settings.reminderNote,
    footerNote: settings.footerNote,
    ...bill
  };
}

let loadSettingsSync = null;
async function refreshSettings() {
  loadSettingsSync = await loadSettings();
}

/* ---------------- API 路由 ---------------- */

async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  /* ----- 认证接口 ----- */
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(req);
    const username = str(body.username);
    const password = str(body.password);
    if (!username || !password) {
      sendJson(res, 400, { error: '用户名和密码不能为空' });
      return true;
    }
    const rows = await query('SELECT * FROM users WHERE username = ?', [username]);
    if (rows.length === 0 || !verifyPassword(password, rows[0].password_hash)) {
      sendJson(res, 401, { error: '用户名或密码错误' });
      return true;
    }
    const token = signToken(rows[0]);
    sendJson(res, 200, { ok: true, token, user: { username: rows[0].username, role: rows[0].role } });
    return true;
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const user = authMiddleware(req);
    if (!user || user.role !== 'admin') {
      sendJson(res, 403, { error: '仅管理员可创建账号' });
      return true;
    }
    const body = await readJson(req);
    const username = str(body.username);
    const password = str(body.password);
    const role = body.role === 'user' ? 'user' : 'admin';
    if (!username || !password) {
      sendJson(res, 400, { error: '用户名和密码不能为空' });
      return true;
    }
    try {
      await query('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
        username, hashPassword(password), role
      ]);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        sendJson(res, 400, { error: '用户名已存在' });
      } else {
        throw e;
      }
    }
    return true;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = authMiddleware(req);
    if (!user) {
      sendJson(res, 401, { error: '未登录' });
      return true;
    }
    sendJson(res, 200, { user });
    return true;
  }

  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const user = authMiddleware(req);
    if (!user) {
      sendJson(res, 401, { error: '未登录' });
      return true;
    }
    const body = await readJson(req);
    const oldPassword = str(body.oldPassword);
    const newPassword = str(body.newPassword);
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      sendJson(res, 400, { error: '密码不能为空且新密码至少6位' });
      return true;
    }
    const rows = await query('SELECT password_hash FROM users WHERE id = ?', [user.userId]);
    if (rows.length === 0 || !verifyPassword(oldPassword, rows[0].password_hash)) {
      sendJson(res, 401, { error: '原密码错误' });
      return true;
    }
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.userId]);
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* ----- 受保护接口 ----- */
  const user = authMiddleware(req);
  if (!user) {
    sendJson(res, 401, { error: '未登录' });
    return true;
  }

  /* ----- 健康检查 ----- */
  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* ----- 设置 ----- */
  if (pathname === '/api/settings' && method === 'GET') {
    sendJson(res, 200, loadSettingsSync);
    return true;
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readJson(req);
    const saved = await saveSettings(body);
    loadSettingsSync = saved;
    sendJson(res, 200, saved);
    return true;
  }

  /* ----- 租户 ----- */
  if (pathname === '/api/tenants' && method === 'GET') {
    const list = await loadTenants();
    sendJson(res, 200, { list });
    return true;
  }

  if (pathname === '/api/tenants' && method === 'POST') {
    const body = await readJson(req);
    const meters = Array.isArray(body.meters) ? body.meters : [];
    const tenant = {
      id: uid(),
      name: str(body.name),
      room: str(body.room),
      phone: str(body.phone),
      contractStart: parseDate(body.contractStart),
      contractEnd: parseDate(body.contractEnd),
      rent: toNum(body.rent),
      parking: toNum(body.parking),
      garbage: toNum(body.garbage)
    };
    if (!tenant.name || !tenant.room) {
      sendJson(res, 400, { error: '租户名称和位置/房号不能为空' });
      return true;
    }
    const formattedMeters = meters.map(m => ({
      id: m.id || uid(),
      name: str(m.name) || (m.type === 'electricity' ? '电费' : '水费'),
      type: m.type === 'water' ? 'water' : 'electricity',
      price: toNum(m.price),
      unit: str(m.unit) || (m.type === 'electricity' ? '度' : '吨')
    }));
    await saveTenant(tenant, formattedMeters);
    await refreshReadingsMap();
    sendJson(res, 200, { id: tenant.id });
    return true;
  }

  if (pathname.startsWith('/api/tenants/') && pathname.length > 13) {
    const tenantId = pathname.slice(13);
    if (method === 'GET') {
      const tenant = await findTenant(tenantId);
      if (!tenant) { sendJson(res, 404, { error: '租户不存在' }); return true; }
      sendJson(res, 200, tenant);
      return true;
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      const meters = Array.isArray(body.meters) ? body.meters : [];
      const tenant = {
        id: tenantId,
        name: str(body.name),
        room: str(body.room),
        phone: str(body.phone),
        contractStart: parseDate(body.contractStart),
        contractEnd: parseDate(body.contractEnd),
        rent: toNum(body.rent),
        parking: toNum(body.parking),
        garbage: toNum(body.garbage)
      };
      if (!tenant.name || !tenant.room) {
        sendJson(res, 400, { error: '租户名称和位置/房号不能为空' });
        return true;
      }
      const formattedMeters = meters.map(m => ({
        id: m.id || uid(),
        name: str(m.name) || (m.type === 'electricity' ? '电费' : '水费'),
        type: m.type === 'water' ? 'water' : 'electricity',
        price: toNum(m.price),
        unit: str(m.unit) || (m.type === 'electricity' ? '度' : '吨')
      }));
      await saveTenant(tenant, formattedMeters);
      await refreshReadingsMap();
      sendJson(res, 200, { id: tenantId });
      return true;
    }
    if (method === 'DELETE') {
      await deleteTenant(tenantId);
      await refreshReadingsMap();
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  /* ----- 抄表 ----- */
  if (pathname === '/api/readings' && method === 'GET') {
    const month = url.searchParams.get('month');
    if (!month || !MONTH_RE.test(month)) {
      sendJson(res, 400, { error: '月份格式应为 YYYY-MM' });
      return true;
    }
    const tenants = await loadTenants();
    const rows = await query(`
      SELECT r.*, m.tenant_id, m.name AS meter_name, m.type, m.price, m.unit
      FROM readings r JOIN meters m ON r.meter_id = m.id WHERE r.month = ?
    `, [month]);
    const readingMap = {};
    for (const r of rows) {
      readingMap[r.meter_id] = {
        id: r.id,
        value: Number(r.value),
        readingTime: r.reading_time || ''
      };
    }
    const list = tenants.map(t => ({
      tenantId: t.id,
      name: t.name,
      room: t.room,
      meters: t.meters.map(m => {
        const prevMonth = prevMonthStr(month);
        const prev = prevMonth ? meterReadingsMap[prevMonth + ':' + m.id] : null;
        const current = readingMap[m.id];
        return {
          meterId: m.id,
          name: m.name,
          type: m.type,
          price: m.price,
          unit: m.unit,
          prevValue: prev ? prev.value : 0,
          prevMonth: prev ? prev.month : '',
          currentValue: current ? current.value : '',
          readingTime: current ? current.readingTime : '',
          readingId: current ? current.id : ''
        };
      })
    }));
    sendJson(res, 200, { month, list });
    return true;
  }

  if (pathname === '/api/readings' && method === 'POST') {
    const body = await readJson(req);
    const month = str(body.month);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!MONTH_RE.test(month)) {
      sendJson(res, 400, { error: '月份格式应为 YYYY-MM' });
      return true;
    }
    const toSave = [];
    for (const it of items) {
      const value = toNum(it.currentValue);
      if (it.meterId && it.currentValue !== '' && it.currentValue != null) {
        toSave.push({
          meterId: it.meterId,
          value,
          readingTime: normalizeTime(it.readingTime),
          id: it.readingId || uid()
        });
      }
    }
    await saveReadingBatch(month, toSave);
    await refreshReadingsMap();
    sendJson(res, 200, { ok: true, saved: toSave.length });
    return true;
  }

  if (pathname === '/api/readings' && method === 'DELETE') {
    const month = url.searchParams.get('month');
    if (!month || !MONTH_RE.test(month)) {
      sendJson(res, 400, { error: '月份格式应为 YYYY-MM' });
      return true;
    }
    await deleteReadings(month);
    await refreshReadingsMap();
    sendJson(res, 200, { ok: true });
    return true;
  }

  /* ----- 月份 ----- */
  if (pathname === '/api/months' && method === 'GET') {
    sendJson(res, 200, await monthsWithData());
    return true;
  }

  /* ----- 单户账单 ----- */
  if (pathname === '/api/bill' && method === 'GET') {
    const tenant = await findTenant(url.searchParams.get('tenantId') || '');
    const month = url.searchParams.get('month') || '';
    if (!tenant) { sendJson(res, 404, { error: '租户不存在' }); return true; }
    if (!MONTH_RE.test(month)) { sendJson(res, 400, { error: '月份格式应为 YYYY-MM' }); return true; }
    sendJson(res, 200, buildBillData(tenant, month));
    return true;
  }

  /* ----- 月度汇总 ----- */
  if (pathname === '/api/bills/summary' && method === 'GET') {
    const month = url.searchParams.get('month') || '';
    if (!MONTH_RE.test(month)) { sendJson(res, 400, { error: '月份格式应为 YYYY-MM' }); return true; }
    const tenants = await loadTenants();
    const list = tenants.map(t => {
      const b = computeBill(t, month);
      return {
        tenantId: t.id,
        name: t.name,
        room: t.room,
        phone: t.phone,
        rent: t.rent,
        parking: t.parking,
        garbage: t.garbage,
        fixedTotal: b.fixedTotal,
        meterTotal: b.meterTotal,
        total: b.total,
        totalCn: b.totalCn,
        recordedMeters: b.recordedMeters,
        meterCount: b.meterCount,
        missingMeters: b.missingMeters,
        notes: b.notes
      };
    });
    sendJson(res, 200, { month, list });
    return true;
  }

  /* ----- 仪表盘 ----- */
  if (pathname === '/api/dashboard' && method === 'GET') {
    const month = url.searchParams.get('month') || currentMonth();
    const today = fmtDate(new Date());
    const soon = fmtDate(addDays(new Date(), 60));
    const tenants = await loadTenants();
    const active = tenants.filter(t => !t.contractEnd || t.contractEnd >= today);
    const expiring = tenants
      .filter(t => t.contractEnd && t.contractEnd >= today && t.contractEnd <= soon)
      .sort((a, b) => a.contractEnd.localeCompare(b.contractEnd));
    const summary = tenants.map(t => {
      const b = computeBill(t, month);
      return {
        tenantId: t.id,
        name: t.name,
        room: t.room,
        total: b.total,
        recordedMeters: b.recordedMeters,
        meterCount: b.meterCount
      };
    });
    const totalMeters = tenants.reduce((s, t) => s + t.meters.length, 0);
    const rows = await query('SELECT COUNT(*) AS c FROM readings WHERE month = ?', [month]);
    const monthReadings = rows[0].c;
    sendJson(res, 200, {
      month,
      tenantCount: tenants.length,
      activeCount: active.length,
      expiringCount: expiring.length,
      expiring: expiring.map(t => ({ name: t.name, room: t.room, contractEnd: t.contractEnd })),
      totalMeters,
      monthReadings,
      billedTotal: round2(summary.reduce((s, x) => s + x.total, 0)),
      summary
    });
    return true;
  }

  /* ----- Excel 导入 ----- */
  if (pathname === '/api/import/template' && method === 'GET') {
    const buf = writeXlsx({
      '公司设置': [[
        'companyName','phone','bankName','accountHolder','bankAccount','dueDays','reminderNote','footerNote'
      ],[
        '示例物业服务有限公司','0571-88888888','中国工商银行杭州分行','示例物业服务有限公司','1202 0200 0990 0000 000',5,'请于付款截止日前完成缴纳','本缴费通知单由物业管理处自动生成'
      ]],
      '租户信息': [[
        'name','room','phone','contractStart','contractEnd','rent','parking','garbage'
      ],[
        '张三','1-101','13800138000','2024-01-01','2025-01-01',3000,200,50
      ]],
      '表计配置': [[
        'tenantName','meterName','type','price','unit'
      ],[
        '张三','电表','electricity','1.2','度'
      ]],
      '抄表数据': [[
        'tenantName','meterName','month','value','readingTime'
      ],[
        '张三','电表','2024-09','1234.5','2024-09-01 10:00'
      ]]
    });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="数据导入模板.xlsx"',
      'Content-Length': buf.length
    });
    res.end(buf);
    return true;
  }

  if (pathname === '/api/import' && method === 'POST') {
    const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
    const year = url.searchParams.get('year') || new Date().getFullYear().toString();
    const buf = await readBody(req);
    const xlsx = readXlsx(buf);
    const importer = createImporter(xlsx, year);

    if (mode === 'replace') {
      await query('DELETE FROM readings');
      await query('DELETE FROM meters');
      await query('DELETE FROM tenants');
    }

    const company = importer.companySettings();
    if (company) {
      await saveSettings({
        companyName: company.companyName,
        phone: company.phone,
        bankName: company.bankName,
        accountHolder: company.accountHolder,
        bankAccount: company.bankAccount,
        dueDays: company.dueDays,
        reminderNote: company.reminderNote,
        footerNote: company.footerNote,
        wechatQr: '', alipayQr: '', sealImage: ''
      });
    }

    const importedTenants = importer.tenants();
    let saved = 0;
    for (const t of importedTenants) {
      const existing = await query('SELECT id FROM tenants WHERE name = ? AND room = ?', [t.name, t.room]);
      let tenantId = existing.length ? existing[0].id : uid();
      await saveTenant({
        id: tenantId,
        name: t.name,
        room: t.room,
        phone: t.phone,
        contractStart: t.contractStart,
        contractEnd: t.contractEnd,
        rent: t.rent,
        parking: t.parking,
        garbage: t.garbage
      }, (t.meters || []).map(m => ({
        id: uid(), name: m.name, type: m.type, price: m.price, unit: m.unit
      })));
      saved++;
    }

    const readings = importer.readings();
    for (const r of readings) {
      const tenantRows = await query('SELECT id FROM tenants WHERE name = ?', [r.tenantName]);
      if (!tenantRows.length) continue;
      const meterRows = await query('SELECT id FROM meters WHERE tenant_id = ? AND name = ?', [tenantRows[0].id, r.meterName]);
      if (!meterRows.length) continue;
      await upsert('readings', {
        id: uid(), meter_id: meterRows[0].id, month: r.month,
        value: r.value, reading_time: normalizeTime(r.readingTime)
      }, 'id');
    }

    await refreshSettings();
    await refreshReadingsMap();
    sendJson(res, 200, { ok: true, saved, readings: readings.length });
    return true;
  }

  sendJson(res, 404, { error: '接口不存在' });
  return true;
}

/* ---------------- 服务启动 ---------------- */

async function startServer() {
  await initDb();
  await ensureDefaultUser();
  await refreshSettings();
  await refreshReadingsMap();

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      sendJson(res, 400, { error: '非法请求' });
      return;
    }
    try {
      if (await handleApi(req, res, url)) return;
      serveStatic(res, url.pathname);
    } catch (err) {
      console.error('[server] 处理请求失败:', err);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('==============================================');
    console.log('  物业与租户综合账单管理系统 已启动');
    console.log('  访问地址: http://localhost:' + PORT);
    console.log('  数据库: ' + (process.env.DB_HOST || 'localhost') + '/' + (process.env.DB_NAME || 'property_billing'));
    console.log('==============================================');
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[server] 端口 ' + PORT + ' 已被占用');
    } else {
      console.error('[server] 服务监听失败:', err.message);
    }
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await closePool();
    process.exit(0);
  });
}

startServer().catch(err => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
