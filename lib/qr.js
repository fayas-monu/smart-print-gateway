/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Offline QR SVG generation for the LAN portal address. (AL SHAJAR TEAM)
 *
 * Vendored qrcode-generator (MIT, Kazuhiko Arase) — no network calls.
 */
'use strict';

const qrcode = require('./vendor/qrcode.js');

function svgFor(text, options) {
  const opts = options || {};
  const value = String(text || '').trim();
  if (!value) return '';
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({
    cellSize: opts.cellSize || 6,
    margin: opts.margin == null ? 3 : opts.margin,
    alt: opts.alt || 'QR code for the customer print portal'
  });
}

function dataUrlFor(text, options) {
  const svg = svgFor(text, options);
  if (!svg) return '';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

module.exports = { svgFor, dataUrlFor };
