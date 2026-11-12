/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Configuration load, validation and public projection. (AL SHAJAR TEAM)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, clamp } = require('./util');

const DEFAULT_CONFIG = {
  shop: {
    name: 'AL SHAJAR STATIONERY',
    shortName: 'SHS',
    tagline: 'Smart Print Gateway',
    phone: '',
    whatsapp: '',
    email: '',
    address: 'United Arab Emirates',
    timezone: 'Asia/Dubai',
    welcome: 'Upload your files, choose your options and send the job to our print desk. We will review and print it.',
    pickupNote: 'Collect your prints from the counter and quote your job number.',
    deliveryNote: 'We will call you when your delivery is on the way.',
    footerNote: '© 2026 AL SHAJAR STATIONERY. All rights reserved.'
  },
  server: {
    port: 4173,
    host: '0.0.0.0',
    retentionDays: 30,
    maxFileMB: 50,
    maxJobMB: 120,
    maxPages: 500,
    sessionHours: 12,
    printMode: 'simulate',
    defaultPrinterId: 'canon-c5760i',
    sumatraPath: '',
    sofficePath: '',
    lpPath: '',
    printTimeoutSeconds: 180,
    autoRefreshSeconds: 12
  },
  delivery: {
    fee: 10,
    freeThreshold: 50
  },
  pricing: {
    currency: 'AED',
    vatPercent: 5,
    bwBlockPages: 8,
    rates: {
      A4: { bwBlockPrice: 1, colorPagePrice: 1 },
      A5: { bwBlockPrice: 1, colorPagePrice: 1 },
      A3: { bwPagePrice: 2, colorPagePrice: 3 }
    }
  },
  printers: [
    {
      id: 'canon-c5760i',
      name: 'Canon iR-ADV C5760i',
      model: 'imageRUNNER ADVANCE C5760i',
      systemName: 'Canon iR-ADV C5760i',
      location: 'Counter 1 · Colour',
      capabilities: ['color', 'duplex', 'staple', 'a3'],
      enabled: true
    },
    {
      id: 'canon-c5550',
      name: 'Canon iR-ADV C5550',
      model: 'imageRUNNER ADVANCE C5550',
      systemName: 'Canon iR-ADV C5550',
      location: 'Counter 2 · Mono',
      capabilities: ['mono', 'duplex', 'staple', 'a3'],
      enabled: true
    }
  ]
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return clone(patch);
  if (!patch || typeof patch !== 'object') return patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  Object.keys(patch).forEach(function (key) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] && typeof out[key] === 'object' ? out[key] : {}, value);
    } else {
      out[key] = value;
    }
  });
  return out;
}

function stringValue(value, max, fallback) {
  if (value == null) return fallback;
  return String(value).trim().slice(0, max || 500);
}

