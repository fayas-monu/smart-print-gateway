/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Small shared server helpers. (AL SHAJAR TEAM)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
  } catch (err) { /* backup is best effort */ }
  fs.renameSync(tmp, filePath);
}

function writeFileAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) { /* ignore */ }
}

function safeFilename(name, fallback) {
  const base = path.basename(String(name || 'document'));
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback || 'document';
}

function extensionFor(name, mime) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext) return ext.slice(0, 12);
  const map = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
  };
  return map[String(mime || '').toLowerCase()] || '';
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 24).toString('hex');
}

function randomId(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(length || 6);
  for (let i = 0; i < (length || 6); i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (err) {
    return false;
  }
}

function parseCookies(header) {
  const out = Object.create(null);
  String(header || '').split(';').forEach(function (part) {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    if (!key) return;
    const value = part.slice(index + 1).trim();
    try { out[key] = decodeURIComponent(value); }
    catch (err) { out[key] = value; }
  });
  return out;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function decodeBase64(value) {
  const clean = String(value || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!clean) return Buffer.alloc(0);
  return Buffer.from(clean, 'base64');
}

function normalizeBase64(value) {
  return String(value || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
}

function todayInZone(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Dubai',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (err) {
    return new Date().toISOString().slice(0, 10);
  }
}

function startOfTodayIso(timeZone) {
  return todayInZone(timeZone) + 'T00:00:00.000Z';
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(function (n) { return parseInt(n, 10); });
  if (parts.length !== 4 || parts.some(function (n) { return !Number.isInteger(n) || n < 0 || n > 255; })) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return false;
}

function mimeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.pdf': 'application/pdf',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = {
  ensureDir,
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
  removeDir,
  safeFilename,
  extensionFor,
  randomToken,
  randomId,
  safeEqual,
  parseCookies,
  clientIp,
  decodeBase64,
  normalizeBase64,
  todayInZone,
  startOfTodayIso,
  csvEscape,
  formatBytes,
  clamp,
  sleep,
  isPrivateIpv4,
  mimeForPath
};
