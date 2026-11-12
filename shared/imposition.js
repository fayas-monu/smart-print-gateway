/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Print-ready imposition builder using pdf-lib. (AL SHAJAR TEAM)
 *
 * Vector PDF pages are embedded (not rasterised), so N-up, duplex and
 * orientation changes keep full print quality. Runs in the Node server and
 * can also run in a browser that loads pdf-lib and layout.js first.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/pdf-lib.min.js'), require('./layout.js'));
  } else {
    root.PrintImposition = factory(root.PDFLib, root.PrintLayout);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PDFLib, Layout) {
  'use strict';

  if (!PDFLib || !PDFLib.PDFDocument) throw new Error('pdf-lib is required for print-ready generation');
  if (!Layout) throw new Error('layout.js is required for print-ready generation');

  const PDFDocument = PDFLib.PDFDocument;
  const degrees = PDFLib.degrees;

  function originFor(cx, cy, width, height, rotation) {
    const r = Layout.normalizeRotation(rotation);
    if (r === 90) return { x: cx + height / 2, y: cy - width / 2 };
    if (r === 180) return { x: cx + width / 2, y: cy + height / 2 };
    if (r === 270) return { x: cx - height / 2, y: cy + width / 2 };
    return { x: cx - width / 2, y: cy - height / 2 };
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('Invalid document data');
  }

  async function loadPdf(bytes) {
    try {
      return await PDFDocument.load(toBytes(bytes), { updateMetadata: false });
    } catch (err) {
      const message = String(err && err.message || err);
      if (/encrypt/i.test(message)) {
        throw new Error('A PDF in this job is password-protected. Please unlock it and upload again.');
      }
      throw new Error('A PDF in this job could not be opened. Please re-export it as a standard PDF.');
    }
  }

  async function imageInfo(outDoc, doc, cache) {
    if (cache.has(doc)) return cache.get(doc);
    const bytes = toBytes(doc.bytes);
    let embedded;
    const mime = String(doc.mime || '').toLowerCase();
    if (mime === 'image/png') {
      try { embedded = await outDoc.embedPng(bytes); }
      catch (e) { embedded = await outDoc.embedJpg(bytes); }
    } else {
      try { embedded = await outDoc.embedJpg(bytes); }
      catch (e) { embedded = await outDoc.embedPng(bytes); }
    }
    const info = { image: embedded, width: embedded.width, height: embedded.height };
    cache.set(doc, info);
    return info;
  }

  /**
   * @param {Object} input
   * @param {Array} input.documents [{ kind:'pdf'|'image', bytes, mime, name }]
   * @param {Array} input.pageList  Layout pageList entries
   * @param {Object} input.settings { paper, orientation, nup, duplex, copies }
   * @param {string} input.title
   * @returns {Promise<Uint8Array>}
   */
  async function buildPrintReady(input) {
    const opts = input || {};
    const documents = Array.isArray(opts.documents) ? opts.documents : [];
    const pageList = Array.isArray(opts.pageList) ? opts.pageList : [];
    const settings = opts.settings || {};
    const nup = Layout.normalizeNup(settings.nup);
    const duplex = !!settings.duplex;

    if (!pageList.length) throw new Error('No pages were selected for printing.');
    if (!documents.length) throw new Error('No documents were supplied.');

    const outDoc = await PDFDocument.create();
    outDoc.setTitle(String(opts.title || 'AL SHAJAR STATIONERY print job').slice(0, 120));
    outDoc.setCreator('AL SHAJAR STATIONERY — Smart Print Gateway');
    outDoc.setProducer('AL SHAJAR STATIONERY — Smart Print Gateway');
    outDoc.setCreationDate(new Date());

    const pdfCache = new Map();
    const embeddedPageCache = new Map();
    const imageCache = new Map();

    for (let i = 0; i < documents.length; i += 1) {
      const doc = documents[i];
      if (doc.kind === 'pdf') {
        pdfCache.set(i, await loadPdf(doc.bytes));
      }
    }

    const plan = Layout.planOutput({
      documents: opts.documents,
      pageList: pageList,
      settings: settings
    });

    let lastSheet = null;

    for (let sideIndex = 0; sideIndex < plan.sides.length; sideIndex += 1) {
      const side = plan.sides[sideIndex];
      const first = side[0] || null;
      const sheet = first
        ? Layout.sheetSizeFor(settings.paper, settings.orientation, nup, first)
        : (lastSheet || Layout.sheetSizeFor(settings.paper, settings.orientation, nup, null));
      lastSheet = sheet;

      const outPage = outDoc.addPage([sheet.width, sheet.height]);
      const layout = Layout.cellsFor(sheet.width, sheet.height, nup);

      for (let slot = 0; slot < side.length; slot += 1) {
        const item = side[slot];
        const cell = layout.cells[slot];
        if (!item || !cell) continue;
        const doc = documents[item.docIndex];
        if (!doc) continue;

        const cellCenterX = cell.x + cell.w / 2;
        const cellCenterY = sheet.height - (cell.y + cell.h / 2);

        if (doc.kind === 'pdf') {
          const srcDoc = pdfCache.get(item.docIndex);
          if (!srcDoc) throw new Error('A source PDF is missing from this job.');
          const srcPage = srcDoc.getPage(item.pageIndex);
          const sourceRotation = Layout.normalizeRotation(srcPage.getRotation().angle);
          const pageW = srcPage.getWidth();
          const pageH = srcPage.getHeight();
          const displayW = sourceRotation % 180 === 0 ? pageW : pageH;
          const displayH = sourceRotation % 180 === 0 ? pageH : pageW;
          const extraRotation = (displayW > displayH) !== (cell.w > cell.h) ? 90 : 0;
          const totalRotation = Layout.normalizeRotation(sourceRotation + extraRotation);
          const effectiveW = totalRotation % 180 === 0 ? pageW : pageH;
          const effectiveH = totalRotation % 180 === 0 ? pageH : pageW;
          const scale = Math.min(cell.w / effectiveW, cell.h / effectiveH);
          const origin = originFor(cellCenterX, cellCenterY, pageW * scale, pageH * scale, totalRotation);

          const key = item.docIndex + ':' + item.pageIndex;
          let embedded = embeddedPageCache.get(key);
          if (!embedded) {
            embedded = await outDoc.embedPage(srcPage);
            embeddedPageCache.set(key, embedded);
          }

          outPage.drawPage(embedded, {
            x: origin.x,
            y: origin.y,
            width: pageW * scale,
            height: pageH * scale,
            rotate: degrees(totalRotation)
          });
        } else if (doc.kind === 'image') {
          const image = await imageInfo(outDoc, doc, imageCache);
          const pageW = image.width;
          const pageH = image.height;
          const extraRotation = (pageW > pageH) !== (cell.w > cell.h) ? 90 : 0;
          const totalRotation = extraRotation;
          const effectiveW = totalRotation % 180 === 0 ? pageW : pageH;
          const effectiveH = totalRotation % 180 === 0 ? pageH : pageW;
          const scale = Math.min(cell.w / effectiveW, cell.h / effectiveH);
          const origin = originFor(cellCenterX, cellCenterY, pageW * scale, pageH * scale, totalRotation);

          outPage.drawImage(image.image, {
            x: origin.x,
            y: origin.y,
            width: pageW * scale,
            height: pageH * scale,
            rotate: degrees(totalRotation)
          });
        }
      }
    }

    return new Uint8Array(await outDoc.save({ useObjectStreams: false }));
  }

  return {
    buildPrintReady: buildPrintReady,
    originFor: originFor
  };
});
