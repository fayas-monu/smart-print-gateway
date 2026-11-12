/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * LAN print portal, operator console and Canon print dispatch. (AL SHAJAR TEAM)
 *
 * Zero npm dependencies. Node.js 18+.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const { spawn } = require('child_process');

const Config = require('./lib/config');
const { AuthStore, DEFAULT_PIN } = require('./lib/auth');
const { JobStore } = require('./lib/store');
const { PrintManager } = require('./lib/printers');
const { inspectDocument, detectKind } = require('./lib/documents');
const { convertDocxBuffer, detectConverters } = require('./lib/office');
const QR = require('./lib/qr');
const Util = require('./lib/util');
const Pricing = require('./shared/pricing');
const Layout = require('./shared/layout');
const Imposition = require('./shared/imposition');
const SamplePdf = require('./shared/sample-pdf.js');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config', 'shop.config.json');
const HOST = '0.0.0.0';
const ARGS = process.argv.slice(2);

if (ARGS.indexOf('--live') >= 0 || process.env.SPG_PRINT_MODE === 'live') {
  configForceLive();
}

function configForceLive() {
  try {
    const loaded = Config.loadConfig(CONFIG_PATH);
    loaded.server.printMode = 'live';
    Config.saveConfig(CONFIG_PATH, loaded);
  } catch (err) { /* loadConfig below will handle */ }
}

let config = Config.loadConfig(CONFIG_PATH);
config.server.host = HOST;
if (ARGS.indexOf('--live') >= 0 || process.env.SPG_PRINT_MODE === 'live') config.server.printMode = 'live';
if (ARGS.indexOf('--simulate') >= 0 || process.env.SPG_PRINT_MODE === 'simulate') config.server.printMode = 'simulate';

const PORT = Math.max(1, Number(process.env.SPG_PORT || config.server.port || 4173));
const OPEN_BROWSER = ARGS.indexOf('--open') >= 0 || process.env.SPG_OPEN === '1';
const REQUEST_LOG = process.env.SPG_LOG === '1';

Util.ensureDir(DATA_DIR);
Util.ensureDir(path.join(DATA_DIR, 'tmp'));

const auth = new AuthStore(DATA_DIR);
const store = new JobStore(DATA_DIR);
const printManager = new PrintManager(config);
const sseClients = new Set();
const publicRate = new Map();
let actualPort = PORT;
let samplePdfCache = null;

/* ------------------------------------------------------------------ */
/* Startup recovery and housekeeping                                   */
/* ------------------------------------------------------------------ */

(function recoverJobs() {
  let changed = 0;
  store.all().forEach(function (job) {
    if (job.status !== 'printing') return;
    job.status = 'failed';
    job.error = 'The server restarted while this job was printing. Use Reprint to try again.';
    job.timeline = Array.isArray(job.timeline) ? job.timeline : [];
    job.timeline.push({
      at: new Date().toISOString(),
      status: 'failed',
      message: job.error,
      actor: 'system'
    });
    job.updatedAt = new Date().toISOString();
    changed += 1;
  });
  if (changed) store.save();
})();

try { store.cleanup(config.server.retentionDays); } catch (err) { /* ignore */ }

const cleanupTimer = setInterval(function () {
  try { store.cleanup(config.server.retentionDays); } catch (err) { /* ignore */ }
}, 6 * 60 * 60 * 1000);
cleanupTimer.unref();

/* ------------------------------------------------------------------ */
/* Generic helpers                                                     */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; font-src 'self'; worker-src 'self' blob:; " +
    "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new url.URL(origin);
    return parsed.host === req.headers.host;
  } catch (err) {
    return false;
  }
}

function assertSameOrigin(req) {
  if (!sameOrigin(req)) throw httpError(403, 'Cross-site request blocked.');
}

function readJsonBody(req, limitBytes) {
  return new Promise(function (resolve, reject) {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limitBytes) {
      req.resume();
      reject(httpError(413, 'The upload is too large.'));
      return;
    }
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        req.resume();
        reject(httpError(413, 'The upload is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (done) return;
      done = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (err) {
        reject(httpError(400, 'Invalid JSON payload.'));
      }
    });
    req.on('error', function (err) {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function getSession(req) {
  const cookies = Util.parseCookies(req.headers.cookie);
  let token = cookies[auth.cookieName()];
  const header = String(req.headers.authorization || '');
  if (!token && header.toLowerCase().indexOf('bearer ') === 0) token = header.slice(7).trim();
  return auth.verifySession(token);
}

function requireOperator(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { ok: false, error: 'Operator login required.' });
    return null;
  }
  return session;
}

function rateLimit(req, bucket, limit, windowMs) {
  const ip = Util.clientIp(req);
  const key = bucket + ':' + ip;
  const now = Date.now();
  let entry = publicRate.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    publicRate.set(key, entry);
  }
  entry.count += 1;
  if (publicRate.size > 600) {
    for (const [k, v] of publicRate) {
      if (now - v.start > windowMs) publicRate.delete(k);
    }
  }
  if (entry.count > limit) {
    const retry = Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000));
    const err = httpError(429, 'Too many requests. Please wait ' + retry + ' seconds.');
    err.retryAfter = retry;
    throw err;
  }
}

function dateInDubai(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.shop.timezone || 'Asia/Dubai',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(iso));
  } catch (err) {
    return String(iso || '').slice(0, 10);
  }
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function queuePositions() {
  const pending = store.all()
    .filter(function (job) { return job.status === 'pending'; })
    .sort(function (a, b) { return String(a.createdAt).localeCompare(String(b.createdAt)); });
  const map = new Map();
  pending.forEach(function (job, index) { map.set(job.id, index + 1); });
  return map;
}

