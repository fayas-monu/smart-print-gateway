/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Shared page-range, sheet-layout and imposition geometry. (AL SHAJAR TEAM)
 *
 * Used by the browser preview, the browser print-ready builder and the Node
 * server so all three agree on page order, sheet counts, N-up cells and
 * orientation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrintLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // PDF points (1/72 inch)
  const PAPER_SIZES = {
    A4: { width: 595.28, height: 841.89, label: 'A4', mm: '210 × 297 mm' },
    A5: { width: 419.53, height: 595.28, label: 'A5', mm: '148 × 210 mm' },
    A3: { width: 841.89, height: 1190.55, label: 'A3', mm: '297 × 420 mm' }
  };

  const NUP_OPTIONS = [1, 2, 4];
  const MARGIN_PT = 12;
  const GAP_PT = 10;

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeSize(size) {
    return PAPER_SIZES[size] ? size : 'A4';
  }

  function normalizeNup(nup) {
    const n = Math.round(Number(nup) || 1);
    return NUP_OPTIONS.indexOf(n) >= 0 ? n : 1;
  }

  function normalizeOrientation(orientation) {
    return orientation === 'landscape' || orientation === 'portrait' ? orientation : 'auto';
  }

  function normalizeRotation(angle) {
    let a = Math.round(Number(angle) || 0) % 360;
    if (a < 0) a += 360;
    if (a !== 90 && a !== 180 && a !== 270) a = 0;
    return a;
  }

  function parsePageRange(value, totalPages) {
    const total = Math.max(0, Math.round(Number(totalPages) || 0));
    const text = String(value == null ? '' : value)
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s*-\s*/g, '-')
      .trim();
    if (!text) throw new Error('Enter a page range such as 1-4, 7, 10-12.');

    const tokens = text.split(/[,;\s]+/).filter(Boolean);
    if (!tokens.length) throw new Error('Enter a page range such as 1-4, 7, 10-12.');

    const seen = Object.create(null);
    const pages = [];

    function add(num) {
      if (!Number.isInteger(num) || num < 1 || num > total) {
        throw new Error('Page ' + num + ' is outside 1–' + total + '.');
      }
      if (!seen[num]) {
        seen[num] = true;
        pages.push(num);
      }
    }

    tokens.forEach(function (token) {
      const range = /^(\d+)-(\d+)$/.exec(token);
      if (range) {
        const start = parseInt(range[1], 10);
        const end = parseInt(range[2], 10);
        if (start > end) throw new Error('Range "' + token + '" is backwards. Use ' + end + '-' + start + '.');
        if (end - start > 5000) throw new Error('That page range is too large.');
        for (let p = start; p <= end; p += 1) add(p);
        return;
      }
      if (/^\d+$/.test(token)) {
        add(parseInt(token, 10));
        return;
      }
      throw new Error('Could not read "' + token + '". Use page numbers like 1-4, 7, 10-12.');
    });

    return pages;
  }

  function pageMeta(doc, index) {
    const pages = doc && Array.isArray(doc.pages) ? doc.pages : [];
    const meta = pages[index] || {};
    const w = Number(meta.width);
    const h = Number(meta.height);
    return {
      width: Number.isFinite(w) && w > 0 ? w : PAPER_SIZES.A4.width,
      height: Number.isFinite(h) && h > 0 ? h : PAPER_SIZES.A4.height
    };
  }

  function flattenPages(documents) {
    const flat = [];
    (Array.isArray(documents) ? documents : []).forEach(function (doc, docIndex) {
      const count = Math.max(0, Math.round(Number(doc.pageCount) || (Array.isArray(doc.pages) ? doc.pages.length : 0)));
      for (let i = 0; i < count; i += 1) {
        const meta = pageMeta(doc, i);
        flat.push({
          number: flat.length + 1,
          docIndex: docIndex,
          pageIndex: i,
          width: meta.width,
          height: meta.height
        });
      }
    });
    return flat;
  }

  /**
   * @param {Array} documents [{ pageCount, pages:[{width,height}] }]
   * @param {Object} pageRange { mode:'all'|'custom', value:'1-4,7' }
   * @returns {Array} [{ number, docIndex, pageIndex, width, height }]
   */
  function resolvePageList(documents, pageRange) {
    const flat = flattenPages(documents);
    const mode = pageRange && pageRange.mode === 'custom' ? 'custom' : 'all';
    if (mode === 'all') return flat;
    const numbers = parsePageRange(pageRange.value, flat.length);
    return numbers.map(function (n) { return flat[n - 1]; });
  }

  function planOutput(input) {
    const opts = input || {};
    const settings = opts.settings || {};
    const nup = normalizeNup(settings.nup);
    const duplex = !!settings.duplex;
    const pageList = opts.pageList || resolvePageList(opts.documents || [], opts.pageRange || settings.pageRange);
    const rawSides = Math.ceil(pageList.length / nup);
    const sheets = duplex ? Math.ceil(rawSides / 2) : rawSides;
    const outputSides = duplex ? sheets * 2 : rawSides;

    const sides = [];
    for (let i = 0; i < pageList.length; i += nup) {
      sides.push(pageList.slice(i, i + nup));
    }
    if (duplex && sides.length % 2 === 1) sides.push([]);

    return {
      pageList: pageList,
      pageCount: pageList.length,
      nup: nup,
      duplex: duplex,
      rawSides: rawSides,
      sheets: sheets,
      outputSides: outputSides,
      sides: sides
    };
  }

  function sheetSizeFor(paper, orientation, nup, firstPage) {
    const size = PAPER_SIZES[normalizeSize(paper)];
    const grid = normalizeNup(nup);
    const orient = normalizeOrientation(orientation);
    let landscape;

    if (orient === 'landscape') landscape = true;
    else if (orient === 'portrait') landscape = false;
    else if (grid === 1) landscape = !!(firstPage && Number(firstPage.width) > Number(firstPage.height));
    else if (grid === 2) landscape = true;
    else landscape = false;

    return {
      width: landscape ? size.height : size.width,
      height: landscape ? size.width : size.height,
      landscape: landscape,
      paper: normalizeSize(paper)
    };
  }

  function gridFor(nup, sheetWidth, sheetHeight) {
    const n = normalizeNup(nup);
    if (n === 2) {
      return Number(sheetWidth) > Number(sheetHeight) ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
    }
    if (n === 4) return { cols: 2, rows: 2 };
    return { cols: 1, rows: 1 };
  }

  /**
   * Returns cells in top-left canvas coordinates. For PDF output convert with
   * yPdf = sheetHeight - cell.y - cell.h.
   */
  function cellsFor(sheetWidth, sheetHeight, nup, options) {
    const opts = options || {};
    const margin = opts.margin == null ? MARGIN_PT : Math.max(0, Number(opts.margin));
    const gap = opts.gap == null ? GAP_PT : Math.max(0, Number(opts.gap));
    const grid = opts.grid || gridFor(nup, sheetWidth, sheetHeight);
    const cols = Math.max(1, Math.round(grid.cols));
    const rows = Math.max(1, Math.round(grid.rows));
    const innerW = Math.max(1, sheetWidth - margin * 2 - gap * (cols - 1));
    const innerH = Math.max(1, sheetHeight - margin * 2 - gap * (rows - 1));
    const cellW = innerW / cols;
    const cellH = innerH / rows;
    const cells = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        cells.push({
          x: margin + c * (cellW + gap),
          y: margin + r * (cellH + gap),
          w: cellW,
          h: cellH,
          row: r,
          col: c
        });
      }
    }
    return { cols: cols, rows: rows, cells: cells, margin: margin, gap: gap, cellW: cellW, cellH: cellH };
  }

  /**
   * Fits a *displayed* page (rotation already applied) into a cell.
   * Rotates by 90 when the page and cell orientations disagree.
   */
  function placementFor(pageWidth, pageHeight, cell) {
    const pw = Math.max(1, Number(pageWidth) || 1);
    const ph = Math.max(1, Number(pageHeight) || 1);
    const cw = Math.max(1, Number(cell.w) || 1);
    const ch = Math.max(1, Number(cell.h) || 1);
    const rotate = (pw > ph) !== (cw > ch) ? 90 : 0;
    const effectiveW = rotate ? ph : pw;
    const effectiveH = rotate ? pw : ph;
    const scale = Math.min(cw / effectiveW, ch / effectiveH);
    return {
      rotate: rotate,
      scale: scale,
      width: pw * scale,
      height: ph * scale,
      cx: cell.x + cw / 2,
      cy: cell.y + ch / 2
    };
  }

  function sideLabel(sideIndex, plan) {
    const duplex = !!(plan && plan.duplex);
    const outputSides = plan ? plan.outputSides : 1;
    if (duplex) {
      const sheet = Math.floor(sideIndex / 2) + 1;
      const back = sideIndex % 2 === 1;
      return 'Sheet ' + sheet + ' of ' + (plan.sheets || Math.ceil(outputSides / 2)) + ' · ' + (back ? 'Back' : 'Front');
    }
    return 'Side ' + (sideIndex + 1) + ' of ' + outputSides;
  }

  function countPages(documents) {
    return flattenPages(documents).length;
  }

  return {
    PAPER_SIZES: PAPER_SIZES,
    NUP_OPTIONS: NUP_OPTIONS,
    MARGIN_PT: MARGIN_PT,
    GAP_PT: GAP_PT,
    normalizeSize: normalizeSize,
    normalizeNup: normalizeNup,
    normalizeOrientation: normalizeOrientation,
    normalizeRotation: normalizeRotation,
    parsePageRange: parsePageRange,
    flattenPages: flattenPages,
    resolvePageList: resolvePageList,
    planOutput: planOutput,
    sheetSizeFor: sheetSizeFor,
    gridFor: gridFor,
    cellsFor: cellsFor,
    placementFor: placementFor,
    sideLabel: sideLabel,
    countPages: countPages,
    clamp: clamp
  };
});
