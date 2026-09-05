'use strict';

/* ============================================================
 * 零依赖 XLSX 读写模块（ZIP + XML）
 * - readXlsx(buffer) -> { sheets: [{ name, rows: [ [cell...] ] }] }
 * - writeXlsx(sheets) -> Buffer
 * 仅支持常见的字符串/数字单元格（inlineStr 与 sharedStrings），
 * 足够满足导入模板与数据导入场景。
 * ============================================================ */

const zlib = require('zlib');

/* ---------------- ZIP ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function parseZip(buf) {
  if (buf.length < 22) throw new Error('文件过小，不是有效的 XLSX');
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 XLSX 压缩包');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries[name] = { method, compSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    entries,
    read(name) {
      const e = entries[name];
      if (!e) return null;
      const lh = e.localOffset;
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      const data = buf.subarray(start, start + e.compSize);
      try {
        return e.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
      } catch (err) {
        throw new Error('解压文件失败: ' + name);
      }
    }
  };
}

/* ---------------- XML 工具 ---------------- */

function decodeXml(s) {
  if (!s) return '';
  return s
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attr(tag, name) {
  const re = new RegExp(name + '="([^"]*)"');
  const m = re.exec(tag);
  return m ? m[1] : '';
}

/* ---------------- 读取 ---------------- */

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    let text = '';
    const tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tre.exec(m[1]))) text += tm[1];
    out.push(decodeXml(text));
  }
  return out;
}

function parseSheetXml(xml, shared) {
  const grid = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const cells = {};
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(m[1]))) {
      const tag = cm[1];
      const inner = cm[2] || '';
      const ref = attr(tag, 'r');
      const colMatch = /^([A-Z]+)\d+$/.exec(ref);
      if (!colMatch) continue;
      const col = colNameToIndex(colMatch[1]);
      const t = attr(tag, 't');
      let value = '';
      if (t === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const idx = v ? parseInt(v[1], 10) : NaN;
        value = Number.isFinite(idx) && shared[idx] != null ? shared[idx] : '';
      } else if (t === 'inlineStr') {
        const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = tm ? decodeXml(tm[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? decodeXml(v[1]) : '';
      }
      cells[col] = value;
    }
    // 转为稀疏数组
    const rowArr = [];
    for (const key of Object.keys(cells)) {
      const idx = parseInt(key, 10);
      rowArr[idx] = cells[key];
    }
    grid.push(rowArr);
  }
  return grid;
}

function colNameToIndex(name) {
  let n = 0;
  for (let i = 0; i < name.length; i++) n = n * 26 + (name.charCodeAt(i) - 64);
  return n - 1;
}

function indexToColName(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function readXlsx(buf) {
  const zip = parseZip(buf);
  const wbXml = zip.read('xl/workbook.xml');
  if (!wbXml) throw new Error('文件中缺少 workbook.xml，不是有效的 XLSX');
  const wbText = wbXml.toString('utf8');
  const relsText = (zip.read('xl/_rels/workbook.xml.rels') || Buffer.from('')).toString('utf8');

  const sheetList = [];
  const sheetRe = /<sheet\b[^>]*>/g;
  let sm;
  while ((sm = sheetRe.exec(wbText))) {
    sheetList.push({ name: attr(sm[0], 'name'), rid: attr(sm[0], 'r:id') });
  }
  const relMap = {};
  const relRe = /<Relationship\b[^>]*>/g;
  let rm;
  while ((rm = relRe.exec(relsText))) {
    relMap[attr(rm[0], 'Id')] = attr(rm[0], 'Target');
  }

  const shared = (() => {
    const ss = zip.read('xl/sharedStrings.xml');
    return ss ? parseSharedStrings(ss.toString('utf8')) : [];
  })();

  const sheets = [];
  for (const s of sheetList) {
    const target = relMap[s.rid] || ('worksheets/sheet' + (sheetList.indexOf(s) + 1) + '.xml');
    const clean = target.replace(/^\//, '');
    const xml = zip.read('xl/' + clean) || zip.read(clean);
    if (!xml) continue;
    sheets.push({ name: s.name, rows: parseSheetXml(xml.toString('utf8'), shared) });
  }
  return { sheets };
}

/* ---------------- 写入 ---------------- */

function writeSheetXml(rows) {
  let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  rows.forEach((row, ri) => {
    if (!row || row.length === 0) return;
    out += '<row r="' + (ri + 1) + '">';
    row.forEach((val, ci) => {
      const ref = indexToColName(ci) + (ri + 1);
      if (val === undefined || val === null || val === '') {
        out += '<c r="' + ref + '"/>';
      } else if (typeof val === 'number') {
        out += '<c r="' + ref + '" t="n"><v>' + val + '</v></c>';
      } else {
        out += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + encodeXml(val) + '</t></is></c>';
      }
    });
    out += '</row>';
  });
  out += '</sheetData></worksheet>';
  return out;
}

function zipStoreEntry(name, data) {
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);      // version needed
  local.writeUInt16LE(0x0800, 6);  // flags: utf8
  local.writeUInt16LE(0, 8);       // method: store
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(Buffer.byteLength(name), 26);
  return Buffer.concat([local, Buffer.from(name, 'utf8'), data]);
}

function writeXlsx(sheets) {
  const files = {};
  files['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  files['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  files['xl/workbook.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheets.map((s, i) => '<sheet name="' + encodeXml(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
    '</sheets></workbook>';
  files['xl/_rels/workbook.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  sheets.forEach((s, i) => {
    files['xl/worksheets/sheet' + (i + 1) + '.xml'] = writeSheetXml(s.rows);
  });
  files['xl/styles.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="宋体"/></font><font><b/><sz val="11"/><name val="宋体"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '</styleSheet>';

  const names = Object.keys(files);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  names.forEach((name) => {
    const data = Buffer.from(files[name], 'utf8');
    const local = zipStoreEntry(name, data);
    localParts.push(local);
    const crc = crc32(data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(Buffer.byteLength(name), 28);
    cen.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([cen, Buffer.from(name, 'utf8')]));
    offset += local.length;
  });

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, eocd]);
}

module.exports = { readXlsx, writeXlsx };
