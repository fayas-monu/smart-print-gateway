/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Live HTML5 canvas preview of the exact imposed sheet layout.
 * Uses the same shared layout geometry as the server. (AL SHAJAR TEAM)
 */
(function (global) {
  'use strict';

  var PDFJS = global.pdfjsLib;
  if (PDFJS && PDFJS.GlobalWorkerOptions && !PDFJS.GlobalWorkerOptions.workerSrc) {
    PDFJS.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.js';
  }

  var MAX_PAGE_CACHE = 36;

  function PreviewEngine(options) {
    var opts = options || {};
    this.canvas = opts.canvas;
    this.emptyEl = opts.emptyEl || null;
    this.loadingEl = opts.loadingEl || null;
    this.onRendered = typeof opts.onRendered === 'function' ? opts.onRendered : null;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.docs = [];
    this.settings = {};
    this.sideIndex = 0;
    this.pageCache = new Map();
    this.imageCache = new Map();
    this.objectUrls = new Map();
    this.renderToken = 0;
    this.drawing = false;
  }

  PreviewEngine.prototype.hasPages = function () {
    return this.docs.some(function (doc) {
      return doc && doc.pageCount > 0 && doc.status !== 'error';
    });
  };

  PreviewEngine.prototype.plan = function () {
    var Layout = global.PrintLayout;
    var meta = this.docs.map(function (doc) {
      return {
        pageCount: doc.pageCount || 0,
        pages: doc.pages || [],
        kind: doc.kind || 'pdf'
      };
    });
    var pageList;
    try {
      pageList = Layout.resolvePageList(meta, this.settings.pageRange || { mode: 'all' });
    } catch (err) {
      return {
        error: err.message || 'Check the page range.',
        pageList: [],
        pageCount: 0,
        nup: Layout.normalizeNup(this.settings.nup),
        duplex: !!this.settings.duplex,
        sides: [],
        rawSides: 0,
        sheets: 0,
        outputSides: 0
      };
    }
    return Layout.planOutput({ documents: meta, pageList: pageList, settings: this.settings });
  };

  PreviewEngine.prototype.setDocuments = function (docs) {
    this.docs = Array.isArray(docs) ? docs : [];
    var liveIds = new Set(this.docs.map(function (doc) { return doc.id; }));
    var self = this;
    Array.from(this.pageCache.keys()).forEach(function (key) {
      var docId = key.split(':')[0];
      if (!liveIds.has(docId)) self.pageCache.delete(key);
    });
    Array.from(this.imageCache.keys()).forEach(function (docId) {
      if (!liveIds.has(docId)) self.imageCache.delete(docId);
    });
    Array.from(this.objectUrls.keys()).forEach(function (docId) {
      if (!liveIds.has(docId)) {
        try { URL.revokeObjectURL(self.objectUrls.get(docId)); } catch (err) { /* ignore */ }
        self.objectUrls.delete(docId);
      }
    });
    this.clampSide();
  };

  PreviewEngine.prototype.setSettings = function (settings) {
    this.settings = settings || {};
    this.clampSide();
  };

  PreviewEngine.prototype.clampSide = function () {
    var plan = this.plan();
    var total = plan.sides ? plan.sides.length : 0;
    if (!total) {
      this.sideIndex = 0;
      return;
    }
    if (this.sideIndex > total - 1) this.sideIndex = total - 1;
    if (this.sideIndex < 0) this.sideIndex = 0;
  };

  PreviewEngine.prototype.sideCount = function () {
    var plan = this.plan();
    return plan.sides ? plan.sides.length : 0;
  };

  PreviewEngine.prototype.goToSide = function (index) {
    var count = this.sideCount();
    if (!count) return this.draw();
    var next = Math.max(0, Math.min(count - 1, Number(index) || 0));
    if (next === this.sideIndex) {
      var plan = this.plan();
      if (this.onRendered) this.onRendered(plan, this.sideIndex);
      return Promise.resolve();
    }
    this.sideIndex = next;
    return this.draw();
  };

  PreviewEngine.prototype.next = function () {
    return this.goToSide(this.sideIndex + 1);
  };

  PreviewEngine.prototype.prev = function () {
    return this.goToSide(this.sideIndex - 1);
  };

  PreviewEngine.prototype.showEmpty = function (message) {
    if (this.emptyEl) {
      this.emptyEl.hidden = false;
      var span = this.emptyEl.querySelector('span');
      if (span && message) span.textContent = message;
    }
    if (this.canvas) this.canvas.style.visibility = 'hidden';
    if (this.onRendered) this.onRendered({ sides: [], pageCount: 0, empty: true, message: message }, 0);
  };

  PreviewEngine.prototype.renderPageCanvas = async function (doc, pageIndex, targetWidth) {
    var bucket = Math.max(180, Math.round(targetWidth / 80) * 80);
    var key = doc.id + ':' + pageIndex + ':' + bucket;
    if (this.pageCache.has(key)) {
      var cached = this.pageCache.get(key);
      this.pageCache.delete(key);
      this.pageCache.set(key, cached);
      return cached;
    }

    var canvas = document.createElement('canvas');
    if (doc.kind === 'image') {
      var bitmap = await this.getImage(doc);
      var naturalW = bitmap.width || (doc.pages[pageIndex] && doc.pages[pageIndex].width) || 1000;
      var naturalH = bitmap.height || (doc.pages[pageIndex] && doc.pages[pageIndex].height) || 1414;
      var scale = bucket / naturalW;
      canvas.width = Math.max(1, Math.round(naturalW * scale));
      canvas.height = Math.max(1, Math.round(naturalH * scale));
      var ictx = canvas.getContext('2d');
      ictx.fillStyle = '#ffffff';
      ictx.fillRect(0, 0, canvas.width, canvas.height);
      ictx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      this.rememberPage(key, canvas);
      return canvas;
    }

    if (!doc.pdf) throw new Error('This PDF is still loading.');
    var page = await doc.pdf.getPage(pageIndex + 1);
    var rotation = ((page.rotate % 360) + 360) % 360;
    var base = page.getViewport({ scale: 1, rotation: rotation });
    var scale = bucket / base.width;
    var viewport = page.getViewport({ scale: scale, rotation: rotation });
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    this.rememberPage(key, canvas);
    return canvas;
  };

  PreviewEngine.prototype.rememberPage = function (key, canvas) {
    this.pageCache.set(key, canvas);
    if (this.pageCache.size > MAX_PAGE_CACHE) {
      var oldest = this.pageCache.keys().next().value;
      this.pageCache.delete(oldest);
    }
  };

  PreviewEngine.prototype.getImage = async function (doc) {
    if (this.imageCache.has(doc.id)) return this.imageCache.get(doc.id);
    var blob = new Blob([doc.bytes], { type: doc.mime || 'image/jpeg' });
    var promise;
    if (typeof global.createImageBitmap === 'function') {
      promise = global.createImageBitmap(blob);
    } else {
      var url = URL.createObjectURL(blob);
      this.objectUrls.set(doc.id, url);
      promise = new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () { resolve(image); };
        image.onerror = function () { reject(new Error('This image could not be previewed.')); };
        image.src = url;
      });
    }
    var value = await promise;
    this.imageCache.set(doc.id, value);
    return value;
  };

  PreviewEngine.prototype.sheetForSide = function (plan, sideIndex) {
    var Layout = global.PrintLayout;
    var sheet = null;
    for (var i = 0; i <= sideIndex; i += 1) {
      var side = plan.sides[i] || [];
      var first = side[0] || null;
      sheet = first
        ? Layout.sheetSizeFor(this.settings.paper, this.settings.orientation, plan.nup, first)
        : (sheet || Layout.sheetSizeFor(this.settings.paper, this.settings.orientation, plan.nup, null));
    }
    return sheet || Layout.sheetSizeFor(this.settings.paper, this.settings.orientation, plan.nup, null);
  };

  PreviewEngine.prototype.setLoading = function (loading) {
    if (!this.loadingEl) return;
    this.loadingEl.hidden = !loading;
  };

  PreviewEngine.prototype.draw = async function () {
    if (!this.canvas || !this.ctx) return;
    var Layout = global.PrintLayout;
    var plan = this.plan();

    if (!this.hasPages()) {
      this.showEmpty('Add a file to see the exact sheet layout here.');
      if (this.onRendered) this.onRendered(plan, 0);
      return;
    }

    if (plan.error) {
      this.showEmpty(plan.error);
      if (this.onRendered) this.onRendered(plan, 0);
      return;
    }

    if (!plan.sides.length) {
      this.showEmpty('No pages selected. Check your page range.');
      if (this.onRendered) this.onRendered(plan, 0);
      return;
    }

    this.clampSide();
    if (this.emptyEl) this.emptyEl.hidden = true;
    this.canvas.style.visibility = 'visible';
    if (this.loadingEl) this.loadingEl.hidden = false;

    var token = ++this.renderToken;
    var sideIndex = this.sideIndex;
    var sheet = this.sheetForSide(plan, sideIndex);
    var hostWidth = 0;
    if (this.canvas.parentElement) hostWidth = this.canvas.parentElement.clientWidth;
    if (!hostWidth) hostWidth = 320;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var outW = Math.max(240, Math.round(hostWidth * dpr));
    var outH = Math.round(outW * (sheet.height / sheet.width));
    this.canvas.width = outW;
    this.canvas.height = outH;

    var ctx = this.ctx;
    var sf = outW / sheet.width;

    ctx.clearRect(0, 0, outW, outH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);

    var layout = Layout.cellsFor(sheet.width, sheet.height, plan.nup);
    var side = plan.sides[sideIndex] || [];

    if (!side.length) {
      ctx.fillStyle = '#9aa8a0';
      ctx.font = '500 ' + Math.max(11, Math.round(outW * 0.038)) + 'px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Blank back — no page on this side', outW / 2, outH / 2);
    }

    try {
      for (var slot = 0; slot < side.length; slot += 1) {
        var item = side[slot];
        var cell = layout.cells[slot];
        if (!item || !cell) continue;
        var doc = this.docs[item.docIndex];
        if (!doc) continue;
        var pageMeta = (doc.pages && doc.pages[item.pageIndex]) || { width: 595.28, height: 841.89 };
        var scaledCell = {
          x: cell.x * sf,
          y: cell.y * sf,
          w: cell.w * sf,
          h: cell.h * sf
        };
        var content = await this.renderPageCanvas(doc, item.pageIndex, scaledCell.w * 1.3);
        if (token !== this.renderToken) return;

        var placement = Layout.placementFor(pageMeta.width, pageMeta.height, scaledCell);
        ctx.save();
        ctx.translate(placement.cx, placement.cy);
        if (placement.rotate) ctx.rotate(Math.PI / 2);
        var drawW = pageMeta.width * placement.scale;
        var drawH = pageMeta.height * placement.scale;
        ctx.drawImage(content, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();

        if (plan.nup > 1 || plan.sides.length > 1) {
          ctx.strokeStyle = 'rgba(17, 51, 38, 0.16)';
          ctx.lineWidth = Math.max(1, dpr * 0.75);
          ctx.strokeRect(
            scaledCell.x + 0.5,
            scaledCell.y + 0.5,
            Math.max(0, scaledCell.w - 1),
            Math.max(0, scaledCell.h - 1)
          );
        }

        if (plan.nup > 1) {
          var label = String(item.number);
          ctx.font = '600 ' + Math.max(9, Math.round(outW * 0.022)) + 'px Inter, sans-serif';
          var pad = Math.max(3, Math.round(outW * 0.008));
          var labelW = Math.max(ctx.measureText(label).width + pad * 3, outW * 0.06);
          var labelH = Math.max(14, Math.round(outW * 0.034));
          ctx.fillStyle = 'rgba(11, 31, 23, 0.72)';
          roundRect(ctx, scaledCell.x + pad * 2, scaledCell.y + pad * 2, labelW, labelH, labelH / 2);
          ctx.fill();
          ctx.fillStyle = '#f7f3ea';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, scaledCell.x + pad * 2 + labelW / 2, scaledCell.y + pad * 2 + labelH / 2 + 0.5);
        }
      }
    } catch (err) {
      if (token !== this.renderToken) return;
      if (this.loadingEl) this.loadingEl.hidden = true;
      this.showEmpty(err.message || 'The preview could not be drawn.');
      return;
    }

    if (token !== this.renderToken) return;
    if (this.loadingEl) this.loadingEl.hidden = true;
    if (this.onRendered) this.onRendered(plan, sideIndex);
  };

  function roundRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  global.SPPreview = {
    PreviewEngine: PreviewEngine,
    loadPdf: async function (bytes) {
      if (!PDFJS) throw new Error('The PDF preview library did not load. Refresh the page.');
      // PDF.js may consume (detach) the buffer we hand it, so always pass a copy.
      var data = bytes;
      if (data && typeof data === 'object' && typeof data.slice === 'function') {
        try { data = data.slice(); } catch (err) { /* fall through */ }
      }
      var task = PDFJS.getDocument({ data: data, isEvalSupported: false });
      return task.promise;
    }
  };
})(window);
