/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Shared VAT-inclusive AED pricing engine. (AL SHAJAR TEAM)
 *
 * All listed prices already include 5% UAE VAT. The VAT breakdown is
 * reverse-calculated from the final VAT-inclusive total, never added on top.
 * The same engine runs in the browser and on the Node.js server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrintPricing = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PRICING = {
    currency: 'AED',
    vatPercent: 5,
    bwBlockPages: 8,
    rates: {
      A4: { bwBlockPrice: 1, colorPagePrice: 1 },
      A5: { bwBlockPrice: 1, colorPagePrice: 1 },
      A3: { bwPagePrice: 2, colorPagePrice: 3 }
    }
  };

  const DEFAULT_DELIVERY = { fee: 10, freeThreshold: 50 };

  function round2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function mergePricing(custom) {
    const source = custom || {};
    const rates = source.rates || {};
    return {
      currency: 'AED',
      vatPercent: Number.isFinite(Number(source.vatPercent)) ? Number(source.vatPercent) : DEFAULT_PRICING.vatPercent,
      bwBlockPages: Math.max(1, Math.round(Number(source.bwBlockPages) || DEFAULT_PRICING.bwBlockPages)),
      rates: {
        A4: {
          bwBlockPrice: Number((rates.A4 || {}).bwBlockPrice ?? DEFAULT_PRICING.rates.A4.bwBlockPrice),
          colorPagePrice: Number((rates.A4 || {}).colorPagePrice ?? DEFAULT_PRICING.rates.A4.colorPagePrice)
        },
        A5: {
          bwBlockPrice: Number((rates.A5 || {}).bwBlockPrice ?? DEFAULT_PRICING.rates.A5.bwBlockPrice),
          colorPagePrice: Number((rates.A5 || {}).colorPagePrice ?? DEFAULT_PRICING.rates.A5.colorPagePrice)
        },
        A3: {
          bwPagePrice: Number((rates.A3 || {}).bwPagePrice ?? DEFAULT_PRICING.rates.A3.bwPagePrice),
          colorPagePrice: Number((rates.A3 || {}).colorPagePrice ?? DEFAULT_PRICING.rates.A3.colorPagePrice)
        }
      }
    };
  }

  function mergeDelivery(custom) {
    const source = custom || {};
    return {
      fee: Math.max(0, Number(source.fee ?? DEFAULT_DELIVERY.fee)),
      freeThreshold: Math.max(0, Number(source.freeThreshold ?? DEFAULT_DELIVERY.freeThreshold))
    };
  }

  /**
   * Calculate a VAT-inclusive AED quote.
   *
   * @param {Object} input
   * @param {number} input.pageCount   Selected PDF pages (not sheets).
   * @param {number} input.copies
   * @param {string} input.size        A4 | A5 | A3
   * @param {boolean|string} input.color true/"color" or false/"bw"
   * @param {string} input.fulfillment pickup | delivery
   * @param {Object} input.pricing
   * @param {Object} input.delivery
   */
  function calculate(input) {
    const opts = input || {};
    const pricing = mergePricing(opts.pricing);
    const delivery = mergeDelivery(opts.delivery);
    const vatPercent = clamp(pricing.vatPercent, 0, 100);

    const pageCount = Math.max(0, Math.round(Number(opts.pageCount) || 0));
    const copies = clamp(Math.round(Number(opts.copies) || 1), 1, 999);
    const isColor = opts.color === true || opts.color === 'color';
    const size = ['A4', 'A5', 'A3'].indexOf(String(opts.size)) >= 0 ? String(opts.size) : 'A4';
    const fulfillment = opts.fulfillment === 'delivery' ? 'delivery' : 'pickup';
    const billablePages = pageCount * copies;

    let printTotal = 0;
    let printDetail = '';
    let blocks = 0;

    if (billablePages > 0) {
      if (size === 'A3') {
        const unit = isColor ? pricing.rates.A3.colorPagePrice : pricing.rates.A3.bwPagePrice;
        printTotal = billablePages * unit;
        printDetail = billablePages + ' A3 page' + (billablePages === 1 ? '' : 's') + ' × ' + money(unit);
      } else if (isColor) {
        const unit = pricing.rates[size].colorPagePrice;
        printTotal = billablePages * unit;
        printDetail = billablePages + ' ' + size + ' colour page' + (billablePages === 1 ? '' : 's') + ' × ' + money(unit);
      } else {
        blocks = Math.ceil(billablePages / pricing.bwBlockPages);
        printTotal = blocks * pricing.rates[size].bwBlockPrice;
        printDetail = billablePages + ' ' + size + ' B&W page' + (billablePages === 1 ? '' : 's') +
          ' · ' + blocks + ' × ' + pricing.bwBlockPages + '-page block' +
          (pricing.rates[size].bwBlockPrice === 1 ? '' : ' × ' + money(pricing.rates[size].bwBlockPrice));
      }
    }

    printTotal = round2(printTotal);

    const qualifiesFree = fulfillment === 'delivery' && printTotal >= delivery.freeThreshold;
    const deliveryFee = fulfillment === 'delivery' && !qualifiesFree ? round2(delivery.fee) : 0;
    const total = round2(printTotal + deliveryFee);
    const subtotalExVat = round2(total / (1 + vatPercent / 100));
    const vat = round2(total - subtotalExVat);

    const lines = [];
    lines.push({
      key: 'printing',
      label: (isColor ? 'Colour printing' : 'Black & white printing') + ' · ' + size,
      detail: printDetail || 'No pages selected',
      amount: printTotal,
      inclusive: true
    });

    if (fulfillment === 'delivery') {
      lines.push({
        key: 'delivery',
        label: 'Home delivery',
        detail: qualifiesFree
          ? 'Free — order is ' + money(delivery.freeThreshold) + ' or more'
          : 'Order is under ' + money(delivery.freeThreshold),
        amount: deliveryFee,
        free: qualifiesFree,
        inclusive: true
      });
    }

    return {
      currency: 'AED',
      vatPercent: vatPercent,
      pageCount: pageCount,
      copies: copies,
      billablePages: billablePages,
      size: size,
      color: isColor,
      fulfillment: fulfillment,
      blocks: blocks,
      printTotal: printTotal,
      deliveryFee: deliveryFee,
      freeDelivery: qualifiesFree,
      freeDeliveryThreshold: round2(delivery.freeThreshold),
      freeDeliveryRemaining: fulfillment === 'delivery' && !qualifiesFree
        ? round2(delivery.freeThreshold - printTotal)
        : 0,
      total: total,
      subtotalExVat: subtotalExVat,
      vat: vat,
      lines: lines
    };
  }

  function money(value) {
    const n = round2(value);
    return 'AED ' + n.toFixed(2);
  }

  function formatAED(value) {
    return money(value);
  }

  function describeRate(size, color, pricing) {
    const p = mergePricing(pricing);
    if (size === 'A3') {
      return color
        ? 'A3 colour: AED ' + p.rates.A3.colorPagePrice.toFixed(2) + ' per page'
        : 'A3 black & white: AED ' + p.rates.A3.bwPagePrice.toFixed(2) + ' per page';
    }
    if (color) {
      return size + ' colour: AED ' + p.rates[size].colorPagePrice.toFixed(2) + ' per page';
    }
    return size + ' black & white: AED ' + p.rates[size].bwBlockPrice.toFixed(2) +
      ' per ' + p.bwBlockPages + ' pages (or part of ' + p.bwBlockPages + ')';
  }

  return {
    DEFAULT_PRICING: DEFAULT_PRICING,
    DEFAULT_DELIVERY: DEFAULT_DELIVERY,
    calculate: calculate,
    mergePricing: mergePricing,
    mergeDelivery: mergeDelivery,
    round2: round2,
    formatAED: formatAED,
    describeRate: describeRate,
    clamp: clamp
  };
});