function computeStats() {
  const today = Util.todayInZone(config.shop.timezone || 'Asia/Dubai');
  let pending = 0;
  let printing = 0;
  let todayJobs = 0;
  let todayRevenue = 0;
  let completedToday = 0;

  store.all().forEach(function (job) {
    if (job.status === 'pending') pending += 1;
    if (job.status === 'printing') printing += 1;
    if (dateInDubai(job.createdAt) === today) todayJobs += 1;
    if (job.status === 'completed' && dateInDubai(job.completedAt || job.updatedAt || job.createdAt) === today) {
      completedToday += 1;
      todayRevenue += Number(job.pricing && job.pricing.total) || 0;
    }
  });

  return {
    pending: pending,
    printing: printing,
    completedToday: completedToday,
    todayJobs: todayJobs,
    todayRevenue: round2(todayRevenue),
    totalJobs: store.all().length,
    currency: 'AED'
  };
}

function queuePayload() {
  const positions = queuePositions();
  const jobs = store.all();
  const statusOrder = { pending: 0, printing: 1 };
  const queue = jobs
    .filter(function (job) { return job.status === 'pending' || job.status === 'printing'; })
    .sort(function (a, b) {
      const left = statusOrder[a.status] == null ? 9 : statusOrder[a.status];
      const right = statusOrder[b.status] == null ? 9 : statusOrder[b.status];
      if (left !== right) return left - right;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    })
    .map(function (job) { return summarizeJob(job, positions.get(job.id) || 0); });

  const recent = jobs
    .filter(function (job) { return ['completed', 'rejected', 'failed', 'cancelled'].indexOf(job.status) >= 0; })
    .sort(function (a, b) { return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)); })
    .slice(0, 8)
    .map(function (job) { return summarizeJob(job, 0); });

  return {
    ok: true,
    queue: queue,
    recent: recent,
    stats: computeStats(),
    serverTime: new Date().toISOString(),
    printMode: config.server.printMode
  };
}

function summarizeJob(job, position) {
  const settings = job.settings || {};
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    customerName: job.customer && job.customer.name ? job.customer.name : 'Walk-in customer',
    customerPhone: job.customer && job.customer.phone ? job.customer.phone : '',
    fulfillment: job.fulfillment,
    payment: job.payment,
    pageCount: job.pageCount,
    copies: settings.copies || 1,
    paper: settings.paper || 'A4',
    color: settings.color === 'color' ? 'color' : 'bw',
    duplex: !!settings.duplex,
    nup: settings.nup || 1,
    total: job.pricing ? job.pricing.total : 0,
    currency: 'AED',
    printerId: job.printerId || '',
    rejectionReason: job.rejectionReason || '',
    error: job.error || '',
    queuePosition: position || 0,
    printReadyPages: job.printReady ? job.printReady.pages : 0
  };
}

function parseStatusFilter(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'all') return null;
  if (text === 'queue') return ['pending', 'printing'];
  if (text === 'history') return ['completed', 'rejected', 'failed', 'cancelled'];
  return text.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function pushTimeline(job, status, message, actor) {
  job.timeline = Array.isArray(job.timeline) ? job.timeline : [];
  job.timeline.push({
    at: new Date().toISOString(),
    status: status,
    message: message,
    actor: actor || 'system'
  });
}

function broadcastQueue() {
  if (!sseClients.size) return;
  let payload;
  try {
    payload = JSON.stringify({ type: 'queue', data: queuePayload() });
  } catch (err) {
    return;
  }
  for (const client of sseClients) {
    try {
      client.write('event: update\ndata: ' + payload + '\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function networkInfo(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  Object.keys(interfaces).forEach(function (name) {
    (interfaces[name] || []).forEach(function (address) {
      if (!address || address.family !== 'IPv4' || address.internal) return;
      const ip = address.address;
      const privateAddress = Util.isPrivateIpv4(ip);
      urls.push({
        name: name,
        address: ip,
        private: privateAddress,
        url: 'http://' + ip + ':' + port + '/'
      });
    });
  });
  urls.sort(function (a, b) {
    if (a.private !== b.private) return a.private ? -1 : 1;
    return a.url.localeCompare(b.url);
  });
  const localUrl = 'http://localhost:' + port + '/';
  const primary = urls.length ? urls[0].url : localUrl;
  const withQr = urls.map(function (item) {
    return Object.assign({}, item, {
      qrSvg: QR.svgFor(item.url, { cellSize: 6, margin: 3 })
    });
  });
  return {
    host: HOST,
    port: port,
    localUrl: localUrl,
    primaryUrl: primary,
    urls: withQr,
    qrSvg: QR.svgFor(primary, { cellSize: 6, margin: 3 })
  };
}

function sendFile(req, res, filePath, options) {
  const opts = options || {};
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    json(res, 404, { ok: false, error: 'File not found.' });
    return;
  }
  if (!stat.isFile()) {
    json(res, 404, { ok: false, error: 'File not found.' });
    return;
  }
  const headers = {
    'Content-Type': opts.contentType || Util.mimeForPath(filePath),
    'Content-Length': stat.size,
    'Cache-Control': opts.cache || 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (opts.disposition) headers['Content-Disposition'] = opts.disposition;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', function () {
    try { res.destroy(); } catch (err) { /* ignore */ }
  });
  stream.pipe(res);
}

function sanitizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const paper = ['A4', 'A5', 'A3'].indexOf(String(source.paper)) >= 0 ? String(source.paper) : 'A4';
  const color = source.color === 'color' ? 'color' : 'bw';
  const nup = [1, 2, 4].indexOf(Number(source.nup)) >= 0 ? Number(source.nup) : 1;
  const orientation = ['auto', 'portrait', 'landscape'].indexOf(String(source.orientation)) >= 0
    ? String(source.orientation)
    : 'auto';
  const copies = Math.max(1, Math.min(99, Math.round(Number(source.copies) || 1)));
  const range = source.pageRange && typeof source.pageRange === 'object' ? source.pageRange : {};
  const mode = range.mode === 'custom' ? 'custom' : 'all';
  return {
    paper: paper,
    color: color,
    duplex: !!source.duplex,
    nup: nup,
    orientation: orientation,
    copies: copies,
    pageRange: {
      mode: mode,
      value: mode === 'custom' ? String(range.value || '').slice(0, 200) : ''
    }
  };
}

function sanitizeCustomer(input, fulfillment) {
  const source = input && typeof input === 'object' ? input : {};
  const name = String(source.name || '').trim().slice(0, 80);
  const phone = String(source.phone || '').trim().slice(0, 30);
  const address = String(source.address || '').trim().slice(0, 240);
  const note = String(source.note || '').trim().slice(0, 500);
  if (!name) throw httpError(400, 'Please enter your name.');
  if (fulfillment === 'delivery') {
    if (!phone) throw httpError(400, 'Please enter a phone number for home delivery.');
    if (!address) throw httpError(400, 'Please enter a delivery address.');
  }
  return { name: name, phone: phone, address: address, note: note };
}

/* ------------------------------------------------------------------ */
/* Job creation                                                        */
/* ------------------------------------------------------------------ */

