'use strict';

/* ============================================================
 * Excel 导入逻辑：
 * - 官方模板（公司设置/租户信息/表计配置/抄表数据）
 * - 旧版电费/水费宽表（名称/收费标准/期初/各月读数列）
 * ============================================================ */

const crypto = require('crypto');

const uid = () => crypto.randomUUID();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};
const str = (v) => String(v == null ? '' : v).trim();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizeTime(v, month) {
  const s = str(v);
  let m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
  if (m) return m[1] + ' ' + m[2];
  m = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) return m[1] + ' 09:00';
  return month + '-01 09:00';
}

function findSheet(wb, keywords) {
  const exact = wb.sheets.find((s) => keywords.includes(s.name.trim()));
  if (exact) return exact;
  return wb.sheets.find((s) => keywords.some((k) => s.name.includes(k)));
}

function headerMap(sheet) {
  // 返回 { 列名: 列索引 }，来自第一行
  const row = sheet.rows[0] || [];
  const map = {};
  row.forEach((cell, i) => {
    const k = str(cell);
    if (!k) return;
    map[k] = i;
    // 兼容带括号说明的表头，如「单价（元/单位）」→「单价」
    const norm = k.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '');
    if (norm && !(norm in map)) map[norm] = i;
  });
  return map;
}

function cellAt(row, idx) {
  return row && idx != null ? row[idx] : '';
}

function detectLegacy(wb) {
  const names = wb.sheets.map((s) => s.name);
  return names.some((n) => n.includes('电费')) || names.some((n) => n.includes('水费'));
}

