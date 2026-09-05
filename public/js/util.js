'use strict';

/* 共享工具函数：人民币大写、数字格式化、日期等 */

function monthCn(month) {
  if (!month) return '';
  return month.replace('-', '年') + '月';
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return String(parseFloat(Number(n).toFixed(3)));
}

function localMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function localNowInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function toDateTimeInput(v) {
  if (!v) return '';
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(v);
  return m ? m[1] + 'T' + m[2] : v;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function uid() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* 人民币大写转换（与后端逻辑一致） */
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
    const s = String(yuan);
    const groups = [];
    let g = s;
    while (g.length > 0) {
      groups.unshift(g.slice(-4));
      g = g.slice(0, -4);
    }
    for (let i = 0; i < groups.length; i++) {
      const sec = parseInt(groups[i], 10);
      const bi = groups.length - 1 - i;
      if (sec === 0) {
        const later = groups.slice(i + 1).some((x) => parseInt(x, 10) > 0);
        if (later && out !== '' && !out.endsWith('零')) out += '零';
        continue;
      }
      if (out !== '' && sec < 1000 && !out.endsWith('零')) out += '零';
      out += sectionCn(sec) + B[bi];
    }
    out += '元';
  }

  if (jiao === 0 && fen === 0) {
    out += '整';
  } else {
    if (jiao > 0) out += D[jiao] + '角';
    if (fen > 0) {
      if (jiao === 0 && yuan > 0) out += '零';
      out += D[fen] + '分';
    }
    if (fen === 0 && jiao > 0 && yuan > 0) out += '整';
  }
  return out;
}
