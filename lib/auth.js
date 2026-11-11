'use strict';

const path = require('path');
const crypto = require('crypto');
const { ensureDir, readJson, writeJsonAtomic, hashPin, safeEqual, RateLimiter } = require('./util');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

class Auth {
  constructor(dataDir, config) {
    this.dataDir = dataDir;
    this.config = config;
    this.file = path.join(dataDir, 'auth.json');
    this.loginLimiter = new RateLimiter(60 * 1000, 8);
    ensureDir(dataDir);
    this.state = readJson(this.file, null);
    if (!this.state || !this.state.pinHash || !this.state.secret) {
      const pin = process.env.SPG_PIN || '1234';
      const salt = this._salt();
      this.state = {
        pinHash: hashPin(pin, salt),
        salt: salt,
        secret: crypto.randomBytes(48).toString('hex'),
        createdAt: new Date().toISOString(),
        pinChangedAt: null,
        defaultPin: pin === '1234'
      };
      writeJsonAtomic(this.file, this.state);
      console.log('\n  ┌──────────────────────────────────────────────┐');
      console.log('  │  Operator console PIN: ' + pin.padEnd(22) + '│');
      console.log('  │  Change it in Dashboard → Settings → Security │');
      console.log('  └──────────────────────────────────────────────┘\n');
    }
  }

  _salt() { return crypto.randomBytes(24).toString('hex'); }

  _ttl() {
    const hours = Number(this.config.server && this.config.server.sessionHours) || 12;
    return hours * 60 * 60 * 1000;
  }

  _sign(payloadB64) {
    return crypto.createHmac('sha256', this.state.secret).update(payloadB64).digest('base64url');
  }

  issueToken() {
    const now = Date.now();
    const payload = { role: 'operator', iat: now, exp: now + this._ttl() };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: b64 + '.' + this._sign(b64), expiresAt: new Date(payload.exp).toISOString() };
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = this._sign(parts[0]);
    if (!safeEqual(expected, parts[1])) return null;
    try {
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (!payload || payload.role !== 'operator') return null;
      if (!payload.exp || payload.exp < Date.now()) return null;
      return payload;
    } catch (err) {
      return null;
    }
  }

  login(pin, ip) {
    if (!this.loginLimiter.check(ip || 'unknown')) {
      const err = new Error('Too many attempts. Wait a minute and try again.');
      err.status = 429;
      throw err;
    }
    const hash = hashPin(String(pin || ''), this.state.salt);
    if (!safeEqual(hash, this.state.pinHash)) {
      const err = new Error('Incorrect PIN');
      err.status = 401;
      throw err;
    }
    this.loginLimiter.hits.delete(ip || 'unknown');
    return this.issueToken();
  }

  changePin(currentPin, newPin) {
    const currentHash = hashPin(String(currentPin || ''), this.state.salt);
    if (!safeEqual(currentHash, this.state.pinHash)) {
      const err = new Error('Current PIN is incorrect');
      err.status = 401;
      throw err;
    }
    if (!/^\d{4,12}$/.test(String(newPin || ''))) {
      const err = new Error('New PIN must be 4–12 digits');
      err.status = 400;
      throw err;
    }
    const salt = this._salt();
    this.state.salt = salt;
    this.state.pinHash = hashPin(newPin, salt);
    this.state.secret = crypto.randomBytes(48).toString('hex');
    this.state.pinChangedAt = new Date().toISOString();
    this.state.defaultPin = String(newPin) === '1234';
    writeJsonAtomic(this.file, this.state);
    return this.issueToken();
  }

  isDefaultPin() { return !!this.state.defaultPin; }

  bearer(req) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('token') || '';
  }

  require(req) {
    const payload = this.verifyToken(this.bearer(req));
    if (!payload) {
      const err = new Error('Operator authentication required');
      err.status = 401;
      throw err;
    }
    return payload;
  }
}

module.exports = Auth;
