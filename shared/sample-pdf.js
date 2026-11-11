/*
 * Smart Print Gateway — generated 8-page demo PDF.
 * Used by the client "Load sample" action and by the operator test page.
 * Pure ASCII content streams so the xref byte offsets are trivial to keep
 * correct. No dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SamplePdf = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const encoder = new TextEncoder();

  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;

  function pageContent(index, total) {
    const isCover = index === 0;
    const palette = ['0.231 0.510 0.965', '0.078 0.722 0.651', '0.961 0.620 0.043', '0.937 0.267 0.267'];
    const accent = palette[index % palette.length];
    const lines = [];
    lines.push('0.043 0.071 0.125 rg 0 0 ' + PAGE_W + ' ' + PAGE_H + ' re f');
    lines.push(accent + ' rg 0 ' + (PAGE_H - 10) + ' ' + PAGE_W + ' 10 re f');
    lines.push(accent + ' rg 0 0 14 ' + PAGE_H + ' re f');
    lines.push('1 1 1 rg');
    lines.push('BT /F2 10 Tf 46 ' + (PAGE_H - 54) + ' Td (SMART PRINT GATEWAY) Tj ET');
    lines.push('BT /F1 9 Tf 430 ' + (PAGE_H - 54) + ' Td (SAMPLE DOCUMENT) Tj ET');

    if (isCover) {
      lines.push(accent + ' rg 46 610 92 6 re f');
      lines.push('1 1 1 rg BT /F2 34 Tf 46 555 Td (Print brilliantly.) Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 14 Tf 46 520 Td (A demonstration file for the Smart Print Gateway) Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 11 Tf 46 500 Td (Try booklet, 4-up handout, poster and duplex previews.) Tj ET');
      lines.push('0.09 0.13 0.20 rg 46 330 500 130 re f');
      lines.push('1 1 1 rg BT /F2 12 Tf 66 430 Td (THIS FILE CONTAINS 8 PAGES) Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 10 Tf 66 405 Td (Page 1 cover  |  Pages 2-8 content and colour test pages) Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 10 Tf 66 385 Td (Colour blocks let the gateway detect colour pages for pricing.) Tj ET');
      lines.push(accent + ' rg 46 250 120 120 re f');
      lines.push('0.078 0.722 0.651 rg 180 250 120 120 re f');
      lines.push('0.961 0.620 0.043 rg 314 250 120 120 re f');
      lines.push('0.937 0.267 0.267 rg 448 250 98 120 re f');
    } else {
      lines.push('1 1 1 rg BT /F2 26 Tf 46 700 Td (Sample page ' + (index + 1) + ') Tj ET');
      lines.push(accent + ' rg 46 676 70 5 re f');
      lines.push('0.72 0.78 0.88 rg BT /F1 11 Tf 46 640 Td (This page demonstrates a typical document page in the print preview.) Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 11 Tf 46 622 Td (Margins, scaling, borders and N-up layouts are applied live.) Tj ET');
      for (let i = 0; i < 12; i++) {
        const w = 300 + ((i * 37) % 150);
        lines.push('0.62 0.68 0.78 rg 46 ' + (575 - i * 22) + ' ' + w + ' 6 re f');
      }
      lines.push('0.09 0.13 0.20 rg 46 260 500 110 re f');
      lines.push(accent + ' rg 46 260 6 110 re f');
      lines.push('1 1 1 rg BT /F2 12 Tf 66 340 Td (Layout tip ' + (index + 1) + ') Tj ET');
      const tips = [
        'Booklet mode imposes pages in saddle-stitch order.',
        '4-up saves paper for handouts and revision sheets.',
        'Duplex long-edge is ideal for reports and contracts.',
        'Poster mode tiles one page across multiple sheets.',
        'Stapling is applied per copy set by the finisher.',
        'Pure black & white converts every page to high contrast.',
        '1200 dpi is best for fine line art and small type.'
      ];
      lines.push('0.72 0.78 0.88 rg BT /F1 10 Tf 66 315 Td (' + esc(tips[(index - 1) % tips.length]) + ') Tj ET');
      lines.push('0.72 0.78 0.88 rg BT /F1 10 Tf 66 295 Td (Ask the print assistant if you need help choosing settings.) Tj ET');
    }

    lines.push('0.45 0.52 0.63 rg BT /F1 9 Tf 46 34 Td (Smart Print Gateway  |  Generated sample  |  Page ' + (index + 1) + ' of ' + total + ') Tj ET');
    lines.push('0.45 0.52 0.63 rg BT /F1 9 Tf 500 34 Td (' + (index + 1) + '/' + total + ') Tj ET');
    return lines.join('\n');
  }

  function build() {
    const total = 8;
    const objects = [];
    const pageObjStart = 5;
    const kids = [];
    for (let i = 0; i < total; i++) kids.push((pageObjStart + i * 2) + ' 0 R');

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + total + ' >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    for (let i = 0; i < total; i++) {
      const pn = pageObjStart + i * 2;
      const cn = pn + 1;
      const content = pageContent(i, total);
      objects[pn] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H +
        '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + cn + ' 0 R >>';
      objects[cn] = '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream';
    }

    const totalObjects = 4 + total * 2;
    const chunks = [];
    let length = 0;
    function push(data) {
      const u8 = typeof data === 'string' ? encoder.encode(data) : data;
      chunks.push(u8);
      length += u8.length;
    }
    push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');
    const offsets = [0];
    for (let i = 1; i <= totalObjects; i++) {
      offsets[i] = length;
      push(i + ' 0 obj\n' + objects[i] + '\nendobj\n');
    }
    const xrefStart = length;
    let xref = 'xref\n0 ' + (totalObjects + 1) + '\n0000000000 65535 f \n';
    for (let i = 1; i <= totalObjects; i++) {
      xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    push(xref);
    push('trailer\n<< /Size ' + (totalObjects + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n');

    const out = new Uint8Array(length);
    let pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    return out;
  }

  return { build: build, pageCount: 8 };
});