function createImporter(store, saveFns) {
  const { tenants, readings, settings } = store;
  const saveTenants = saveFns.saveTenants;
  const saveReadings = saveFns.saveReadings;
  const saveSettings = saveFns.saveSettings;
  const skipped = [];

  function findTenant(name) {
    return tenants.list.find((t) => t.name === name);
  }

  function findMeter(tenant, meterName, type) {
    return tenant.meters.find((m) => m.name === meterName && m.type === type);
  }

  function upsertTenant(fields) {
    let t = findTenant(fields.name);
    if (t) {
      if (fields.room !== undefined && fields.room !== '') t.room = fields.room;
      if (fields.phone !== undefined && fields.phone !== '') t.phone = fields.phone;
      if (fields.contractStart !== undefined && fields.contractStart !== '') t.contractStart = fields.contractStart;
      if (fields.contractEnd !== undefined && fields.contractEnd !== '') t.contractEnd = fields.contractEnd;
      for (const k of ['rent', 'parking', 'garbage']) {
        if (fields[k] !== undefined && Number.isFinite(fields[k])) t[k] = fields[k];
      }
      t.updatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      return { created: false };
    }
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    t = {
      id: uid(),
      name: fields.name,
      room: fields.room || '',
      phone: fields.phone || '',
      contractStart: fields.contractStart || '',
      contractEnd: fields.contractEnd || '',
      rent: Number.isFinite(fields.rent) ? round2(fields.rent) : 0,
      parking: Number.isFinite(fields.parking) ? round2(fields.parking) : 0,
      garbage: Number.isFinite(fields.garbage) ? round2(fields.garbage) : 0,
      meters: [],
      createdAt: now,
      updatedAt: now
    };
    tenants.list.push(t);
    return { created: true };
  }

  function upsertMeter(tenant, meterName, type, price) {
    let m = findMeter(tenant, meterName, type);
    if (m) {
      if (Number.isFinite(price)) m.price = Math.max(0, round2(price));
      return { created: false };
    }
    tenant.meters.push({
      id: uid(),
      name: meterName,
      type,
      unit: type === 'water' ? '吨' : '度',
      price: Number.isFinite(price) ? Math.max(0, round2(price)) : 0
    });
    return { created: true };
  }

  function upsertReading(tenant, meter, month, current, time) {
    const rec = readings.list.find((r) => r.meterId === meter.id && r.month === month);
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    if (rec) {
      rec.current = round2(current);
      rec.time = time;
      rec.updatedAt = now;
    } else {
      readings.list.push({
        id: uid(),
        tenantId: tenant.id,
        meterId: meter.id,
        meterName: meter.name,
        meterType: meter.type,
        unit: meter.unit,
        price: meter.price,
        month,
        current: round2(current),
        time,
        createdAt: now,
        updatedAt: now
      });
    }
  }

  function parseType(v) {
    const s = str(v);
    if (/水/.test(s)) return 'water';
    return 'electricity';
  }

  /* ---------- 官方模板 ---------- */
  function importOfficial(wb) {
    const report = {
      tenantsCreated: 0, tenantsUpdated: 0,
      metersCreated: 0, metersUpdated: 0,
      readingsSaved: 0, settingsUpdated: false
    };

    // 公司设置
    const sSheet = findSheet(wb, ['公司设置', '公司信息', '设置']);
    if (sSheet) {
      const map = { '公司名称': 'companyName', '联系电话': 'phone', '开户行': 'bankName', '收款户名': 'accountHolder', '收款账号': 'bankAccount', '付款截止天数': 'dueDays', '催款提示语': 'reminderNote', '页脚说明': 'footerNote' };
      const h = headerMap(sSheet);
      for (const row of sSheet.rows.slice(1)) {
        const key = str(cellAt(row, 0));
        const val = str(cellAt(row, 1));
        if (!key || !val) continue;
        const field = map[key];
        if (!field) continue;
        if (field === 'dueDays') {
          const n = toNum(val);
          if (Number.isFinite(n)) settings.dueDays = Math.min(60, Math.max(0, Math.round(n)));
        } else {
          settings[field] = val.slice(0, 300);
        }
        report.settingsUpdated = true;
      }
      if (report.settingsUpdated) saveSettings();
    }

    // 租户信息
    const tSheet = findSheet(wb, ['租户信息', '租户']);
    if (tSheet) {
      const h = headerMap(tSheet);
      const colName = h['租户名称'] != null ? h['租户名称'] : h['名称'];
      const colRoom = h['位置/房号/铺位'] != null ? h['位置/房号/铺位'] : h['房号/铺位'];
      const colPhone = h['联系电话'];
      const colStart = h['合同开始'];
      const colEnd = h['合同结束'];
      const colRent = h['月租金'];
      const colPark = h['停车费'];
      const colGarbage = h['垃圾清运费'];
      if (colName != null) {
        tSheet.rows.slice(1).forEach((row, ri) => {
          const name = str(cellAt(row, colName));
          if (!name) return;
          const r = upsertTenant({
            name,
            room: cellAt(row, colRoom),
            phone: cellAt(row, colPhone),
            contractStart: cellAt(row, colStart),
            contractEnd: cellAt(row, colEnd),
            rent: toNum(cellAt(row, colRent)),
            parking: toNum(cellAt(row, colPark)),
            garbage: toNum(cellAt(row, colGarbage))
          });
          if (r.created) report.tenantsCreated++;
          else report.tenantsUpdated++;
        });
      }
    }

    // 表计配置
    const mSheet = findSheet(wb, ['表计配置', '表计']);
    if (mSheet) {
      const h = headerMap(mSheet);
      const colName = h['租户名称'] != null ? h['租户名称'] : h['名称'];
      const colMeter = h['表计名称'];
      const colType = h['表计类型'];
      const colPrice = h['单价'];
      if (colName != null && colMeter != null) {
        mSheet.rows.slice(1).forEach((row, ri) => {
          const tName = str(cellAt(row, colName));
          const mName = str(cellAt(row, colMeter));
          if (!tName || !mName) return;
          const t = findTenant(tName);
          if (!t) {
            skipped.push({ sheet: mSheet.name, row: ri + 2, reason: '租户「' + tName + '」不存在（请先在「租户信息」表填写）' });
            return;
          }
          const type = parseType(cellAt(row, colType));
          const price = toNum(cellAt(row, colPrice));
          const r = upsertMeter(t, mName, type, Number.isFinite(price) ? price : 0);
          if (r.created) report.metersCreated++;
          else report.metersUpdated++;
        });
      }
    }

    // 抄表数据
    const rSheet = findSheet(wb, ['抄表数据', '抄表']);
    if (rSheet) {
      const h = headerMap(rSheet);
      const colName = h['租户名称'] != null ? h['租户名称'] : h['名称'];
      const colMeter = h['表计名称'];
      const colMonth = h['抄表月份'];
      const colCurrent = h['本期读数'];
      const colTime = h['抄表时间'];
      if (colName != null && colMeter != null && colMonth != null && colCurrent != null) {
        rSheet.rows.slice(1).forEach((row, ri) => {
          const tName = str(cellAt(row, colName));
          const mName = str(cellAt(row, colMeter));
          const month = str(cellAt(row, colMonth));
          const cur = toNum(cellAt(row, colCurrent));
          if (!tName || !mName) return;
          if (!MONTH_RE.test(month)) {
            skipped.push({ sheet: rSheet.name, row: ri + 2, reason: '抄表月份格式应为 YYYY-MM，收到「' + month + '」' });
            return;
          }
          if (!Number.isFinite(cur) || cur < 0) {
            skipped.push({ sheet: rSheet.name, row: ri + 2, reason: '本期读数无效「' + str(cellAt(row, colCurrent)) + '」' });
            return;
          }
          const t = findTenant(tName);
          if (!t) {
            skipped.push({ sheet: rSheet.name, row: ri + 2, reason: '租户「' + tName + '」不存在' });
            return;
          }
          const meter = t.meters.find((m) => m.name === mName);
          if (!meter) {
            skipped.push({ sheet: rSheet.name, row: ri + 2, reason: '表计「' + mName + '」不存在（请先在「表计配置」表填写）' });
            return;
          }
          upsertReading(t, meter, month, cur, normalizeTime(cellAt(row, colTime), month));
          report.readingsSaved++;
        });
      }
    }

    return report;
  }

  /* ---------- 旧版电费/水费宽表 ---------- */
  function importLegacy(wb, year) {
    const report = {
      tenantsCreated: 0, tenantsUpdated: 0,
      metersCreated: 0, metersUpdated: 0,
      readingsSaved: 0, settingsUpdated: false
    };
    const y = Number.isFinite(toNum(year)) ? Math.round(toNum(year)) : new Date().getFullYear();

    const parseMonthHeader = (header) => {
      let m = /^(\d{4})-(\d{1,2})/.exec(header);
      if (m) return { month: m[1] + '-' + String(parseInt(m[2], 10)).padStart(2, '0'), day: null };
      m = /(\d{1,2})月(\d{1,2})?日?/.exec(header);
      if (m) {
        const mon = parseInt(m[1], 10);
        if (mon >= 1 && mon <= 12) {
          return {
            month: y + '-' + String(mon).padStart(2, '0'),
            day: m[2] ? parseInt(m[2], 10) : null
          };
        }
      }
      return null;
    };

    const sources = [];
    const elec = findSheet(wb, ['电费']);
    const water = findSheet(wb, ['水费']);
    if (elec) sources.push({ sheet: elec, type: 'electricity', defaultPrice: 1.2 });
    if (water) sources.push({ sheet: water, type: 'water', defaultPrice: 5 });

    for (const src of sources) {
      const h = headerMap(src.sheet);
      const colName = h['名称'] != null ? h['名称'] : h['租户名称'];
      const colPrice = h['收费标准'] != null ? h['收费标准'] : h['单价'];
      if (colName == null) continue;
      const monthCols = [];
      for (const key of Object.keys(h)) {
        if (/费用/.test(key)) continue;
        const ph = parseMonthHeader(key);
        if (ph) monthCols.push({ col: h[key], ...ph });
      }
      monthCols.sort((a, b) => a.month.localeCompare(b.month));

      const counter = {}; // 租户名 -> 该类型表计序号
      src.sheet.rows.slice(1).forEach((row, ri) => {
        const rawName = str(cellAt(row, colName));
        if (!rawName) return;
        if (/合计|总计/.test(rawName)) return;
        // 去掉结尾数字（如 运祥2 / 雅宝2 表示第二只表计）
        const m = /^(.*?)(\d+)$/.exec(rawName);
        const tName = m ? m[1] : rawName;
        counter[tName] = (counter[tName] || 0) + 1;
        const meterName = (src.type === 'water' ? '水表' : '电表') + counter[tName];
        const price = toNum(cellAt(row, colPrice));
        const finalPrice = Number.isFinite(price) ? price : src.defaultPrice;

        const tRes = upsertTenant({ name: tName });
        if (tRes.created) report.tenantsCreated++;
        else report.tenantsUpdated++;
        const mRes = upsertMeter(findTenant(tName), meterName, src.type, finalPrice);
        if (mRes.created) report.metersCreated++;
        else report.metersUpdated++;
        const meter = findMeter(findTenant(tName), meterName, src.type);

        for (const mc of monthCols) {
          const cur = toNum(cellAt(row, mc.col));
          if (!Number.isFinite(cur)) continue;
          const time = mc.day
            ? mc.month + '-' + String(mc.day).padStart(2, '0') + ' 09:00'
            : mc.month + '-01 09:00';
          upsertReading(findTenant(tName), meter, mc.month, cur, time);
          report.readingsSaved++;
        }
      });
    }
    return report;
  }

  function importWorkbook(wb, opts) {
    const mode = opts && opts.mode === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace') {
      tenants.list = [];
      readings.list = [];
      saveTenants();
      saveReadings();
    }
    const legacy = detectLegacy(wb);
    const report = legacy
      ? importLegacy(wb, opts && opts.year)
      : importOfficial(wb);
    report.mode = mode;
    report.legacy = legacy;
    report.skipped = skipped.slice(0, 100);
    saveTenants();
    saveReadings();
    return report;
  }

  return { importWorkbook };
}

module.exports = { createImporter };
