'use strict';

const path = require('path');
const { readJson, writeJsonAtomic } = require('./util');

function loadConfig(root) {
  const file = path.join(root, 'config', 'shop.config.json');
  const config = readJson(file, null);
  if (!config) throw new Error('Missing or invalid config/shop.config.json');
  config.__file = file;
  return config;
}

function saveConfig(config) {
  const file = config.__file;
  const clean = Object.assign({}, config);
  delete clean.__file;
  writeJsonAtomic(file, clean);
  return config;
}

function publicConfig(config) {
  return {
    shop: config.shop,
    printers: (config.printers || []).filter(function (p) { return p.enabled !== false; }),
    pricing: config.pricing,
    features: config.features || {},
    printMode: (config.server && config.server.printMode) || 'simulate',
    defaultPrinterId: (config.server && config.server.defaultPrinterId) || null,
    maxFileMB: (config.server && config.server.maxFileMB) || 60,
    maxJobMB: (config.server && config.server.maxJobMB) || 180,
    version: require('../package.json').version
  };
}

module.exports = { loadConfig, saveConfig, publicConfig };