async function createJob(req, res) {
  assertSameOrigin(req);
  rateLimit(req, 'jobs', 40, 10 * 60 * 1000);

  // Base64 inflates uploads by ~33%, so allow a generous envelope plus headroom.
  const maxBody = Math.min(650 * 1024 * 1024, config.server.maxJobMB * 2 * 1024 * 1024 + 8 * 1024 * 1024);
  const payload = await readJsonBody(req, maxBody);
  const fulfillment = payload.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const payment = payload.payment === 'card' ? 'card' : 'cash';
  const customer = sanitizeCustomer(payload.customer, fulfillment);
  const settings = sanitizeSettings(payload.settings);
  const inputDocs = Array.isArray(payload.documents) ? payload.documents : [];

  if (!inputDocs.length) throw httpError(400, 'Please upload at least one file.');
  if (inputDocs.length > 12) throw httpError(400, 'Please upload no more than 12 files per job.');

  const jobId = store.newId();
  const jobDir = store.ensureJobDir(jobId);
  const preparedDocs = [];
  const jobDocs = [];
  let originalBytes = 0;

  try {
    for (let index = 0; index < inputDocs.length; index += 1) {
      const input = inputDocs[index] || {};
      const name = Util.safeFilename(input.name || ('document-' + (index + 1)), 'document');
      const declaredMime = String(input.mime || '');
      const bytes = Util.decodeBase64(input.data);
      if (!bytes.length) throw httpError(400, 'One of the uploaded files is empty.');
      if (bytes.length > config.server.maxFileMB * 1024 * 1024) {
        throw httpError(413, name + ' is larger than the ' + config.server.maxFileMB + ' MB per-file limit.');
      }
      originalBytes += bytes.length;
      if (originalBytes > config.server.maxJobMB * 1024 * 1024) {
        throw httpError(413, 'The whole job is larger than the ' + config.server.maxJobMB + ' MB limit.');
      }

      const detected = detectKind(name, declaredMime, bytes);
      if (detected === 'doc' || detected === 'unsupported') {
        throw httpError(415, name + ': use PDF, Word (.docx), JPG or PNG.');
      }

      let workingBytes = bytes;
      let workingName = name;
      let workingMime = declaredMime;
      let convertedFrom = '';

      if (detected === 'docx') {
        const converters = detectConverters(config);
        if (!converters.available) {
          throw httpError(422,
            'Word conversion is not available on the shop computer. Please save the file as PDF, or ask the shop to install LibreOffice or Microsoft Word.');
        }
        const converted = await convertDocxBuffer(bytes, name, config, DATA_DIR);
        workingBytes = converted.bytes;
        workingName = converted.name;
        workingMime = 'application/pdf';
        convertedFrom = name;
      }

      const info = await inspectDocument({ bytes: workingBytes, name: workingName, mime: workingMime });
      if (info.pageCount > config.server.maxPages) {
        throw httpError(413, workingName + ' has more than the ' + config.server.maxPages + '-page limit.');
      }

      const ext = info.kind === 'pdf' ? '.pdf' : (info.mime === 'image/png' ? '.png' : '.jpg');
      const docId = 'doc-' + (index + 1);
      const storedName = docId + '-original' + ext;
      Util.writeFileAtomic(path.join(jobDir, storedName), workingBytes);

      preparedDocs.push({
        kind: info.kind,
        mime: info.mime || workingMime || 'application/octet-stream',
        bytes: workingBytes,
        name: workingName,
        pageCount: info.pageCount,
        pages: info.pages
      });

      jobDocs.push({
        id: docId,
        name: workingName,
        originalName: name,
        convertedFrom: convertedFrom,
        mime: info.mime || workingMime || 'application/octet-stream',
        size: workingBytes.length,
        kind: info.kind,
        pageCount: info.pageCount,
        pages: info.pages,
        storedName: storedName
      });
    }

    const documentMeta = preparedDocs.map(function (doc, index) {
      return {
        id: jobDocs[index].id,
        pageCount: doc.pageCount,
        pages: doc.pages,
        kind: doc.kind
      };
    });
    const totalDocumentPages = documentMeta.reduce(function (sum, doc) { return sum + doc.pageCount; }, 0);
    if (totalDocumentPages > config.server.maxPages) {
      throw httpError(413, 'This job has more than the ' + config.server.maxPages + '-page limit.');
    }

    let pageList;
    try {
      pageList = Layout.resolvePageList(documentMeta, settings.pageRange);
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (!pageList.length) throw httpError(400, 'No pages were selected. Check your page range.');

    const plan = Layout.planOutput({ documents: documentMeta, pageList: pageList, settings: settings });
    const quote = Pricing.calculate({
      pageCount: plan.pageCount,
      copies: settings.copies,
      size: settings.paper,
      color: settings.color === 'color',
      fulfillment: fulfillment,
      pricing: config.pricing,
      delivery: config.delivery
    });

    let printReadyBytes;
    try {
      printReadyBytes = await Imposition.buildPrintReady({
        documents: preparedDocs,
        pageList: pageList,
        settings: settings,
        title: config.shop.name + ' job ' + jobId
      });
    } catch (err) {
      throw httpError(422, err.message || 'The print-ready file could not be created.');
    }

    if (printReadyBytes.length > Math.max(config.server.maxJobMB * 1024 * 1024, 30 * 1024 * 1024)) {
      throw httpError(413, 'The print-ready file is too large. Split the job into smaller parts.');
    }

    const printReadyName = 'print-ready.pdf';
    Util.writeFileAtomic(path.join(jobDir, printReadyName), printReadyBytes);

    const now = new Date().toISOString();
    const job = {
      id: jobId,
      token: Util.randomToken(24),
      createdAt: now,
      updatedAt: now,
      status: 'pending',
      customer: customer,
      fulfillment: fulfillment,
      payment: payment,
      settings: settings,
      documents: jobDocs,
      totalDocumentPages: totalDocumentPages,
      pageCount: plan.pageCount,
      plan: {
        nup: plan.nup,
        duplex: plan.duplex,
        sides: plan.rawSides,
        sheets: plan.sheets,
        outputSides: plan.outputSides
      },
      printReady: {
        storedName: printReadyName,
        size: printReadyBytes.length,
        pages: plan.outputSides
      },
      pricing: quote,
      printerId: config.server.defaultPrinterId || (config.printers[0] && config.printers[0].id) || '',
      timeline: [{
        at: now,
        status: 'pending',
        message: 'Job received by the print desk.',
        actor: 'customer'
      }],
      warnings: [],
      rejectionReason: '',
      error: ''
    };

    store.create(job);
    broadcastQueue();
    json(res, 201, {
      ok: true,
      job: {
        id: job.id,
        token: job.token,
        status: job.status,
        createdAt: job.createdAt,
        total: quote.total,
        currency: 'AED',
        pageCount: job.pageCount,
        copies: settings.copies,
        fulfillment: fulfillment,
        payment: payment,
        queuePosition: queuePositions().get(job.id) || 1
      }
    });
  } catch (err) {
    try { Util.removeDir(jobDir); } catch (cleanupErr) { /* ignore */ }
    throw err;
  }
}

function publicJobStatus(job) {
  const positions = queuePositions();
  const status = job.status;
  let message = 'We received your job. Our team will check it shortly.';
  if (status === 'printing') message = 'Your job is printing now.';
  if (status === 'completed') message = job.fulfillment === 'delivery'
    ? 'Your order is complete and will be delivered.'
    : 'Your order is ready for pickup at the counter.';
  if (status === 'rejected') message = 'Please speak to the counter about this job.';
  if (status === 'failed') message = 'We are checking this job. Please speak to the counter.';
  if (status === 'cancelled') message = 'This job was cancelled.';
  return {
    ok: true,
    job: {
      id: job.id,
      status: status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      total: job.pricing ? job.pricing.total : 0,
      currency: 'AED',
      pageCount: job.pageCount,
      copies: job.settings ? job.settings.copies : 1,
      fulfillment: job.fulfillment,
      payment: job.payment,
      canCancel: status === 'pending',
      queuePosition: status === 'pending' ? (positions.get(job.id) || 1) : 0,
      message: message,
      note: job.fulfillment === 'delivery' ? config.shop.deliveryNote : config.shop.pickupNote
    }
  };
}

function verifyJobToken(job, token) {
  return !!job && !!job.token && Util.safeEqual(job.token, token);
}

/* ------------------------------------------------------------------ */
/* Operator actions                                                    */
/* ------------------------------------------------------------------ */

function printerFor(id) {
  const printerId = String(id || '').trim();
  return config.printers.filter(function (printer) {
    return printer.id === printerId;
  })[0] || null;
}

function buildPrintJob(job) {
  const jobDir = store.jobDir(job.id);
  return {
    id: job.id,
    settings: job.settings,
    printReadyPath: job.printReady && job.printReady.storedName
      ? path.join(jobDir, job.printReady.storedName)
      : '',
    docs: (job.documents || []).map(function (doc) {
      return {
        path: path.join(jobDir, doc.storedName),
        kind: doc.kind,
        mime: doc.mime,
        name: doc.name
      };
    })
  };
}

function startPrint(job, printer, actor) {
  job.status = 'printing';
  job.printerId = printer.id;
  job.error = '';
  job.rejectionReason = '';
  pushTimeline(job, 'printing', 'Sent to ' + printer.name + ' (' + printer.location + ').', actor || 'operator');
  store.update(job.id, job);
  broadcastQueue();

  const printJob = buildPrintJob(job);
  printManager.submit(printJob, printer).then(function (result) {
    const latest = store.get(job.id);
    if (!latest) return;
    const timeline = Array.isArray(latest.timeline) ? latest.timeline : [];
    latest.timeline = timeline;
    if (result.ok) {
      latest.status = 'completed';
      latest.completedAt = new Date().toISOString();
      latest.error = '';
      pushTimeline(latest, 'completed',
        result.simulated ? 'Print simulated. No hardware was used.' : ('Printed successfully on ' + printer.name + '.'),
        'system');
    } else {
      latest.status = 'failed';
      latest.error = result.message || 'The printer reported an error.';
      pushTimeline(latest, 'failed', latest.error, 'system');
    }
    store.update(latest.id, latest);
    broadcastQueue();
  }).catch(function (err) {
    const latest = store.get(job.id);
    if (!latest) return;
    latest.status = 'failed';
    latest.error = String((err && err.message) || err || 'Print failed.');
    latest.timeline = Array.isArray(latest.timeline) ? latest.timeline : [];
    pushTimeline(latest, 'failed', latest.error, 'system');
    store.update(latest.id, latest);
    broadcastQueue();
  });
}

/* ------------------------------------------------------------------ */
/* HTTP routing                                                        */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    const converters = detectConverters(config);
    json(res, 200, {
      ok: true,
      shop: { name: config.shop.name, shortName: config.shop.shortName },
      status: 'ok',
      currency: 'AED',
      vatPercent: 5,
      printMode: config.server.printMode,
      wordConversion: converters.available,
      uptimeSeconds: Math.round(process.uptime()),
      serverTime: new Date().toISOString()
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/config') {
    const converters = detectConverters(config);
    const publicCfg = Config.publicConfig(config, {
      capabilities: {
        wordConversion: converters.available,
        pdfPreview: true,
        livePrinting: printManager.diagnostics().ready
      }
    });
    json(res, 200, { ok: true, config: publicCfg });
    return;
  }

  if (method === 'GET' && pathname === '/api/sample.pdf') {
    if (!samplePdfCache) samplePdfCache = Buffer.from(SamplePdf.build());
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': samplePdfCache.length,
      'Content-Disposition': 'inline; filename="al-shajar-sample.pdf"',
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(samplePdfCache);
    return;
  }

  if (method === 'POST' && pathname === '/api/convert') {
    assertSameOrigin(req);
    rateLimit(req, 'convert', 12, 10 * 60 * 1000);
    const payload = await readJsonBody(req, 45 * 1024 * 1024);
    const name = Util.safeFilename(payload.name || 'document.docx', 'document.docx');
    const bytes = Util.decodeBase64(payload.data);
    if (!bytes.length) throw httpError(400, 'The Word file is empty.');
    if (bytes.length > 30 * 1024 * 1024) throw httpError(413, 'The Word file is larger than 30 MB.');
    if (detectKind(name, payload.mime, bytes) !== 'docx') {
      throw httpError(415, 'Only .docx Word files can be converted.');
    }
    const converters = detectConverters(config);
    if (!converters.available) {
      throw httpError(422,
        'Word conversion is not available on the shop computer. Please save the file as PDF, or ask the shop to install LibreOffice or Microsoft Word.');
    }
    const converted = await convertDocxBuffer(bytes, name, config, DATA_DIR);
    json(res, 200, {
      ok: true,
      name: converted.name,
      mime: 'application/pdf',
      converter: converted.converter,
      data: converted.bytes.toString('base64')
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/jobs') {
    await createJob(req, res);
    return;
  }

  const publicJobMatch = /^\/api\/jobs\/([^/]+)\/(status|cancel)$/.exec(pathname);
  if (publicJobMatch && (method === 'GET' || method === 'POST')) {
    const jobId = decodeURIComponent(publicJobMatch[1]);
    const action = publicJobMatch[2];
    const token = query.get('token') || '';
    const job = store.get(jobId);
    if (!verifyJobToken(job, token)) throw httpError(404, 'Job not found.');
    if (action === 'status' && method === 'GET') {
      json(res, 200, publicJobStatus(job));
      return;
    }
    if (action === 'cancel' && method === 'POST') {
      assertSameOrigin(req);
      if (job.status !== 'pending') throw httpError(409, 'This job can no longer be cancelled.');
      job.status = 'cancelled';
      pushTimeline(job, 'cancelled', 'Cancelled by the customer.', 'customer');
      store.update(job.id, job);
      broadcastQueue();
      json(res, 200, { ok: true, job: publicJobStatus(job).job });
      return;
    }
    throw httpError(405, 'Method not allowed.');
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    assertSameOrigin(req);
    const ip = Util.clientIp(req);
    const limit = auth.checkRate(ip);
    if (!limit.allowed) {
      const err = httpError(429, 'Too many incorrect attempts. Try again in ' + limit.retryAfter + ' seconds.');
      err.retryAfter = limit.retryAfter;
      throw err;
    }
    const payload = await readJsonBody(req, 8192);
    const pin = String(payload.pin || '');
    if (!auth.verifyPin(pin)) {
      auth.recordFailure(ip);
      throw httpError(401, 'Incorrect PIN.');
    }
    auth.recordSuccess(ip);
    const session = auth.issueSession(config.server.sessionHours);
    res.setHeader('Set-Cookie', auth.sessionCookie(session, config.server.sessionHours));
    json(res, 200, {
      ok: true,
      operator: {
        shopName: config.shop.name,
        sessionExpiresInHours: config.server.sessionHours
      },
      usingDefaultPin: auth.usingDefaultPin
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    assertSameOrigin(req);
    res.setHeader('Set-Cookie', auth.clearCookie());
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/auth/session') {
    const session = requireOperator(req, res);
    if (!session) return;
    json(res, 200, {
      ok: true,
      operator: {
        shopName: config.shop.name,
        sessionExpiresInHours: config.server.sessionHours
      },
      usingDefaultPin: auth.usingDefaultPin
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/pin') {
    assertSameOrigin(req);
    const session = requireOperator(req, res);
    if (!session) return;
    const payload = await readJsonBody(req, 8192);
    try {
      auth.changePin(String(payload.currentPin || ''), String(payload.newPin || ''));
    } catch (err) {
      throw httpError(400, err.message);
    }
    const token = auth.issueSession(config.server.sessionHours);
    res.setHeader('Set-Cookie', auth.sessionCookie(token, config.server.sessionHours));
    json(res, 200, { ok: true, usingDefaultPin: auth.usingDefaultPin });
    return;
  }

  /* ----------------------- operator endpoints ---------------------- */

  if (pathname === '/api/operator/events' && method === 'GET') {
    const session = requireOperator(req, res);
    if (!session) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    sseClients.add(res);
    try {
      res.write('event: update\ndata: ' + JSON.stringify({ type: 'queue', data: queuePayload() }) + '\n\n');
    } catch (err) { /* ignore */ }
    const heartbeat = setInterval(function () {
      try { res.write(': ping\n\n'); } catch (err) { clearInterval(heartbeat); }
    }, 25000);
    req.on('close', function () {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (pathname.indexOf('/api/operator/') === 0) {
    const session = requireOperator(req, res);
    if (!session) return;
    if (req.method !== 'GET') assertSameOrigin(req);

    if (pathname === '/api/operator/queue' && method === 'GET') {
      json(res, 200, queuePayload());
      return;
    }

    if (pathname === '/api/operator/stats' && method === 'GET') {
      json(res, 200, { ok: true, stats: computeStats() });
      return;
    }

    if (pathname === '/api/operator/network' && method === 'GET') {
      json(res, 200, { ok: true, network: networkInfo(actualPort) });
      return;
    }

    if (pathname === '/api/operator/diagnostics' && method === 'GET') {
      const diag = printManager.diagnostics();
      json(res, 200, {
        ok: true,
        diagnostics: Object.assign({}, diag, {
          node: process.version,
          platform: process.platform,
          uptimeSeconds: Math.round(process.uptime()),
          dataBytes: store.totalBytes(),
          jobs: store.all().length,
          usingDefaultPin: auth.usingDefaultPin,
          port: actualPort,
          host: HOST
        })
      });
      return;
    }

    if (pathname === '/api/operator/settings' && method === 'GET') {
      json(res, 200, {
        ok: true,
        settings: config,
        diagnostics: printManager.diagnostics(),
        security: { usingDefaultPin: auth.usingDefaultPin }
      });
      return;
    }

    if (pathname === '/api/operator/settings' && method === 'PUT') {
      const payload = await readJsonBody(req, 1024 * 1024);
      let next;
      try {
        next = Config.applySettingsPatch(config, payload);
      } catch (err) {
        throw httpError(400, err.message || 'Invalid settings.');
      }
      if (!next.server.defaultPrinterId || !next.printers.some(function (p) { return p.id === next.server.defaultPrinterId; })) {
        next.server.defaultPrinterId = next.printers[0].id;
      }
      config = Config.saveConfig(CONFIG_PATH, next);
      printManager.setConfig(config);
      try { store.cleanup(config.server.retentionDays); } catch (err) { /* ignore */ }
      broadcastQueue();
      json(res, 200, {
        ok: true,
        settings: config,
        diagnostics: printManager.diagnostics(),
        security: { usingDefaultPin: auth.usingDefaultPin }
      });
      return;
    }

    if (pathname === '/api/operator/jobs' && method === 'GET') {
      const statusFilter = parseStatusFilter(query.get('status'));
      const q = String(query.get('q') || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(200, Number(query.get('limit')) || 100));
      const offset = Math.max(0, Number(query.get('offset')) || 0);
      const positions = queuePositions();
      let jobs = store.all().slice();
      if (statusFilter) jobs = jobs.filter(function (job) { return statusFilter.indexOf(job.status) >= 0; });
      if (q) {
        jobs = jobs.filter(function (job) {
          const haystack = [
            job.id,
            job.customer && job.customer.name,
            job.customer && job.customer.phone,
            job.customer && job.customer.address
          ].join(' ').toLowerCase();
          return haystack.indexOf(q) >= 0;
        });
      }
      jobs.sort(function (a, b) {
        return String(b.createdAt).localeCompare(String(a.createdAt));
      });
      const total = jobs.length;
      jobs = jobs.slice(offset, offset + limit).map(function (job) {
        return summarizeJob(job, positions.get(job.id) || 0);
      });
      json(res, 200, { ok: true, jobs: jobs, total: total, limit: limit, offset: offset });
      return;
    }

    if (pathname === '/api/operator/export.csv' && method === 'GET') {
      const rows = [];
      rows.push([
        'Job', 'Created', 'Status', 'Customer', 'Phone', 'Fulfilment', 'Payment',
        'Pages', 'Copies', 'Paper', 'Colour', 'Duplex', 'N-up', 'Total AED', 'Printer'
      ]);
      store.all()
        .slice()
        .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })
        .forEach(function (job) {
          const s = job.settings || {};
          const printer = printerFor(job.printerId);
          rows.push([
            job.id,
            job.createdAt,
            job.status,
            job.customer && job.customer.name,
            job.customer && job.customer.phone,
            job.fulfillment,
            job.payment,
            job.pageCount,
            s.copies,
            s.paper,
            s.color,
            s.duplex ? 'double-sided' : 'single-sided',
            s.nup + '-up',
            job.pricing ? Number(job.pricing.total).toFixed(2) : '0.00',
            printer ? printer.name : ''
          ]);
        });
      const csv = '\uFEFF' + rows.map(function (row) {
        return row.map(Util.csvEscape).join(',');
      }).join('\r\n') + '\r\n';
      const filename = 'al-shajar-jobs-' + Util.todayInZone(config.shop.timezone) + '.csv';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(csv);
      return;
    }

    const detailMatch = /^\/api\/operator\/jobs\/([^/]+)$/.exec(pathname);
    if (detailMatch && method === 'GET') {
      const job = store.get(decodeURIComponent(detailMatch[1]));
      if (!job) throw httpError(404, 'Job not found.');
      const printer = printerFor(job.printerId);
      json(res, 200, {
        ok: true,
        job: Object.assign(summarizeJob(job, queuePositions().get(job.id) || 0), {
          customer: job.customer,
          settings: job.settings,
          documents: job.documents,
          totalDocumentPages: job.totalDocumentPages,
          pricing: job.pricing,
          timeline: job.timeline,
          plan: job.plan,
          printReady: job.printReady,
          printer: printer,
          canReprint: ['completed', 'failed', 'rejected'].indexOf(job.status) >= 0,
          canDelete: job.status !== 'printing',
          canAccept: job.status === 'pending'
        })
      });
      return;
    }

    const fileMatch = /^\/api\/operator\/jobs\/([^/]+)\/(docs\/([^/]+)|print-ready)$/.exec(pathname);
    if (fileMatch && method === 'GET') {
      const job = store.get(decodeURIComponent(fileMatch[1]));
      if (!job) throw httpError(404, 'Job not found.');
      const jobDir = store.jobDir(job.id);
      if (fileMatch[2] === 'print-ready') {
        if (!job.printReady || !job.printReady.storedName) throw httpError(404, 'Print-ready file not found.');
        const filePath = path.join(jobDir, job.printReady.storedName);
        sendFile(req, res, filePath, {
          contentType: 'application/pdf',
          disposition: 'inline; filename="' + job.id + '-print-ready.pdf"',
          cache: 'private, no-store'
        });
        return;
      }
      const docId = decodeURIComponent(fileMatch[3]);
      const doc = (job.documents || []).filter(function (d) { return d.id === docId; })[0];
      if (!doc) throw httpError(404, 'Document not found.');
      sendFile(req, res, path.join(jobDir, doc.storedName), {
        contentType: doc.mime || Util.mimeForPath(doc.storedName),
        disposition: 'inline; filename="' + Util.safeFilename(doc.name, 'document') + '"',
        cache: 'private, no-store'
      });
      return;
    }

    const actionMatch = /^\/api\/operator\/jobs\/([^/]+)\/(accept|reject|reprint|complete)$/.exec(pathname);
    if (actionMatch && method === 'POST') {
      const job = store.get(decodeURIComponent(actionMatch[1]));
      if (!job) throw httpError(404, 'Job not found.');
      const action = actionMatch[2];
      const payload = await readJsonBody(req, 128 * 1024);

      if (action === 'accept') {
        if (job.status !== 'pending') throw httpError(409, 'This job is no longer waiting for acceptance.');
        const printer = printerFor(payload.printerId) || printerFor(config.server.defaultPrinterId) || config.printers.filter(function (p) { return p.enabled; })[0];
        if (!printer) throw httpError(400, 'No printer is configured. Add one in Settings.');
        if (payload.note) {
          job.customer = job.customer || {};
          job.customer.note = String(payload.note).slice(0, 500);
        }
        startPrint(job, printer, 'operator');
        json(res, 200, { ok: true, job: summarizeJob(store.get(job.id), 0) });
        return;
      }

      if (action === 'reject') {
        if (job.status !== 'pending') throw httpError(409, 'Only pending jobs can be rejected.');
        const reason = String(payload.reason || '').trim().slice(0, 240);
        if (reason.length < 3) throw httpError(400, 'Enter a short reason for the customer.');
        job.status = 'rejected';
        job.rejectionReason = reason;
        pushTimeline(job, 'rejected', 'Rejected: ' + reason, 'operator');
        store.update(job.id, job);
        broadcastQueue();
        json(res, 200, { ok: true, job: summarizeJob(job, 0) });
        return;
      }

      if (action === 'reprint') {
        if (job.status === 'printing') throw httpError(409, 'This job is already printing.');
        const printer = printerFor(payload.printerId) || printerFor(job.printerId) || printerFor(config.server.defaultPrinterId) || config.printers.filter(function (p) { return p.enabled; })[0];
        if (!printer) throw httpError(400, 'No printer is configured.');
        startPrint(job, printer, 'operator');
        json(res, 200, { ok: true, job: summarizeJob(store.get(job.id), 0) });
        return;
      }

      if (action === 'complete') {
        if (job.status === 'completed') throw httpError(409, 'This job is already complete.');
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        job.error = '';
        pushTimeline(job, 'completed', 'Marked complete by the operator.', 'operator');
        store.update(job.id, job);
        broadcastQueue();
        json(res, 200, { ok: true, job: summarizeJob(job, 0) });
        return;
      }
    }

    const deleteMatch = /^\/api\/operator\/jobs\/([^/]+)$/.exec(pathname);
    if (deleteMatch && method === 'DELETE') {
      const job = store.get(decodeURIComponent(deleteMatch[1]));
      if (!job) throw httpError(404, 'Job not found.');
      if (job.status === 'printing') throw httpError(409, 'Wait for printing to finish before deleting this job.');
      store.remove(job.id);
      broadcastQueue();
      json(res, 200, { ok: true });
      return;
    }

    throw httpError(404, 'Operator endpoint not found.');
  }

  throw httpError(404, 'API endpoint not found.');
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { ok: false, error: 'Method not allowed.' });
    return;
  }

  let base = PUBLIC_DIR;
  let relative = pathname;

  if (pathname === '/' || pathname === '/portal' || pathname === '/portal/') {
    sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), {
      contentType: 'text/html; charset=utf-8',
      cache: 'no-store'
    });
    return;
  }
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    sendFile(req, res, path.join(PUBLIC_DIR, 'dashboard.html'), {
      contentType: 'text/html; charset=utf-8',
      cache: 'no-store'
    });
    return;
  }
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    sendFile(req, res, path.join(PUBLIC_DIR, 'assets', 'favicon.svg'), {
      contentType: 'image/svg+xml',
      cache: 'public, max-age=86400'
    });
    return;
  }
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('User-agent: *\nDisallow: /\n');
    return;
  }
  if (pathname.indexOf('/assets/') === 0) {
    base = PUBLIC_DIR;
  } else if (pathname.indexOf('/shared/') === 0) {
    base = SHARED_DIR;
    relative = pathname.slice('/shared'.length);
  } else {
    json(res, 404, { ok: false, error: 'Not found.' });
    return;
  }

  const resolved = path.resolve(base, '.' + relative);
  const baseResolved = path.resolve(base);
  if (resolved !== baseResolved && resolved.indexOf(baseResolved + path.sep) !== 0) {
    json(res, 404, { ok: false, error: 'Not found.' });
    return;
  }
  const cache = /\.(woff2?|png|jpe?g|svg)$/i.test(resolved)
    ? 'public, max-age=86400'
    : 'no-cache';
  sendFile(req, res, resolved, { cache: cache });
}

async function requestHandler(req, res) {
  setSecurityHeaders(res);
  const started = Date.now();
  let pathname = '/';
  let query = new URLSearchParams('');

  try {
    const parsed = new url.URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    query = parsed.searchParams;
    pathname = decodeURIComponent(parsed.pathname);
  } catch (err) {
    json(res, 400, { ok: false, error: 'Bad request.' });
    return;
  }

  try {
    if (pathname.indexOf('/api/') === 0) {
      await handleApi(req, res, pathname, query);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) {
      console.error('[error]', req.method, pathname, err && err.stack ? err.stack : err);
    }
    if (!res.headersSent) {
      const payload = { ok: false, error: status >= 500 ? 'Something went wrong. Please try again.' : String(err.message || err) };
      if (err && err.retryAfter) {
        res.setHeader('Retry-After', String(err.retryAfter));
        payload.retryAfter = err.retryAfter;
      }
      json(res, status, payload);
    } else {
      try { res.end(); } catch (closeErr) { /* ignore */ }
    }
  }

  if (REQUEST_LOG) {
    console.log('[' + new Date().toISOString() + '] ' + req.method + ' ' + pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms');
  }
}

const server = http.createServer(requestHandler);

server.on('clientError', function (err, socket) {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (closeErr) { /* ignore */ }
});

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('\nPort ' + PORT + ' is already in use. Set SPG_PORT to another port and try again.\n');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  actualPort = server.address().port;
  const network = networkInfo(actualPort);
  const diag = printManager.diagnostics();
  const converters = detectConverters(config);

  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────────┐');
  console.log('  │  AL SHAJAR STATIONERY  ·  SMART PRINT GATEWAY                │');
  console.log('  └──────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  Listening on 0.0.0.0:' + actualPort + ' (all LAN interfaces)');
  console.log('');
  console.log('  Customer portal (this computer):');
  console.log('    ' + network.localUrl);
  if (network.urls.length) {
    console.log('');
    console.log('  Customer portal (phones / tablets on the shop Wi-Fi):');
    network.urls.forEach(function (item) {
      console.log('    ' + item.url + '   [' + item.name + ']');
    });
  } else {
    console.log('');
    console.log('  No LAN IPv4 address was detected. Connect the computer to the shop network.');
  }
  console.log('');
  console.log('  Operator console:');
  console.log('    ' + (network.urls.length ? network.urls[0].url : network.localUrl) + 'dashboard');
  console.log('    PIN: ' + (auth.usingDefaultPin ? DEFAULT_PIN + '  (default — change it in Settings)' : 'set previously'));
  console.log('');
  console.log('  Print mode : ' + config.server.printMode + (config.server.printMode === 'simulate' ? '  (safe — no hardware)' : '  (live printer)'));
  console.log('  Word→PDF   : ' + (converters.available ? 'available' : 'not available (install LibreOffice or Word)'));
  console.log('  Live driver: ' + (diag.ready ? 'ready' : 'not ready'));
  console.log('');
  console.log('  If phones cannot connect, allow Node.js through the Windows firewall');
  console.log('  for this network, then scan the QR code in the Operator Dashboard.');
  console.log('');
  console.log('  © 2026 AL SHAJAR STATIONERY. All rights reserved.');
  console.log('');

  if (OPEN_BROWSER) openBrowser(network.localUrl);
});

function openBrowser(target) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', target];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [target];
  } else {
    command = 'xdg-open';
    args = [target];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (err) { /* ignore */ }
}

function shutdown(signal) {
  console.log('\nStopping Smart Print Gateway (' + signal + ')...');
  clearInterval(cleanupTimer);
  for (const client of sseClients) {
    try { client.end(); } catch (err) { /* ignore */ }
  }
  sseClients.clear();
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('unhandledRejection', function (err) {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', function (err) {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
