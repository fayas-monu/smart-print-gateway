/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Operator PIN, signed sessions and login rate limiting. (AL SHAJAR TEAM)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJsonAtomic, randomId, safeEqual } = require('./util');

const COOKIE_NAME = 'spg_session';
const DEFAULT_PIN = '1234';

function scryptHash(pin, saltHex) {
  return crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

class AuthStore {
  constructor(dataDir, options) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'auth.json');
    this.options = options || {};
    this.data = null;
    this.usingDefaultPin = false;
    this.rate = new Map();
    this.init();
  }

  init() {
    ensureDir(this.dataDir);
    const existing = readJson(this.filePath, null);
    if (existing && existing.salt && existing.hash && existing.secret) {
      this.data = existing;
      this.usingDefaultPin = this.verifyPin(DEFAULT_PIN);
      return;
    }

    const pin = String(process.env.SPG_PIN || DEFAULT_PIN);
    this.data = this.createRecord(pin);
    writeJsonAtomic(this.filePath, this.data);
    this.usingDefaultPin = pin === DEFAULT_PIN;
  }

  createRecord(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    return {
      version: 1,
      salt: salt,
      hash: scryptHash(pin, salt),
      secret: crypto.randomBytes(48).toString('hex'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  verifyPin(pin) {
    if (!this.data || !this.data.salt || !this.data.hash) return false;
    const candidate = scryptHash(String(pin || ''), this.data.salt);
    return this.constantTimeHexEqual(candidate, this.data.hash);
  }

  constantTimeHexEqual(a, b) {
    try {
      const left = Buffer.from(String(a), 'hex');
      const right = Buffer.from(String(b), 'hex');
      if (left.length !== right.length) return false;
      return crypto.timingSafeEqual(left, right);
    } catch (err) {
      return false;
    }
  }

  changePin(currentPin, newPin) {
    if (!this.verifyPin(currentPin)) throw new Error('The current PIN is incorrect.');
    const pin = String(newPin || '').trim();
    if (!/^\d{4,12}$/.test(pin)) throw new Error('The new PIN must be 4 to 12 digits.');
    if (pin === String(currentPin)) throw new Error('Choose a PIN different from the current one.');
    const record = Object.assign({}, this.data, {
      salt: crypto.randomBytes(16).toString('hex'),
      secret: crypto.randomBytes(48).toString('hex'),
      updatedAt: new Date().toISOString()
    });
    record.hash = scryptHash(pin, record.salt);
    this.data = record;
    writeJsonAtomic(this.filePath, record);
    this.usingDefaultPin = pin === DEFAULT_PIN;
  }

  issueSession(hours) {
    const seconds = Math.max(1, Number(hours) || 12) * 3600;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1,
      iat: now,
      exp: now + seconds,
      rid: randomId(10)
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = this.sign(encoded);
    return encoded + '.' + signature;
  }

  sign(value) {
    return crypto.createHmac('sha256', Buffer.from(this.data.secret, 'hex')).update(value).digest('base64url');
  }

  verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = this.sign(parts[0]);
    if (!safeEqual(expected, parts[1])) return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch (err) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!payload || !payload.exp || payload.exp <= now) return null;
    return payload;
  }

  checkRate(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    const entry = this.rate.get(key);
    if (!entry) return { allowed: true, retryAfter: 0 };
    if (entry.blockedUntil && entry.blockedUntil > now) {
      return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (entry.firstAt && now - entry.firstAt > 10 * 60 * 1000) {
      this.rate.delete(key);
      return { allowed: true, retryAfter: 0 };
    }
    return { allowed: true, retryAfter: 0 };
  }

  recordFailure(ip) {
    const key = String(ip || 'unknown');
    const now = Date.now();
    let entry = this.rate.get(key);
    if (!entry || (entry.firstAt && now - entry.firstAt > 10 * 60 * 1000)) {
      entry = { firstAt: now, count: 0, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= 5) {
      entry.blockedUntil = now + 2 * 60 * 1000;
      entry.count = 0;
      entry.firstAt = now;
    }
    this.rate.set(key, entry);
    if (this.rate.size > 500) {
      for (const [k, v] of this.rate) {
        if (!v.blockedUntil && (!v.firstAt || now - v.firstAt > 10 * 60 * 1000)) this.rate.delete(k);
      }
    }
  }

  recordSuccess(ip) {
    this.rate.delete(String(ip || 'unknown'));
  }

  sessionCookie(token, hours) {
    const maxAge = Math.max(60, Math.round((Number(hours) || 12) * 3600));
    return COOKIE_NAME + '=' + encodeURIComponent(token) +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge;
  }

  clearCookie() {
    return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
  }

  cookieName() {
    return COOKIE_NAME;
  }
}

module.exports = {
  AuthStore,
  COOKIE_NAME,
  DEFAULT_PIN
};
