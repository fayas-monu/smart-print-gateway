/*
 * Smart Print Gateway — shared pricing engine
 * Used by both the browser client and the Node.js backend so that the
 * customer estimate and the operator total are always computed identically.
 *
 * All money is handled internally in "baisa" (1/1000 of an OMR) to avoid
 * floating point drift. Output is rounded to 3 decimals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrintPricing = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PRICING = {
    currency: 'OMR',
    vatPercent: 5,
    minimumCharge: 0.5,
    rates: {
      bwPerA4Side: 0.025,
      colorPerA4Side: 0.15,
      sizeMultipliers: { A4: 1, A3: 2, A5: 0.7, Letter: 1, Legal: 1.3 },
      paperMultipliers: { plain: 1, recycled: 0.95, heavy1: 1.25, heavy2: 1.5, photo: 2.5, transparency: 3 },
      duplexFactor: 0.95,
      finishing: { collate: 0, group: 0, stapleCollate: 0.5, ecoStaple: 0.3, booklet: 0.75, fold: 0.2 },
      extras: { lamination: 0.3, cutting: 0.1, rushPercent: 20 }
    }
  };

  const PAPER_LABELS = {
    A3: 'A3', A4: 'A4', A5: 'A5', Letter: 'Letter', Legal: 'Legal'
  };
  const PAPER_TYPES = {
    plain: 'Plain 64–105 gsm', recycled: 'Recycled', heavy1: 'Heavy 1 106–150 gsm',
    heavy2: 'Heavy 2 151–220 gsm', photo: 'Photo paper', transparency: 'Transparency'
  };
  const PAPER_MM = {
    A3: [297, 420], A4: [210, 297], A5: [148, 210],
    Letter: [215.9, 279.4], Legal: [215.9, 355.6]
  };
  const MM_PER_PT = 25.4 / 72;

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function money(baisa) { return Math.round(baisa) / 1000; }

  function mergeRates(custom) {
    const base = JSON.parse(JSON.stringify(DEFAULT_PRICING));
    if (!custom) return base;
    const out = Object.assign({}, base, custom);
    out.rates = Object.assign({}, base.rates, custom.rates || {});
    out.rates.sizeMultipliers = Object.assign({}, base.rates.sizeMultipliers, (custom.rates || {}).sizeMultipliers || {});
    out.rates.paperMultipliers = Object.assign({}, base.rates.paperMultipliers, (custom.rates || {}).paperMultipliers || {});
    out.rates.finishing = Object.assign({}, base.rates.finishing, (custom.rates || {}).finishing || {});
    out.rates.extras = Object.assign({}, base.rates.extras, (custom.rates || {}).extras || {});
    return out;
  }

  /**
   * Number of paper tiles a single logical page needs in Poster mode.
   * Mirrors the geometry used by the client preview so the estimate matches.
   */
  function posterTilesFor(doc, settings, docs) {
    const canon = settings.canon || {};
    const poster = settings.poster || {};
    const size = PAPER_MM[canon.pageSize] || PAPER_MM.A4;
    const scale = clamp(num(poster.tileScale, 100), 10, 400) / 100;
    const overlapMm = clamp(num(poster.overlap, 0), 0, 2) * 25.4;

    let orientation = settings.orientation;
    if (orientation !== 'portrait' && orientation !== 'landscape') {
      const first = docs && docs[0];
      orientation = first && num(first.pageW, 0) > num(first.pageH, 0) ? 'landscape' : 'portrait';
    }
    const paperW = orientation === 'landscape' ? size[1] : size[0];
    const paperH = orientation === 'landscape' ? size[0] : size[1];
    const pageW = num(doc.pageW, 0) > 0 ? num(doc.pageW, 0) * MM_PER_PT : paperW;
    const pageH = num(doc.pageH, 0) > 0 ? num(doc.pageH, 0) * MM_PER_PT : paperH;

    const stepW = Math.max(10, paperW - overlapMm);
    const stepH = Math.max(10, paperH - overlapMm);
    const cols = clamp(Math.ceil(Math.max(1, pageW * scale - overlapMm) / stepW), 1, 12);
    const rows = clamp(Math.ceil(Math.max(1, pageH * scale - overlapMm) / stepH), 1, 12);
    return cols * rows;
  }

  function nupPerSheet(settings) {
    const nup = settings.nup || {};
    const valid = [1, 2, 4, 6, 8, 9, 12, 16];
    let per = Math.round(num(nup.pagesPerSheet, 4));
    if (!valid.includes(per)) {
      const cols = clamp(Math.round(num(nup.customCols, 2)), 1, 8);
      let rows = clamp(Math.round(num(nup.customRows, 2)), 1, 8);
      while (cols * rows > 16 && rows > 1) rows -= 1;
      per = cols * rows;
    }
    return clamp(per, 1, 16);
  }

  /**
   * @param {Object} input
   * @param {Array}  input.documents  [{pages, colorPages, pageW, pageH}]
   * @param {Object} input.settings   normalized print settings
   * @param {Object} input.pricing    pricing config (optional)
   */
  function calculate(input) {
    const pricing = mergeRates((input && input.pricing) || null);
    const settings = (input && input.settings) || {};
    const canon = settings.canon || {};
    const docs = Array.isArray(input && input.documents) ? input.documents : [];

    const copies = clamp(Math.round(num(canon.copies, 1)), 1, 9999);
    const colorMode = canon.colorMode || 'auto';
    const isColor = colorMode === 'auto';
    const size = canon.pageSize || 'A4';
    const paperType = canon.paperType || 'plain';
    const sizingMode = settings.sizingMode || 'size';
    const poster = sizingMode === 'poster';
    const duplex = !poster && (canon.printStyle === '2sided' || canon.printStyle === 'booklet' || sizingMode === 'booklet');
    const booklet = !poster && (canon.printStyle === 'booklet' || sizingMode === 'booklet');

    const sizeMul = num(pricing.rates.sizeMultipliers[size], 1);
    const paperMul = num(pricing.rates.paperMultipliers[paperType], 1);
    const duplexFactor = duplex ? num(pricing.rates.duplexFactor, 0.95) : 1;
    const bwRate = num(pricing.rates.bwPerA4Side, 0.025);
    const colorRate = num(pricing.rates.colorPerA4Side, 0.15);

    let logicalPages = 0;
    let colorPages = 0;
    let bwPages = 0;
    let posterSheets = 0;
    let pageCostBase = 0;
    docs.forEach(function (doc) {
      const p = Math.max(0, Math.round(num(doc.pages, 0)));
      const cp = clamp(Math.round(num(doc.colorPages, isColor ? p : 0)), 0, p);
      logicalPages += p;
      if (isColor) { colorPages += cp; bwPages += p - cp; }
      else { bwPages += p; }
      const tiles = poster ? posterTilesFor(doc, settings, docs) : 1;
      posterSheets += p * tiles;
      const docColor = isColor ? cp : 0;
      const docBw = isColor ? p - cp : p;
      pageCostBase += (docColor * colorRate * 1000 * sizeMul * paperMul +
        docBw * bwRate * 1000 * sizeMul * paperMul) * tiles;
    });

    const paddedPages = booklet ? Math.ceil(logicalPages / 4) * 4 : logicalPages;
    const blankPages = paddedPages - logicalPages;

    const pageCost = pageCostBase * copies * duplexFactor;

    const finishingKey = canon.stapleCollate || 'collate';
    let finishingFee = num(pricing.rates.finishing[finishingKey], 0);
    if (booklet) finishingFee += num(pricing.rates.finishing.booklet, 0);
    if (settings.extras && settings.extras.folding) finishingFee += num(pricing.rates.finishing.fold, 0);
    const finishingCost = finishingFee * 1000 * copies;

    let sidesPerCopy;
    if (poster) sidesPerCopy = posterSheets;
    else if (booklet) sidesPerCopy = Math.ceil(paddedPages / 2);
    else if (sizingMode === 'multiple') sidesPerCopy = Math.ceil(paddedPages / nupPerSheet(settings));
    else sidesPerCopy = paddedPages;
    const sheetsPerCopy = duplex ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;
    const totalSheets = sheetsPerCopy * copies;
    const extras = settings.extras || {};
    let extrasCost = 0;
    const extraLines = [];
    if (extras.lamination) {
      const v = num(pricing.rates.extras.lamination, 0) * 1000 * totalSheets;
      extrasCost += v;
      extraLines.push({ label: 'Lamination', detail: totalSheets + ' sheets', amount: money(v) });
    }
    if (extras.cutting) {
      const v = num(pricing.rates.extras.cutting, 0) * 1000 * totalSheets;
      extrasCost += v;
      extraLines.push({ label: 'Cutting / trimming', detail: totalSheets + ' sheets', amount: money(v) });
    }

    let subtotal = pageCost + finishingCost + extrasCost;
    const minimum = num(pricing.minimumCharge, 0) * 1000;
    let minimumAdjustment = 0;
    if (subtotal > 0 && subtotal < minimum) {
      minimumAdjustment = minimum - subtotal;
      subtotal = minimum;
    }
    let rushCost = 0;
    if (extras.rush) {
      rushCost = subtotal * (num(pricing.rates.extras.rushPercent, 20) / 100);
      subtotal += rushCost;
      extraLines.push({ label: 'Rush service', detail: pricing.rates.extras.rushPercent + '%', amount: money(rushCost) });
    }
    const vat = subtotal * (num(pricing.vatPercent, 0) / 100);
    const total = subtotal + vat;

    const lines = [];
    lines.push({
      label: isColor ? 'Colour pages' : 'Black & white pages',
      detail: (isColor
        ? colorPages + ' colour + ' + bwPages + ' B&W × ' + copies
        : bwPages + ' pages × ' + copies) + (poster ? ' · ' + posterSheets + ' poster sheets/copy' : ''),
      amount: money(pageCost)
    });
    if (duplex) {
      lines.push({ label: 'Duplex / paper saving', detail: Math.round((1 - duplexFactor) * 100) + '% off', amount: -money(pageCost / duplexFactor * (1 - duplexFactor)) });
    }
    if (finishingFee > 0) {
      lines.push({
        label: booklet ? 'Booklet finishing' : finishingKey === 'stapleCollate' ? 'Stapling' : finishingKey === 'ecoStaple' ? 'Eco staple-free binding' : 'Finishing',
        detail: copies + ' set' + (copies > 1 ? 's' : ''),
        amount: money(finishingCost)
      });
    }
    if (blankPages > 0) {
      lines.push({ label: 'Booklet padding', detail: blankPages + ' blank page' + (blankPages > 1 ? 's' : ''), amount: 0 });
    }
    extraLines.forEach(function (l) { lines.push(l); });
    if (minimumAdjustment > 0) {
      lines.push({ label: 'Minimum order adjustment', detail: 'Shop minimum', amount: money(minimumAdjustment) });
    }

    return {
      currency: pricing.currency || 'OMR',
      copies: copies,
      pages: logicalPages,
      paddedPages: paddedPages,
      colorPages: colorPages,
      bwPages: bwPages,
      sheets: totalSheets,
      sheetsPerCopy: sheetsPerCopy,
      sides: poster ? totalSheets : sidesPerCopy * copies,
      poster: poster,
      posterSheets: posterSheets,
      duplex: duplex,
      booklet: booklet,
      size: size,
      paperType: paperType,
      paperTypeLabel: PAPER_TYPES[paperType] || paperType,
      paperLabel: PAPER_LABELS[size] || size,
      lines: lines,
      subtotal: money(subtotal),
      vatPercent: num(pricing.vatPercent, 0),
      vat: money(vat),
      total: money(total),
      estimatedMinutes: estimateMinutes(poster ? totalSheets : sidesPerCopy * copies, isColor ? colorPages * copies : 0, canon.resolution, booklet),
      minimumApplied: minimumAdjustment > 0
    };
  }

  function estimateMinutes(sides, colorSides, resolution, booklet) {
    if (!sides) return 0;
    const ppm = colorSides > 0 ? 42 : 55;
    const resolutionFactor = Number(resolution) >= 1200 ? 1.25 : 1;
    const setup = booklet ? 3 : 1.5;
    return Math.max(1, Math.round(setup + (sides / ppm) * resolutionFactor + (booklet ? sides * 0.02 : 0)));
  }

  function formatMoney(amount, currency) {
    const cur = currency || 'OMR';
    const n = Number(amount) || 0;
    return n.toFixed(3) + ' ' + cur;
  }

  return {
    DEFAULT_PRICING: DEFAULT_PRICING,
    PAPER_LABELS: PAPER_LABELS,
    PAPER_TYPES: PAPER_TYPES,
    mergeRates: mergeRates,
    calculate: calculate,
    estimateMinutes: estimateMinutes,
    formatMoney: formatMoney,
    clamp: clamp
  };
});
