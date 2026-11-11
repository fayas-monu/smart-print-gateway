'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

function id(bytes) {
  return crypto.randomBytes(bytes || 16).toString('hex');
}

function jobNumber(seq, date) {
  const d = date || new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return 'SPG-' + yy + mm + dd + '-' + String(seq).padStart(4, '0');
}

function nowIso() { return new Date().toISOString(); }

function sanitizeFilename(name, fallbackExt) {
  const base = String(name || 'document').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
  let out = base.slice(0, 140) || 'document';
  if (fallbackExt && !path.extname(out)) out += fallbackExt;
  return out;
}

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function parsePageRange(text, pageCount) {
  const clean = String(text || '').trim();
  if (!clean) return { pages: [], invalid: [] };
  const pages = [];
  const invalid = [];
  const seen = new Set();
  const parts = clean.split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  parts.forEach(function (part) {
    let m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10);
      let b = parseInt(m[2], 10);
      if (a > b) { const t = a; a = b; b = t; }
      if (a < 1) { invalid.push(part); return; }
      for (let i = a; i <= b; i++) {
        if (!pageCount || i <= pageCount) {
          if (!seen.has(i)) { seen.add(i); pages.push(i); }
        } else if (!invalid.includes(String(i))) invalid.push(String(i));
      }
      return;
    }
    m = part.match(/^\d+$/);
    if (m) {
      const n = parseInt(part, 10);
      if (n >= 1 && (!pageCount || n <= pageCount)) {
        if (!seen.has(n)) { seen.add(n); pages.push(n); }
      } else invalid.push(part);
      return;
    }
    invalid.push(part);
  });
  pages.sort(function (a, b) { return a - b; });
  return { pages: pages, invalid: invalid };
}

function magicKind(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const head = buf.subarray(0, 12);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii.startsWith('GIF8')) return 'gif';
  if (ascii.startsWith('BM')) return 'bmp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00)) return 'tiff';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'ole';
  return 'unknown';
}

function kindForFile(name, mime) {
  const ext = extOf(name);
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'].includes(ext) || /^image\//.test(mime || '')) return 'image';
  if (ext === '.docx' || ext === '.doc') return 'word';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') return 'excel';
  return 'other';
}

function validateUpload(buf, name, mime) {
  const ext = extOf(name);
  const kind = kindForFile(name, mime);
  const magic = magicKind(buf);
  const ok =
    (kind === 'pdf' && magic === 'pdf') ||
    (kind === 'image' && ['png', 'jpeg', 'gif', 'bmp', 'webp', 'tiff'].includes(magic)) ||
    (kind === 'word' && ((ext === '.docx' && magic === 'zip') || (ext === '.doc' && magic === 'ole'))) ||
    (kind === 'excel' && ((['.xlsx'].includes(ext) && magic === 'zip') || (['.xls'].includes(ext) && magic === 'ole') || ext === '.csv'));
  return { ok: ok, kind: kind, magic: magic };
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }
  check(key) {
    const now = Date.now();
    const windowMs = this.windowMs;
    const arr = (this.hits.get(key) || []).filter(function (t) { return now - t < windowMs; });
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        if (!v.length || now - v[v.length - 1] > this.windowMs) this.hits.delete(k);
      }
    }
    return true;
  }
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, text, contentType) {
  const body = String(text);
  res.writeHead(status, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', function (err) {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function readJsonBody(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    const e = new Error('Invalid JSON body');
    e.status = 400;
    throw e;
  }
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function isOpenNow(hours) {
  if (!hours || !hours.open || !hours.close) return true;
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: hours.timezone || 'UTC', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(now);
    const map = {};
    parts.forEach(function (p) { map[p.type] = p.value; });
    const cur = (map.hour === '24' ? '00' : map.hour) + ':' + map.minute;
    if ((hours.closedDays || []).includes(map.weekday)) return false;
    return cur >= hours.open && cur <= hours.close;
  } catch (err) {
    return true;
  }
}

module.exports = {
  MIME,
  ensureDir,
  readJson,
  writeJsonAtomic,
  id,
  jobNumber,
  nowIso,
  sanitizeFilename,
  extOf,
  safeEqual,
  hashPin,
  clamp,
  parsePageRange,
  magicKind,
  kindForFile,
  validateUpload,
  formatBytes,
  RateLimiter,
  sendJson,
  sendText,
  readBody,
  readJsonBody,
  clientIp,
  parseCookies,
  isOpenNow
};