function numberValue(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function normalizeConfig(input) {
  const cfg = deepMerge(clone(DEFAULT_CONFIG), input || {});
  const shop = cfg.shop;
  shop.name = stringValue(shop.name, 80, DEFAULT_CONFIG.shop.name) || DEFAULT_CONFIG.shop.name;
  shop.shortName = stringValue(shop.shortName, 12, 'SHS') || 'SHS';
  shop.tagline = stringValue(shop.tagline, 80, DEFAULT_CONFIG.shop.tagline);
  shop.phone = stringValue(shop.phone, 40, '');
  shop.whatsapp = stringValue(shop.whatsapp, 40, '');
  shop.email = stringValue(shop.email, 120, '');
  shop.address = stringValue(shop.address, 240, '');
  shop.timezone = 'Asia/Dubai';
  shop.welcome = stringValue(shop.welcome, 500, DEFAULT_CONFIG.shop.welcome);
  shop.pickupNote = stringValue(shop.pickupNote, 500, DEFAULT_CONFIG.shop.pickupNote);
  shop.deliveryNote = stringValue(shop.deliveryNote, 500, DEFAULT_CONFIG.shop.deliveryNote);
  shop.footerNote = stringValue(shop.footerNote, 240, DEFAULT_CONFIG.shop.footerNote);

  const server = cfg.server;
  server.host = '0.0.0.0';
  server.port = Math.round(numberValue(server.port, 1, 65535, 4173));
  server.retentionDays = Math.round(numberValue(server.retentionDays, 1, 365, 30));
  server.maxFileMB = Math.round(numberValue(server.maxFileMB, 1, 300, 50));
  server.maxJobMB = Math.round(numberValue(server.maxJobMB, 1, 500, 120));
  server.maxPages = Math.round(numberValue(server.maxPages, 1, 2000, 500));
  server.sessionHours = Math.round(numberValue(server.sessionHours, 1, 168, 12));
  server.printMode = server.printMode === 'live' ? 'live' : 'simulate';
  server.defaultPrinterId = stringValue(server.defaultPrinterId, 80, 'canon-c5760i');
  server.sumatraPath = stringValue(server.sumatraPath, 500, '');
  server.sofficePath = stringValue(server.sofficePath, 500, '');
  server.lpPath = stringValue(server.lpPath, 500, '');
  server.printTimeoutSeconds = Math.round(numberValue(server.printTimeoutSeconds, 20, 1200, 180));
  server.autoRefreshSeconds = Math.round(numberValue(server.autoRefreshSeconds, 5, 120, 12));

  cfg.delivery.fee = numberValue(cfg.delivery.fee, 0, 1000, 10);
  cfg.delivery.freeThreshold = numberValue(cfg.delivery.freeThreshold, 0, 10000, 50);

  cfg.pricing.currency = 'AED';
  cfg.pricing.vatPercent = 5;
  cfg.pricing.bwBlockPages = Math.round(numberValue(cfg.pricing.bwBlockPages, 1, 100, 8));
  const rates = cfg.pricing.rates || {};
  const safeRates = {
    A4: {
      bwBlockPrice: numberValue((rates.A4 || {}).bwBlockPrice, 0, 1000, 1),
      colorPagePrice: numberValue((rates.A4 || {}).colorPagePrice, 0, 1000, 1)
    },
    A5: {
      bwBlockPrice: numberValue((rates.A5 || {}).bwBlockPrice, 0, 1000, 1),
      colorPagePrice: numberValue((rates.A5 || {}).colorPagePrice, 0, 1000, 1)
    },
    A3: {
      bwPagePrice: numberValue((rates.A3 || {}).bwPagePrice, 0, 1000, 2),
      colorPagePrice: numberValue((rates.A3 || {}).colorPagePrice, 0, 1000, 3)
    }
  };
  cfg.pricing.rates = safeRates;

  if (!Array.isArray(cfg.printers) || !cfg.printers.length) cfg.printers = clone(DEFAULT_CONFIG.printers);
  cfg.printers = cfg.printers.slice(0, 20).map(function (printer, index) {
    const caps = Array.isArray(printer.capabilities) ? printer.capabilities.filter(function (c) {
      return ['color', 'mono', 'duplex', 'staple', 'booklet', 'a3'].indexOf(c) >= 0;
    }) : [];
    return {
      id: stringValue(printer.id, 60, 'printer-' + (index + 1)).replace(/[^a-zA-Z0-9_-]/g, '-') || ('printer-' + (index + 1)),
      name: stringValue(printer.name, 80, 'Printer ' + (index + 1)),
      model: stringValue(printer.model, 100, ''),
      systemName: stringValue(printer.systemName, 160, ''),
      location: stringValue(printer.location, 100, ''),
      capabilities: caps.length ? caps : ['mono', 'duplex'],
      enabled: printer.enabled !== false
    };
  });

  return cfg;
}

function loadConfig(configPath) {
  const raw = readJson(configPath, null);
  if (!raw) {
    const fresh = normalizeConfig({});
    writeJsonAtomic(configPath, fresh);
    return fresh;
  }
  return normalizeConfig(raw);
}

function saveConfig(configPath, config) {
  const normalized = normalizeConfig(config);
  writeJsonAtomic(configPath, normalized);
  return normalized;
}

function applySettingsPatch(config, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('Settings payload is required.');
  const current = clone(config);
  const next = {
    shop: Object.assign({}, current.shop, patch.shop && typeof patch.shop === 'object' ? patch.shop : {}),
    server: Object.assign({}, current.server, patch.server && typeof patch.server === 'object' ? patch.server : {}),
    delivery: Object.assign({}, current.delivery, patch.delivery && typeof patch.delivery === 'object' ? patch.delivery : {}),
    pricing: {
      currency: 'AED',
      vatPercent: 5,
      bwBlockPages: (patch.pricing && patch.pricing.bwBlockPages != null)
        ? patch.pricing.bwBlockPages
        : current.pricing.bwBlockPages,
      rates: {
        A4: Object.assign({}, current.pricing.rates.A4, (patch.pricing && patch.pricing.rates && patch.pricing.rates.A4) || {}),
        A5: Object.assign({}, current.pricing.rates.A5, (patch.pricing && patch.pricing.rates && patch.pricing.rates.A5) || {}),
        A3: Object.assign({}, current.pricing.rates.A3, (patch.pricing && patch.pricing.rates && patch.pricing.rates.A3) || {})
      }
    },
    printers: Array.isArray(patch.printers) ? patch.printers : current.printers
  };
  return normalizeConfig(next);
}

function publicConfig(config, extra) {
  const printers = config.printers.filter(function (p) { return p.enabled; }).map(function (p) {
    return {
      id: p.id,
      name: p.name,
      model: p.model,
      location: p.location,
      capabilities: p.capabilities
    };
  });
  return {
    shop: clone(config.shop),
    delivery: clone(config.delivery),
    pricing: clone(config.pricing),
    printers: printers,
    limits: {
      maxFileMB: config.server.maxFileMB,
      maxJobMB: config.server.maxJobMB,
      maxPages: config.server.maxPages
    },
    autoRefreshSeconds: config.server.autoRefreshSeconds,
    capabilities: extra && extra.capabilities ? extra.capabilities : {},
    serverTime: new Date().toISOString(),
    version: '1.0.0'
  };
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  normalizeConfig,
  applySettingsPatch,
  publicConfig,
  configPath: path.join(__dirname, '..', 'config', 'shop.config.json')
};
