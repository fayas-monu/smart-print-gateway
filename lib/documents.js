/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Uploaded document inspection (PDF, image, Word). (AL SHAJAR TEAM)
 */
'use strict';

const path = require('path');
const { PDFDocument } = require('../shared/vendor/pdf-lib.min.js');
const Layout = require('../shared/layout.js');

function startsWith(bytes, values) {
  if (!bytes || bytes.length < values.length) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (bytes[i] !== values[i]) return false;
  }
  return true;
}

function detectKind(name, mime, bytes) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const type = String(mime || '').toLowerCase();
  if (ext === '.pdf' || type === 'application/pdf' || startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (ext === '.docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === '.doc' || type === 'application/msword') return 'doc';
  if (ext === '.jpg' || ext === '.jpeg' || type === 'image/jpeg' || startsWith(bytes, [0xFF, 0xD8, 0xFF])) return 'image';
  if (ext === '.png' || type === 'image/png' || startsWith(bytes, [0x89, 0x50, 0x4E, 0x47])) return 'image';
  return 'unsupported';
}

function imageMime(name, mime, bytes) {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/png') return 'image/png';
  if (type === 'image/jpeg') return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4E, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  return 'image/jpeg';
}

async function inspectPdf(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (/encrypt/i.test(message)) {
      throw new Error('This PDF is password-protected. Unlock it and upload again.');
    }
    throw new Error('This PDF could not be read. Re-export it as a standard PDF and try again.');
  }
  const pages = doc.getPages().map(function (page) {
    const rotation = Layout.normalizeRotation(page.getRotation().angle);
    const width = page.getWidth();
    const height = page.getHeight();
    return {
      width: rotation % 180 === 0 ? width : height,
      height: rotation % 180 === 0 ? height : width
    };
  });
  if (!pages.length) throw new Error('This PDF has no pages.');
  return { kind: 'pdf', pages: pages, pageCount: pages.length };
}

async function inspectImage(bytes, name, mime) {
  const type = imageMime(name, mime, bytes);
  const doc = await PDFDocument.create();
  let image;
  try {
    image = type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch (err) {
    throw new Error('This image could not be read. Use a JPG or PNG file.');
  }
  return {
    kind: 'image',
    mime: type,
    pages: [{ width: image.width, height: image.height }],
    pageCount: 1
  };
}

async function inspectDocument(input) {
  const bytes = input && input.bytes;
  const name = (input && input.name) || 'document';
  const mime = (input && input.mime) || '';
  if (!bytes || !bytes.length) throw new Error('The uploaded file is empty.');
  const kind = detectKind(name, mime, bytes);

  if (kind === 'pdf') {
    const info = await inspectPdf(bytes);
    return Object.assign({ name: name, mime: 'application/pdf', size: bytes.length }, info);
  }
  if (kind === 'image') {
    const info = await inspectImage(bytes, name, mime);
    return Object.assign({ name: name, size: bytes.length }, info);
  }
  if (kind === 'docx' || kind === 'doc') {
    return {
      kind: 'docx',
      name: name,
      mime: mime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: bytes.length,
      pages: [],
      pageCount: 0
    };
  }
  throw new Error('Unsupported file type. Please upload PDF, Word (.docx), JPG or PNG.');
}

module.exports = {
  detectKind,
  inspectDocument,
  inspectPdf,
  inspectImage,
  imageMime
};
