/*
 * Smart Print Gateway — tiny PDF writer for print-ready imposition sheets.
 *
 * The browser renders each imposed sheet to a JPEG canvas (N-up, booklet,
 * poster, scaling and colour conversion already applied) and this module
 * wraps those JPEGs into a valid multi-page PDF. The result is uploaded as
 * the "print-ready" file so the physical printer reproduces exactly what the
 * customer saw in the preview.
 *
 * No external dependencies. Works in browsers and Node.js (for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PdfBuilder = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();

  function ascii(str) { return encoder.encode(str); }

  function decodeBase64(b64) {
    const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function pdfDate(d) {
    const dt = d || new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return 'D:' + dt.getUTCFullYear() + p(dt.getUTCMonth() + 1) + p(dt.getUTCDate()) +
      p(dt.getUTCHours()) + p(dt.getUTCMinutes()) + p(dt.getUTCSeconds()) + 'Z';
  }

  function escapePdfText(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
      .replace(/[\r\n]+/g, ' ');
  }

  /**
   * @param {Array} pages [{ jpeg: Uint8Array|base64|dataURL, widthPt, heightPt }]
   * @param {Object} opts { title, author, subject }
   * @returns {Uint8Array}
   */
  function buildFromJpegPages(pages, opts) {
    opts = opts || {};
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('No pages supplied');
    const chunks = [];
    let length = 0;
    function push(data) {
      const u8 = typeof data === 'string' ? ascii(data) : data;
      chunks.push(u8);
      length += u8.length;
      return u8.length;
    }

    push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');

    const offsets = [0];
    const pageObjStart = 4;
    const count = pages.length;
    const totalObjects = 3 + count * 3;
    const kids = pages.map(function (_, i) { return (pageObjStart + i * 3) + ' 0 R'; }).join(' ');

    function obj(num, body, streamBytes) {
      offsets[num] = length;
      if (streamBytes) {
        push(num + ' 0 obj\n' + body + '\nstream\n');
        push(streamBytes);
        push('\nendstream\nendobj\n');
      } else {
        push(num + ' 0 obj\n' + body + '\nendobj\n');
      }
    }

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + count + ' >>');
    obj(3, '<< /Title (' + escapePdfText(opts.title || 'Smart Print Gateway job') + ') /Producer (Smart Print Gateway 2.0) /Creator (Smart Print Gateway) /CreationDate (' + pdfDate() + ') >>');

    pages.forEach(function (page, i) {
      const pn = pageObjStart + i * 3;
      const cn = pn + 1;
      const imn = pn + 2;
      const w = Number(page.widthPt) || 595.28;
      const h = Number(page.heightPt) || 841.89;
      const jpeg = page.jpeg instanceof Uint8Array ? page.jpeg : decodeBase64(page.jpeg);
      const content = 'q\n' + w.toFixed(3) + ' 0 0 ' + h.toFixed(3) + ' 0 0 cm\n/Im0 Do\nQ\n';
      obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w.toFixed(3) + ' ' + h.toFixed(3) +
        '] /Resources << /XObject << /Im0 ' + imn + ' 0 R >> >> /Contents ' + cn + ' 0 R >>');
      obj(cn, '<< /Length ' + content.length + ' >>', ascii(content));
      obj(imn, '<< /Type /XObject /Subtype /Image /Width ' + (Number(page.widthPx) || 1000) +
        ' /Height ' + (Number(page.heightPx) || 1414) +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>', jpeg);
    });

    const xrefStart = length;
    let xref = 'xref\n0 ' + (totalObjects + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= totalObjects; i++) {
      xref += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (totalObjects + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n');

    const out = new Uint8Array(length);
    let pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  function toBase64(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function bytesToBlobUrl(u8) {
    return URL.createObjectURL(new Blob([u8], { type: 'application/pdf' }));
  }

  return {
    buildFromJpegPages: buildFromJpegPages,
    decodeBase64: decodeBase64,
    toBase64: toBase64,
    bytesToBlobUrl: bytesToBlobUrl
  };
});
