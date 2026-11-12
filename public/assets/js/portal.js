/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Customer portal controller. (AL SHAJAR TEAM)
 */
(function () {
  'use strict';

  var SPG = window.SPG;
  var Pricing = window.PrintPricing;
  var Layout = window.PrintLayout;

  if (!SPG || !Pricing || !Layout) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:20px;font-family:sans-serif;background:#fbe9e4;color:#8d3523">' +
      'The print portal could not load its layout engine. Please refresh the page.</div>');
    return;
  }

  var MAX_FILES = 12;
  var MAX_COPIES = 99;
  var TERMINAL = ['completed', 'rejected', 'failed', 'cancelled'];

  var DEFAULT_CONFIG = {
    shop: {
      name: 'AL SHAJAR STATIONERY',
      welcome: 'Upload your files, choose your options and send the job to our print desk. We will review and print it.',
      pickupNote: 'Collect your prints from the counter and quote your job number.',
      deliveryNote: 'We will call you when your delivery is on the way.',
      footerNote: '© 2026 AL SHAJAR STATIONERY. All rights reserved.',
      address: 'United Arab Emirates',
      phone: '',
      whatsapp: '',
      email: ''
    },
    delivery: { fee: 10, freeThreshold: 50 },
    pricing: Pricing.DEFAULT_PRICING,
    limits: { maxFileMB: 50, maxJobMB: 120, maxPages: 500 },
    capabilities: { wordConversion: false, livePrinting: false }
  };

  var state = {
    config: DEFAULT_CONFIG,
    docs: [],
    settings: {
      paper: 'A4',
      color: 'bw',
      duplex: true,
      nup: 1,
      orientation: 'auto',
      copies: 1,
      pageRange: { mode: 'all', value: '' }
    },
    fulfillment: 'pickup',
    payment: 'cash',
    plan: null,
    quote: null,
    rangeError: '',
    submitting: false,
    currentJob: null,
    pollTimer: null,
    configured: false
  };

  var docSeq = 0;
  var preview = null;
  var drawTimer = null;

  var dom = {};

  function money(value) {
    return SPG.formatAED(value);
  }

  function cacheDom() {
    var ids = [
      'welcome-text', 'rate-list', 'footer-note', 'footer-address', 'live-pill', 'live-pill-text',
      'dropzone', 'file-input', 'browse-btn', 'sample-btn', 'file-list', 'file-alert',
      'orientation', 'copies-minus', 'copies-plus', 'copies-value',
      'range-all', 'range-custom', 'range-input-wrap', 'range-input', 'range-error',
      'customer-name', 'customer-phone', 'customer-address', 'customer-note',
      'error-name', 'error-phone', 'phone-req',
      'delivery-fields', 'fulfilment-note', 'delivery-badge', 'delivery-choice-desc',
      'preview-canvas', 'preview-empty', 'preview-loading', 'preview-prev', 'preview-next',
      'preview-side-label', 'preview-colour-pill', 'meta-pages', 'meta-sheets', 'meta-sides',
      'price-lines', 'price-total', 'vat-subtotal', 'vat-amount', 'vat-note',
      'submit-btn', 'submit-error', 'terms-contact', 'privacy-contact',
      'success-modal', 'success-id', 'success-status-pill', 'success-total', 'success-payment',
      'success-fulfilment', 'success-queue', 'success-message', 'success-track',
      'success-new-job', 'success-cancel', 'success-final-title', 'success-final-desc',
      'rate-bw', 'rate-color'
    ];
    ids.forEach(function (id) {
      dom[id] = document.getElementById(id);
    });
    dom.rateBadgeBw = document.getElementById('rate-bw');
    dom.rateBadgeColor = document.getElementById('rate-color');
  }

  /* ------------------------------ Config ----------------------------- */

  async function loadConfig() {
    var healthPromise = SPG.api('/api/health').then(function (health) {
      if (dom['live-pill-text']) dom['live-pill-text'].textContent = 'Print desk online';
      if (dom['live-pill']) {
        dom['live-pill'].classList.remove('is-off');
        dom['live-pill'].classList.add('is-on');
      }
      return health;
    }).catch(function () {
      if (dom['live-pill-text']) dom['live-pill-text'].textContent = 'Print desk offline';
      if (dom['live-pill']) {
        dom['live-pill'].classList.remove('is-on');
        dom['live-pill'].classList.add('is-off');
      }
      return null;
    });

    try {
      var data = await SPG.api('/api/config');
      state.config = data.config || DEFAULT_CONFIG;
      state.configured = true;
    } catch (err) {
      SPG.toast('Could not load the shop settings. Using standard rates — refresh if prices look wrong.', 'error');
      state.config = DEFAULT_CONFIG;
    }

    applyConfig();
    await healthPromise;
  }

  function shopContactText() {
    var shop = state.config.shop || {};
    var bits = [];
    if (shop.phone) bits.push('Phone ' + shop.phone);
    if (shop.whatsapp) bits.push('WhatsApp ' + shop.whatsapp);
    if (shop.email) bits.push(shop.email);
    if (shop.address) bits.push(shop.address);
    return bits.length ? bits.join(' · ') : 'Please speak to the counter team for any question.';
  }

  function applyConfig() {
    var cfg = state.config;
    var shop = cfg.shop || DEFAULT_CONFIG.shop;
    var delivery = cfg.delivery || DEFAULT_CONFIG.delivery;

    if (dom['welcome-text'] && shop.welcome) dom['welcome-text'].textContent = shop.welcome;
    if (dom['footer-note']) dom['footer-note'].textContent = shop.footerNote || '© 2026 AL SHAJAR STATIONERY. All rights reserved.';
    if (dom['footer-address']) dom['footer-address'].textContent = shop.address || 'United Arab Emirates';
    if (dom['terms-contact']) dom['terms-contact'].textContent = shopContactText();
    if (dom['privacy-contact']) dom['privacy-contact'].textContent = shopContactText();

    if (dom['delivery-badge']) dom['delivery-badge'].textContent = 'Free from ' + money(delivery.freeThreshold);
    if (dom['delivery-choice-desc']) {
      dom['delivery-choice-desc'].textContent = 'Adds ' + money(delivery.fee) + ' below ' + money(delivery.freeThreshold) +
        '. Delivery is free from ' + money(delivery.freeThreshold) + '.';
    }

    buildRateList();
    updateRateLabels();

    if (dom['file-alert']) {
      if (cfg.capabilities && cfg.capabilities.wordConversion === false) {
        dom['file-alert'].hidden = false;
        dom['file-alert'].innerHTML = '<div class="alert alert-info" style="margin-top:12px">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.2"/></svg>' +
          '<span>Word conversion is not available on the shop computer right now. Please save Word files as PDF before uploading.</span></div>';
      } else {
        dom['file-alert'].hidden = true;
        dom['file-alert'].innerHTML = '';
      }
    }
  }

  function buildRateList() {
    if (!dom['rate-list']) return;
    var pricing = Pricing.mergePricing((state.config.pricing || {}));
    var rows = [
      ['A4 / A5 · Black &amp; white', money(pricing.rates.A4.bwBlockPrice) + ' / ' + pricing.bwBlockPages + ' pages'],
      ['A4 / A5 · Colour', money(pricing.rates.A4.colorPagePrice) + ' / page'],
      ['A3 · Black &amp; white', money(pricing.rates.A3.bwPagePrice) + ' / page'],
      ['A3 · Colour', money(pricing.rates.A3.colorPagePrice) + ' / page']
    ];
    dom['rate-list'].innerHTML = rows.map(function (row) {
      return '<div class="rate-row"><span class="rate-name">' + row[0] + '</span><span class="rate-value">' + row[1] + '</span></div>';
    }).join('');
  }

  function updateRateLabels() {
    var pricing = Pricing.mergePricing((state.config.pricing || {}));
    var paper = state.settings.paper;
    var bw = paper === 'A3' ? pricing.rates.A3.bwPagePrice + '.00 / page' : pricing.rates[paper].bwBlockPrice.toFixed(2) + ' / ' + pricing.bwBlockPages + ' pg';
    var colour = pricing.rates[paper].colorPagePrice.toFixed(2) + ' / page';
    if (dom['rate-bw']) dom['rate-bw'].textContent = 'AED ' + bw;
    if (dom['rate-color']) dom['rate-color'].textContent = 'AED ' + colour;
  }

  /* ------------------------------ Preview ---------------------------- */

  function initPreview() {
    preview = new window.SPPreview.PreviewEngine({
      canvas: dom['preview-canvas'],
      emptyEl: dom['preview-empty'],
      loadingEl: dom['preview-loading'],
      onRendered: function (plan, sideIndex) {
        state.plan = plan;
        renderPreviewChrome(plan, sideIndex);
      }
    });
    preview.setSettings(state.settings);
    preview.setDocuments([]);
    preview.draw();

    dom['preview-prev'].addEventListener('click', function () {
      preview.prev();
    });
    dom['preview-next'].addEventListener('click', function () {
      preview.next();
    });

    var onResize = SPG.debounce(function () {
      if (preview) preview.draw();
    }, 180);
    window.addEventListener('resize', onResize);
  }

  function scheduleDraw() {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(function () {
      if (preview) preview.draw();
    }, 70);
  }

  function renderPreviewChrome(plan, sideIndex) {
    var sides = plan && plan.sides ? plan.sides.length : 0;
    var pages = plan && plan.pageCount ? plan.pageCount : 0;
    if (dom['meta-pages']) dom['meta-pages'].textContent = SPG.formatNumber(pages);
    if (dom['meta-sheets']) dom['meta-sheets'].textContent = SPG.formatNumber(plan && plan.sheets ? plan.sheets : 0);
    if (dom['meta-sides']) dom['meta-sides'].textContent = SPG.formatNumber(sides);

    if (dom['preview-prev']) dom['preview-prev'].disabled = !sides || sideIndex <= 0;
    if (dom['preview-next']) dom['preview-next'].disabled = !sides || sideIndex >= sides - 1;

    if (dom['preview-side-label']) {
      dom['preview-side-label'].textContent = sides
        ? Layout.sideLabel(sideIndex, plan)
        : 'No pages yet';
    }

    if (dom['preview-colour-pill']) {
      var label = (state.settings.color === 'color' ? 'Colour' : 'B&W') + ' · ' + state.settings.paper;
      if (state.settings.nup > 1) label += ' · ' + state.settings.nup + '-up';
      if (state.settings.duplex) label += ' · Duplex';
      dom['preview-colour-pill'].textContent = label;
    }
  }

  /* ------------------------------- Files ----------------------------- */

  function fileKind(name, type) {
    var lower = String(name || '').toLowerCase();
    var mime = String(type || '').toLowerCase();
    if (/\.pdf$/.test(lower) || mime === 'application/pdf') return 'pdf';
    if (/\.docx$/.test(lower) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
    if (/\.doc$/.test(lower) || mime === 'application/msword') return 'doc';
    if (/\.(jpe?g|png)$/.test(lower) || mime === 'image/jpeg' || mime === 'image/png') return 'image';
    return 'unsupported';
  }

  async function imageSize(bytes, mime) {
    var blob = new Blob([bytes], { type: mime });
    if (typeof createImageBitmap === 'function') {
      var bitmap = await createImageBitmap(blob);
      var size = { width: bitmap.width, height: bitmap.height };
      if (typeof bitmap.close === 'function') bitmap.close();
      return size;
    }
    var url = URL.createObjectURL(blob);
    try {
      return await new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () {
          resolve({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
        };
        image.onerror = function () { reject(new Error('This image could not be read.')); };
        image.src = url;
      });
    } finally {
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var room = MAX_FILES - state.docs.length;
    if (room <= 0) {
      SPG.toast('You can add up to ' + MAX_FILES + ' files to one job.', 'error');
      return;
    }
    if (files.length > room) {
      SPG.toast('Only the first ' + room + ' file' + (room === 1 ? '' : 's') + ' were added (maximum ' + MAX_FILES + ').', 'error');
      files = files.slice(0, room);
    }

    for (var i = 0; i < files.length; i += 1) {
      await addOne(files[i]);
    }

    if (state.docs.length === 1) preview.sideIndex = 0;
    preview.setDocuments(state.docs);
    preview.setSettings(state.settings);
    updateAll(true);
  }

  async function addOne(file) {
    var limits = state.config.limits || DEFAULT_CONFIG.limits;
    var kind = fileKind(file.name, file.type);
    var maxBytes = Math.max(1, Number(limits.maxFileMB) || 50) * 1024 * 1024;

    if (kind === 'unsupported') {
      SPG.toast(file.name + ': use PDF, Word (.docx), JPG or PNG.', 'error');
      return;
    }
    if (kind === 'doc') {
      SPG.toast(file.name + ': older .doc files are not supported. Save it as .docx or PDF first.', 'error');
      return;
    }
    if (file.size > maxBytes) {
      SPG.toast(file.name + ' is larger than the ' + limits.maxFileMB + ' MB per-file limit.', 'error');
      return;
    }
    var used = state.docs.reduce(function (sum, doc) { return sum + (doc.size || 0); }, 0);
    if (used + file.size > (Number(limits.maxJobMB) || 120) * 1024 * 1024) {
      SPG.toast('This job would be larger than the ' + limits.maxJobMB + ' MB total limit.', 'error');
      return;
    }

    var doc = {
      id: 'doc' + (++docSeq),
      name: file.name,
      originalName: file.name,
      kind: kind,
      mime: file.type || '',
      size: file.size,
      bytes: null,
      pageCount: 0,
      pages: [],
      pdf: null,
      status: 'loading',
      statusText: kind === 'docx' ? 'Converting Word to PDF…' : 'Reading file…',
      error: '',
      convertedFrom: ''
    };
    state.docs.push(doc);
    renderFileList();

    try {
      var bytes = await SPG.readFileBytes(file);

      if (kind === 'docx') {
        if (!(state.config.capabilities && state.config.capabilities.wordConversion)) {
          throw new Error('Word conversion is not available on the shop computer. Save the file as PDF and upload it again.');
        }
        doc.statusText = 'Converting Word to PDF on the shop computer…';
        renderFileList();
        var converted = await SPG.api('/api/convert', {
          method: 'POST',
          json: {
            name: file.name,
            mime: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            data: SPG.bytesToBase64(bytes)
          }
        });
        bytes = SPG.base64ToBytes(converted.data);
        doc.mime = 'application/pdf';
        doc.kind = 'pdf';
        doc.name = converted.name || file.name.replace(/\.docx$/i, '.pdf');
        doc.convertedFrom = file.name;
        kind = 'pdf';
      }

      if (kind === 'pdf') {
        doc.statusText = 'Reading PDF pages…';
        renderFileList();
        var pdf = await window.SPPreview.loadPdf(bytes);
        if (pdf.numPages > (Number(limits.maxPages) || 500)) {
          try { pdf.destroy(); } catch (err) { /* ignore */ }
          throw new Error('This PDF has more than the ' + limits.maxPages + '-page limit.');
        }
        var pages = [];
        for (var p = 1; p <= pdf.numPages; p += 1) {
          var page = await pdf.getPage(p);
          var rotation = ((page.rotate % 360) + 360) % 360;
          var viewport = page.getViewport({ scale: 1, rotation: rotation });
          pages.push({
            width: Math.round(viewport.width * 100) / 100,
            height: Math.round(viewport.height * 100) / 100
          });
          if (typeof page.cleanup === 'function') page.cleanup();
        }
        doc.pdf = pdf;
        doc.pageCount = pdf.numPages;
        doc.pages = pages;
      } else {
        var sizeInfo = await imageSize(bytes, doc.mime || 'image/jpeg');
        if (doc.mime !== 'image/png' && doc.mime !== 'image/jpeg') {
          doc.mime = /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
        }
        doc.pageCount = 1;
        doc.pages = [{ width: sizeInfo.width, height: sizeInfo.height }];
      }

      doc.bytes = bytes;
      doc.size = bytes.length;
      doc.status = 'ready';
      doc.statusText = '';
      renderFileList();

      if (doc.convertedFrom) {
        SPG.toast(file.name + ' was converted to PDF for an accurate preview.', 'ok');
      }
    } catch (err) {
      doc.status = 'error';
      doc.error = err && err.message ? err.message : 'This file could not be read.';
      doc.statusText = '';
      renderFileList();
      SPG.toast(doc.originalName + ': ' + doc.error, 'error');
    }
  }

  function renderFileList() {
    if (!dom['file-list']) return;
    var html = state.docs.map(function (doc) {
      var badgeClass = doc.kind === 'pdf' ? 'is-pdf' : (doc.kind === 'image' ? 'is-img' : 'is-doc');
      var badgeText = doc.kind === 'pdf' ? 'PDF' : (doc.kind === 'image' ? 'IMG' : 'DOC');
      var meta;

      if (doc.status === 'loading') {
        meta = '<span class="spinner is-dark" style="width:12px;height:12px;border-width:1.5px"></span>' + SPG.escapeHtml(doc.statusText || 'Reading file…');
      } else if (doc.status === 'error') {
        meta = '<span class="err">' + SPG.escapeHtml(doc.error) + '</span>';
      } else {
        var bits = [doc.pageCount + ' page' + (doc.pageCount === 1 ? '' : 's'), SPG.formatBytes(doc.size)];
        if (doc.convertedFrom) bits.unshift('Converted from ' + doc.convertedFrom);
        meta = SPG.escapeHtml(bits.join(' · '));
      }

      return '<div class="file-item' + (doc.status === 'loading' ? ' file-loading' : '') + '" data-doc-id="' + doc.id + '">' +
        '<span class="file-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '<div class="file-main"><div class="file-name" title="' + SPG.escapeHtml(doc.originalName) + '">' + SPG.escapeHtml(doc.originalName) + '</div>' +
        '<div class="file-meta">' + meta + '</div></div>' +
        '<button class="file-remove" type="button" data-remove-id="' + doc.id + '" aria-label="Remove ' + SPG.escapeHtml(doc.originalName) + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg>' +
        '</button></div>';
    }).join('');
    dom['file-list'].innerHTML = html;

    SPG.$$('[data-remove-id]', dom['file-list']).forEach(function (button) {
      button.addEventListener('click', function () {
        removeDoc(button.getAttribute('data-remove-id'));
      });
    });

    var errorCount = state.docs.filter(function (doc) { return doc.status === 'error'; }).length;
    if (dom['file-alert'] && !(state.config.capabilities && state.config.capabilities.wordConversion === false)) {
      if (errorCount) {
        dom['file-alert'].hidden = false;
        dom['file-alert'].innerHTML = '<div class="alert alert-danger" style="margin-top:12px">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3.5 21 20H3z"/><path d="M12 9v5"/><path d="M12 17v.01"/></svg>' +
          '<span>' + errorCount + ' file' + (errorCount === 1 ? '' : 's') + ' could not be used. Remove ' +
          (errorCount === 1 ? 'it' : 'them') + ' or upload a different file.</span></div>';
      } else {
        dom['file-alert'].hidden = true;
        dom['file-alert'].innerHTML = '';
      }
    }
  }

  function removeDoc(id) {
    var index = state.docs.findIndex(function (doc) { return doc.id === id; });
    if (index < 0) return;
    var doc = state.docs[index];
    if (doc.pdf) {
      try { doc.pdf.destroy(); } catch (err) { /* ignore */ }
    }
    state.docs.splice(index, 1);
    renderFileList();
    preview.setDocuments(state.docs);
    preview.clampSide();
    updateAll(true);
  }

  function clearDocs() {
    state.docs.forEach(function (doc) {
      if (doc.pdf) {
        try { doc.pdf.destroy(); } catch (err) { /* ignore */ }
      }
    });
    state.docs = [];
    docSeq = 0;
    renderFileList();
    if (preview) {
      preview.setDocuments([]);
      preview.sideIndex = 0;
    }
  }

  /* ---------------------------- Settings ----------------------------- */

  function wireSegmented() {
    SPG.$$('.segmented[data-setting]').forEach(function (group) {
      var setting = group.getAttribute('data-setting');
      group.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-value]');
        if (!button) return;
        var value = button.getAttribute('data-value');
        SPG.$$('button', group).forEach(function (b) {
          b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
        });
        if (setting === 'duplex') state.settings.duplex = value === 'true';
        else if (setting === 'nup') state.settings.nup = Number(value) || 1;
        else state.settings[setting] = value;

        updateRateLabels();
        preview.setSettings(state.settings);
        updateAll(true);
      });
    });

    dom['copies-minus'].addEventListener('click', function () {
      state.settings.copies = Math.max(1, state.settings.copies - 1);
      syncCopies();
    });
    dom['copies-plus'].addEventListener('click', function () {
      state.settings.copies = Math.min(MAX_COPIES, state.settings.copies + 1);
      syncCopies();
    });

    dom['orientation'].addEventListener('change', function () {
      state.settings.orientation = dom['orientation'].value;
      preview.setSettings(state.settings);
      updateAll(true);
    });

    dom['range-all'].addEventListener('click', function () { setRangeMode('all'); });
    dom['range-custom'].addEventListener('click', function () { setRangeMode('custom'); });

    var rangeHandler = SPG.debounce(function () {
      state.settings.pageRange.value = dom['range-input'].value;
      preview.clampSide();
      updateAll(true);
    }, 220);
    dom['range-input'].addEventListener('input', rangeHandler);

    SPG.$$('input[name="fulfillment"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.fulfillment = radio.value;
        applyFulfillment();
        updateAll(true);
      });
    });

    SPG.$$('input[name="payment"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.payment = radio.value;
      });
    });
  }

  function syncCopies() {
    dom['copies-value'].textContent = state.settings.copies;
    dom['copies-minus'].disabled = state.settings.copies <= 1;
    dom['copies-plus'].disabled = state.settings.copies >= MAX_COPIES;
    preview.setSettings(state.settings);
    updateAll(true);
  }

  function setRangeMode(mode) {
    state.settings.pageRange.mode = mode;
    dom['range-all'].setAttribute('aria-pressed', mode === 'all' ? 'true' : 'false');
    dom['range-custom'].setAttribute('aria-pressed', mode === 'custom' ? 'true' : 'false');
    dom['range-input-wrap'].hidden = mode !== 'custom';
    if (mode === 'all') {
      dom['range-input'].classList.remove('is-invalid');
      dom['range-error'].textContent = '';
    } else {
      setTimeout(function () {
        try { dom['range-input'].focus(); } catch (err) { /* ignore */ }
      }, 40);
    }
    preview.clampSide();
    updateAll(true);
  }

  function applyFulfillment() {
    var isDelivery = state.fulfillment === 'delivery';
    dom['delivery-fields'].hidden = !isDelivery;
    dom['phone-req'].hidden = !isDelivery;
    dom['fulfilment-note'].textContent = isDelivery
      ? (state.config.shop.deliveryNote || 'We will call you when your delivery is on the way.')
      : (state.config.shop.pickupNote || 'Collect your prints from the counter and quote your job number.');
    if (isDelivery) {
      dom['customer-phone'].classList.remove('is-invalid');
    }
  }

  /* --------------------------- Computation --------------------------- */

  function updateAll(redraw) {
    if (!preview) return;
    preview.setSettings(state.settings);

    var plan = preview.plan();
    state.plan = plan;

    var rangeError = '';
    if (plan.error) {
      rangeError = plan.error;
    }
    state.rangeError = rangeError;

    if (dom['range-error']) {
      dom['range-error'].textContent = rangeError;
      dom['range-input'].classList.toggle('is-invalid', !!rangeError);
    }

    var pageCount = plan && plan.pageCount ? plan.pageCount : 0;
    var fulfillment = (pageCount > 0) ? state.fulfillment : 'pickup';
    var quote = Pricing.calculate({
      pageCount: pageCount,
      copies: state.settings.copies,
      size: state.settings.paper,
      color: state.settings.color === 'color',
      fulfillment: fulfillment,
      pricing: state.config.pricing,
      delivery: state.config.delivery
    });
    state.quote = quote;

    renderPrice(quote);
    renderPreviewChrome(plan, preview.sideIndex);
    updateSubmitLabel();
    updateSubmitState();

    if (redraw) scheduleDraw();
  }

  function renderPrice(quote) {
    if (!dom['price-lines']) return;
    var rows = [];

    var printLine = (quote.lines || []).filter(function (line) { return line.key === 'printing'; })[0];
    rows.push({
      label: printLine ? printLine.label : 'Printing',
      detail: printLine && printLine.detail ? printLine.detail : 'No pages selected',
      amount: quote.printTotal,
      free: false
    });

    if (state.fulfillment === 'delivery' && quote.pageCount > 0) {
      var free = quote.freeDelivery;
      var detail = free
        ? 'Free — order is ' + money(quote.freeDeliveryThreshold) + ' or more'
        : 'Order is under ' + money(quote.freeDeliveryThreshold) +
          (quote.freeDeliveryRemaining > 0 ? ' · add ' + money(quote.freeDeliveryRemaining) + ' for free delivery' : '');
      rows.push({
        label: 'Home delivery',
        detail: detail,
        amount: quote.deliveryFee,
        free: free
      });
    }

    dom['price-lines'].innerHTML = rows.map(function (row) {
      return '<div class="price-line' + (row.free ? ' is-free' : '') + '">' +
        '<span class="pl-label">' + SPG.escapeHtml(row.label) +
        '<span class="pl-detail">' + SPG.escapeHtml(row.detail) + '</span></span>' +
        '<span class="pl-amount">' + (row.free ? 'Free' : money(row.amount)) + '</span></div>';
    }).join('');

    if (dom['price-total']) dom['price-total'].textContent = money(quote.total);
    if (dom['vat-subtotal']) dom['vat-subtotal'].textContent = money(quote.subtotalExVat);
    if (dom['vat-amount']) dom['vat-amount'].textContent = money(quote.vat);
    if (dom['vat-note']) {
      dom['vat-note'].textContent = quote.total > 0
        ? 'VAT is included in the total above and shown for transparency only.'
        : 'Add a file to see the VAT breakdown. VAT is always included in the price.';
    }
  }

  function updateSubmitLabel() {
    if (!dom['submit-btn'] || state.submitting) return;
    var total = state.quote ? state.quote.total : 0;
    var label = total > 0 ? 'Send job · ' + money(total) : 'Send job to print desk';
    dom['submit-btn'].innerHTML = '<svg aria-hidden="true"><use href="#i-send"></use></svg>' +
      '<span>' + SPG.escapeHtml(label) + '</span>';
    dom['submit-btn'].setAttribute('aria-label', label);
  }

  function updateSubmitState() {
    if (!dom['submit-btn']) return;
    var hasReady = state.docs.some(function (doc) { return doc.status === 'ready' && doc.pageCount > 0; });
    var hasLoading = state.docs.some(function (doc) { return doc.status === 'loading'; });
    if (!state.submitting) dom['submit-btn'].disabled = hasLoading && !hasReady;
  }

  function setSubmitError(message) {
    if (dom['submit-error']) dom['submit-error'].textContent = message || '';
  }

  function setFieldError(fieldId, errorId, message) {
    var field = dom[fieldId];
    var error = dom[errorId];
    if (field) field.classList.toggle('is-invalid', !!message);
    if (error) error.textContent = message || '';
  }

  /* ----------------------------- Submit ------------------------------ */

  async function submitJob() {
    if (state.submitting) return;
    setSubmitError('');

    var name = dom['customer-name'].value.trim();
    var phone = dom['customer-phone'].value.trim();
    var address = dom['customer-address'].value.trim();
    var note = dom['customer-note'].value.trim();
    var isDelivery = state.fulfillment === 'delivery';
    var valid = true;

    setFieldError('customer-name', 'error-name', '');
    setFieldError('customer-phone', 'error-phone', '');

    if (!name) {
      setFieldError('customer-name', 'error-name', 'Please enter your name.');
      valid = false;
    }
    if (isDelivery && !phone) {
      setFieldError('customer-phone', 'error-phone', 'A phone number is required for delivery.');
      valid = false;
    } else if (phone && !/^[+0-9()\-\s]{5,30}$/.test(phone)) {
      setFieldError('customer-phone', 'error-phone', 'Please enter a valid phone number.');
      valid = false;
    }
    if (isDelivery && !address) {
      valid = false;
      SPG.toast('Please enter the delivery address.', 'error');
    }

    var readyDocs = state.docs.filter(function (doc) { return doc.status === 'ready' && doc.pageCount > 0; });
    if (!readyDocs.length) {
      setSubmitError('Add at least one file before sending the job.');
      valid = false;
    }
    if (state.rangeError) {
      setSubmitError('Check the page range: ' + state.rangeError);
      if (dom['range-input']) dom['range-input'].focus();
      valid = false;
    }
    if (state.docs.some(function (doc) { return doc.status === 'loading'; })) {
      setSubmitError('Please wait — a file is still being prepared.');
      valid = false;
    }

    if (!valid) {
      if (!name) dom['customer-name'].focus();
      else if (isDelivery && !phone) dom['customer-phone'].focus();
      else if (isDelivery && !address) dom['customer-address'].focus();
      return;
    }

    var payload = {
      customer: { name: name, phone: phone, address: isDelivery ? address : '', note: note },
      fulfillment: state.fulfillment,
      payment: state.payment,
      settings: state.settings,
      documents: readyDocs.map(function (doc) {
        return {
          name: doc.name,
          mime: doc.mime || 'application/pdf',
          data: SPG.bytesToBase64(doc.bytes)
        };
      })
    };

    state.submitting = true;
    dom['submit-btn'].disabled = true;
    SPG.setBusy(dom['submit-btn'], true, 'Sending your job…');

    try {
      var result = await SPG.api('/api/jobs', { method: 'POST', json: payload });
      var job = result.job;
      state.currentJob = { id: job.id, token: job.token };

      showSuccess(job);
      startPolling();
      SPG.toast('Job ' + job.id + ' sent to the print desk.', 'ok', 5000);
    } catch (err) {
      var message = err.message || 'The job could not be sent.';
      if (err.status === 429 && err.retryAfter) {
        message = 'Too many jobs from this device. Please wait ' + err.retryAfter + ' seconds and try again.';
      }
      if (err.status === 413) {
        message = err.message + ' Try fewer files or a smaller job.';
      }
      setSubmitError(message);
      SPG.toast(message, 'error', 7000);
    } finally {
      state.submitting = false;
      SPG.setBusy(dom['submit-btn'], false);
      updateSubmitLabel();
      updateSubmitState();
    }
  }

  /* --------------------------- Success flow -------------------------- */

  function showSuccess(job) {
    if (dom['success-id']) dom['success-id'].textContent = job.id;
    if (dom['success-total']) dom['success-total'].textContent = money(job.total);
    if (dom['success-payment']) {
      dom['success-payment'].textContent = job.payment === 'card' ? 'Card at counter / delivery' : 'Cash at counter / delivery';
    }
    if (dom['success-fulfilment']) {
      dom['success-fulfilment'].textContent = job.fulfillment === 'delivery' ? 'Home delivery' : 'Store pickup';
    }
    applyStatus({
      status: job.status || 'pending',
      total: job.total,
      pageCount: job.pageCount,
      copies: job.copies,
      fulfillment: job.fulfillment,
      payment: job.payment,
      queuePosition: job.queuePosition || 1,
      canCancel: true,
      message: 'We received your job. Our team will check it shortly.'
    });
    if (dom['success-modal']) SPG.openModal(dom['success-modal']);
  }

  function applyStatus(job) {
    if (!job) return;
    var status = job.status || 'pending';
    var pill = dom['success-status-pill'];
    if (pill) {
      pill.textContent = SPG.statusLabel(status);
      pill.className = 'pill ' + (status === 'completed' ? 'pill-green' : (status === 'pending' || status === 'printing' ? 'pill-gold' : ''));
    }

    if (dom['success-queue']) {
      dom['success-queue'].textContent = (status === 'pending' && job.queuePosition) ? String(job.queuePosition) : '—';
    }

    var messageNode = dom['success-message'];
    if (messageNode) {
      var span = messageNode.querySelector('span');
      var text = job.message || '';
      if (status === 'completed' && job.note) text = text + ' ' + job.note;
      if (span) span.textContent = text || 'Status updated.';
    }

    var steps = dom['success-track'] ? Array.prototype.slice.call(dom['success-track'].querySelectorAll('.track-step')) : [];
    function resetSteps() {
      steps.forEach(function (step) { step.classList.remove('is-done', 'is-current'); });
    }
    resetSteps();

    var finalTitle = dom['success-final-title'];
    var finalDesc = dom['success-final-desc'];
    if (finalTitle) finalTitle.textContent = job.fulfillment === 'delivery' ? 'Out for delivery' : 'Ready for pickup';
    if (finalDesc) {
      finalDesc.textContent = job.fulfillment === 'delivery'
        ? 'We will call you when the delivery is on the way.'
        : 'Collect at the counter and quote your job number.';
    }

    if (steps.length === 3) {
      if (status === 'pending') {
        steps[0].classList.add('is-current');
      } else if (status === 'printing') {
        steps[0].classList.add('is-done');
        steps[1].classList.add('is-current');
      } else if (status === 'completed') {
        steps.forEach(function (step) { step.classList.add('is-done'); });
      } else {
        steps[0].classList.add('is-done');
        steps[2].classList.add('is-current');
        if (finalTitle) {
          finalTitle.textContent = status === 'cancelled' ? 'Cancelled'
            : (status === 'rejected' ? 'Not printed' : 'Print needs attention');
        }
        if (finalDesc) {
          finalDesc.textContent = job.message || status === 'rejected'
            ? (job.message || 'Please speak to the counter.')
            : 'Please speak to the counter team.';
        }
      }
    }

    if (dom['success-cancel']) dom['success-cancel'].hidden = !job.canCancel;

    if (TERMINAL.indexOf(status) >= 0) stopPolling();
  }

  function startPolling() {
    stopPolling();
    if (!state.currentJob) return;
    var job = state.currentJob;

    async function tick() {
      if (!state.currentJob || state.currentJob.id !== job.id) return;
      try {
        var data = await SPG.api('/api/jobs/' + encodeURIComponent(job.id) + '/status?token=' + encodeURIComponent(job.token));
        if (!state.currentJob || state.currentJob.id !== job.id) return;
        applyStatus(data.job);
      } catch (err) {
        if (err.status === 404 || err.status === 401 || err.status === 403) {
          stopPolling();
          var messageNode = dom['success-message'];
          if (messageNode) {
            var span = messageNode.querySelector('span');
            if (span) span.textContent = 'This job link has expired. Please speak to the counter with your job number.';
          }
        }
      }
    }

    tick();
    state.pollTimer = setInterval(tick, 6000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function cancelCurrentJob() {
    if (!state.currentJob) return;
    if (!window.confirm('Cancel this job? You will need to send it again if you change your mind.')) return;
    var button = dom['success-cancel'];
    if (button) button.disabled = true;
    try {
      var data = await SPG.api('/api/jobs/' + encodeURIComponent(state.currentJob.id) + '/cancel?token=' +
        encodeURIComponent(state.currentJob.token), { method: 'POST', json: {} });
      applyStatus(data.job);
      SPG.toast('Job cancelled.', 'ok');
    } catch (err) {
      SPG.toast(err.message || 'The job could not be cancelled.', 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function resetForNewJob() {
    SPG.closeModal(dom['success-modal']);
    stopPolling();
    state.currentJob = null;
    clearDocs();

    state.settings = {
      paper: 'A4',
      color: 'bw',
      duplex: true,
      nup: 1,
      orientation: 'auto',
      copies: 1,
      pageRange: { mode: 'all', value: '' }
    };
    state.fulfillment = 'pickup';
    state.payment = 'cash';

    SPG.$$('.segmented[data-setting]').forEach(function (group) {
      var setting = group.getAttribute('data-setting');
      SPG.$$('button[data-value]', group).forEach(function (button) {
        var value = button.getAttribute('data-value');
        var active;
        if (setting === 'duplex') active = (state.settings.duplex === (value === 'true'));
        else if (setting === 'nup') active = (state.settings.nup === Number(value));
        else active = (state.settings[setting] === value);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });

    dom['orientation'].value = 'auto';
    dom['copies-value'].textContent = '1';
    dom['copies-minus'].disabled = true;
    dom['copies-plus'].disabled = false;
    dom['range-all'].setAttribute('aria-pressed', 'true');
    dom['range-custom'].setAttribute('aria-pressed', 'false');
    dom['range-input-wrap'].hidden = true;
    dom['range-input'].value = '';
    dom['range-error'].textContent = '';
    dom['range-input'].classList.remove('is-invalid');

    SPG.$$('input[name="fulfillment"]').forEach(function (radio) { radio.checked = radio.value === 'pickup'; });
    SPG.$$('input[name="payment"]').forEach(function (radio) { radio.checked = radio.value === 'cash'; });

    dom['customer-address'].value = '';
    dom['customer-note'].value = '';
    setFieldError('customer-name', 'error-name', '');
    setFieldError('customer-phone', 'error-phone', '');
    setSubmitError('');
    applyFulfillment();

    preview.setDocuments([]);
    preview.settings = state.settings;
    updateAll(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------ Wiring ----------------------------- */

  function wireFiles() {
    var openPicker = function (event) {
      if (event && event.target && event.target.closest && event.target.closest('#sample-btn')) return;
      dom['file-input'].click();
    };

    dom['dropzone'].addEventListener('click', openPicker);
    dom['dropzone'].addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        dom['file-input'].click();
      }
    });

    dom['file-input'].addEventListener('change', function () {
      var files = dom['file-input'].files;
      addFiles(files);
      dom['file-input'].value = '';
    });

    ['dragenter', 'dragover'].forEach(function (name) {
      dom['dropzone'].addEventListener(name, function (event) {
        event.preventDefault();
        event.stopPropagation();
        dom['dropzone'].classList.add('is-drag');
      });
    });
    ['dragleave', 'dragend'].forEach(function (name) {
      dom['dropzone'].addEventListener(name, function (event) {
        event.preventDefault();
        if (event.target === dom['dropzone'] || !dom['dropzone'].contains(event.relatedTarget)) {
          dom['dropzone'].classList.remove('is-drag');
        }
      });
    });
    dom['dropzone'].addEventListener('drop', function (event) {
      event.preventDefault();
      event.stopPropagation();
      dom['dropzone'].classList.remove('is-drag');
      if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files);
    });

    dom['sample-btn'].addEventListener('click', async function (event) {
      event.stopPropagation();
      event.preventDefault();
      var button = dom['sample-btn'];
      SPG.setBusy(button, true, 'Loading…');
      try {
        var bytes = await SPG.fetchBytes('/api/sample.pdf');
        var file = new File([bytes], 'al-shajar-sample.pdf', { type: 'application/pdf' });
        await addFiles([file]);
      } catch (err) {
        SPG.toast(err.message || 'The sample file could not be loaded.', 'error');
      } finally {
        SPG.setBusy(button, false);
      }
    });

    dom['submit-btn'].addEventListener('click', submitJob);
    dom['success-new-job'].addEventListener('click', resetForNewJob);
    dom['success-cancel'].addEventListener('click', cancelCurrentJob);

    window.addEventListener('beforeunload', function (event) {
      if (state.submitting) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  function initAssistant() {
    if (!window.PrintAssistant) return;
    window.PrintAssistant.init({
      getContext: function () {
        return {
          config: state.config,
          quote: state.quote,
          settings: state.settings,
          docs: state.docs,
          fulfillment: state.fulfillment
        };
      }
    });
  }

  async function init() {
    cacheDom();
    initPreview();
    wireSegmented();
    wireFiles();
    syncCopies();
    applyFulfillment();
    initAssistant();
    await loadConfig();
    updateAll(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
