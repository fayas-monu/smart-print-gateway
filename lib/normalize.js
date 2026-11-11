'use strict';

const { clamp } = require('./util');

const PAGE_SIZES = ['A3', 'A4', 'A5', 'Letter', 'Legal'];
const COLOR_MODES = ['auto', 'grayscale', 'mono'];
const PRINT_STYLES = ['1sided', '2sided', 'booklet'];
const BINDINGS = ['longEdgeLeft', 'longEdgeRight', 'shortEdgeTop', 'shortEdgeBottom'];
const FINISHING = ['collate', 'group', 'stapleCollate', 'ecoStaple'];
const SOURCES = ['auto', 'drawer1', 'drawer2', 'drawer3', 'bypass'];
const PAPERS = ['plain', 'recycled', 'heavy1', 'heavy2', 'photo', 'transparency'];
const OBJECTIVES = ['general', 'publications', 'graphics', 'vivid', 'cad'];
const SIZING = ['size', 'poster', 'multiple', 'booklet'];
const SIZE_MODES = ['fit', 'actual', 'shrink', 'custom'];
const ORIENTATIONS = ['auto', 'portrait', 'landscape'];
const PAGE_ORDERS = ['horizontal', 'horizontalReversed', 'vertical', 'verticalReversed'];

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function bool(v, fallback) {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function normalizeSettings(input, config) {
  const s = input && typeof input === 'object' ? input : {};
  const canon = s.canon && typeof s.canon === 'object' ? s.canon : {};
  const poster = s.poster && typeof s.poster === 'object' ? s.poster : {};
  const nup = s.nup && typeof s.nup === 'object' ? s.nup : {};
  const booklet = s.booklet && typeof s.booklet === 'object' ? s.booklet : {};
  const extras = s.extras && typeof s.extras === 'object' ? s.extras : {};

  const customCols = clamp(Math.round(Number(nup.customCols) || 2), 1, 8);
  const customRows = clamp(Math.round(Number(nup.customRows) || 2), 1, 8);
  const product = customCols * customRows;
  if (product > 16) {
    // Reduce rows until the grid fits the 16-up maximum.
    while (customCols * customRows > 16 && customRows > 1) customRows -= 1;
  }

  const defaultPrinter = (config.printers || []).find(function (p) { return p.enabled !== false; }) || {};
  const printerId = (config.printers || []).some(function (p) { return p.id === s.printerId && p.enabled !== false; })
    ? s.printerId
    : (config.server && config.server.defaultPrinterId) || defaultPrinter.id || 'canon-c5760i';

  return {
    printerId: printerId,
    pageRangeType: pick(s.pageRangeType, ['all', 'current', 'custom'], 'all'),
    pageRange: String(s.pageRange || '').slice(0, 120),
    sizingMode: pick(s.sizingMode, SIZING, 'size'),
    sizeMode: pick(s.sizeMode, SIZE_MODES, 'fit'),
    customScale: clamp(Number(s.customScale) || 100, 25, 400),
    chooseSourceByPdf: bool(s.chooseSourceByPdf, false),
    orientation: pick(s.orientation, ORIENTATIONS, 'auto'),
    exactImposition: bool(s.exactImposition, true),
    impositionQuality: [120, 150, 200, 300].includes(Number(s.impositionQuality)) ? Number(s.impositionQuality) : 150,
    poster: {
      tileScale: clamp(Number(poster.tileScale) || 100, 10, 400),
      overlap: clamp(Number(poster.overlap) || 0, 0, 2),
      cutMarks: bool(poster.cutMarks, true),
      labels: bool(poster.labels, false)
    },
    nup: {
      pagesPerSheet: [1, 2, 4, 6, 8, 9, 12, 16].includes(Number(nup.pagesPerSheet)) ? Number(nup.pagesPerSheet) : 4,
      customCols: customCols,
      customRows: customRows,
      pageOrder: pick(nup.pageOrder, PAGE_ORDERS, 'horizontal'),
      border: bool(nup.border, true),
      gutter: clamp(Number(nup.gutter) || 0, 0, 30)
    },
    booklet: {
      subset: pick(booklet.subset, ['both', 'front', 'back'], 'both'),
      binding: pick(booklet.binding, ['left', 'right', 'leftTall', 'rightTall'], 'left'),
      gutter: clamp(Number(booklet.gutter) || 0, 0, 50)
    },
    canon: {
      pageSize: pick(canon.pageSize, PAGE_SIZES, 'A4'),
      outputSize: pick(canon.outputSize, ['same'].concat(PAGE_SIZES), 'same'),
      copies: clamp(Math.round(Number(canon.copies) || 1), 1, 9999),
      orientation: pick(canon.orientation, ['portrait', 'landscape'], 'portrait'),
      pageLayout: String(canon.pageLayout || '1').slice(0, 4),
      colorMode: pick(canon.colorMode, COLOR_MODES, 'auto'),
      printStyle: pick(canon.printStyle, PRINT_STYLES, '1sided'),
      bindingLocation: pick(canon.bindingLocation, BINDINGS, 'longEdgeLeft'),
      stapleCollate: pick(canon.stapleCollate, FINISHING, 'collate'),
      paperSource: pick(canon.paperSource, SOURCES, 'auto'),
      paperType: pick(canon.paperType, PAPERS, 'plain'),
      objective: pick(canon.objective, OBJECTIVES, 'general'),
      resolution: Number(canon.resolution) === 1200 ? 1200 : 600
    },
    extras: {
      lamination: bool(extras.lamination, false),
      cutting: bool(extras.cutting, false),
      folding: bool(extras.folding, false),
      rush: bool(extras.rush, false)
    }
  };
}

function normalizeDocuments(input, maxPages) {
  if (!Array.isArray(input)) return [];
  const out = [];
  input.slice(0, 30).forEach(function (doc, i) {
    if (!doc || typeof doc !== 'object') return;
    const pages = clamp(Math.round(Number(doc.pages) || 1), 1, maxPages || 5000);
    const colorPages = clamp(Math.round(Number(doc.colorPages) || 0), 0, pages);
    out.push({
      index: i,
      name: String(doc.name || 'document').slice(0, 180),
      mime: String(doc.mime || 'application/octet-stream').slice(0, 100),
      size: clamp(Number(doc.size) || 0, 0, 2 * 1024 * 1024 * 1024),
      pages: pages,
      colorPages: colorPages,
      pageW: clamp(Number(doc.pageW) || 0, 0, 20000),
      pageH: clamp(Number(doc.pageH) || 0, 0, 20000),
      kind: ['pdf', 'image', 'word', 'excel', 'other'].includes(doc.kind) ? doc.kind : 'other',
      data: typeof doc.data === 'string' ? doc.data : '',
      printReadyData: typeof doc.printReadyData === 'string' ? doc.printReadyData : '',
      printReadyPages: clamp(Math.round(Number(doc.printReadyPages) || 0), 0, 5000)
    });
  });
  return out;
}

module.exports = { normalizeSettings, normalizeDocuments, PAGE_SIZES };
