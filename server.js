#!/usr/bin/env node
'use strict';

/*
 * Smart Print Gateway — zero-dependency Node.js backend
 * ----------------------------------------------------
 * Serves the customer portal and the operator console, stores incoming print
 * jobs, streams live queue updates over Server-Sent Events and hands accepted
 * jobs to the configured printer (or to the built-in simulation engine).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { loadConfig, saveConfig, publicConfig } = require('./lib/config');
const JobStore = require('./lib/store');
const Auth = require('./lib/auth');
const PrintManager = require('./lib/printers');
const { normalizeSettings, normalizeDocuments } = require('./lib/normalize');
const PrintPricing = require('./shared/pricing');
const SamplePdf = require('./shared/sample-pdf');
const {
  ensureDir, sendJson, sendText, readJsonBody, clientIp, isOpenNow,
  parsePageRange, formatBytes, RateLimiter, nowIso
} = require('./lib/util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');
const DATA_DIR = ensureDir(path.join(ROOT, 'data'));
const UPLOAD_DIR = ensureDir(path.join(DATA_DIR, 'uploads'));

const config = loadConfig(ROOT);
applyEnvOverrides(config);

const store = new JobStore(DATA_DIR, config);
const auth = new Auth(DATA_DIR, config);
const printer = new PrintManager(config, store);
const jobLimiter = new RateLimiter(60 * 60 * 1000, 80);
const assistLimiter = new RateLimiter(60 * 60 * 1000, 12);
const startedAt = Date.now();

const operatorClients = new Set();
const jobClients = new Map();

store.onChange((job, event) => {
  const publicJob = store.publicStatus(job);
  const jobSet = jobClients.get(job.id);
  if (jobSet) {
    jobSet.forEach((res) => sse(res, 'job', publicJob));
  }
  const summary = operatorSummary(job);
  operatorClients.forEach((res) => sse(res, 'job', { event: event, job: summary }));
});

setInterval(() => {
  operatorClients.forEach((res) => res.write(': ping\n\n'));
  jobClients.forEach((set) => set.forEach((res) => res.write(': ping\n\n')));
}, 25000).unref();

const server = http.createServer((req, res) => {
  const start = Date.now();
  handle(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error('  ' + req.method + ' ' + req.url + ' →', err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || 'Server error' });
    else try { res.end(); } catch (e) { /* ignore */ }
  }).finally(() => {
    if (process.env.SPG_LOG === '1') {
      console.log('  ' + req.method + ' ' + req.url.split('?')[0] + ' → ' + res.statusCode + ' (' + (Date.now() - start) + 'ms)');
    }
  });
});

function applyEnvOverrides(cfg) {
  if (!cfg.server) cfg.server = {};
  if (process.env.SPG_PORT) cfg.server.port = Number(process.env.SPG_PORT);
  if (process.env.SPG_HOST) cfg.server.host = process.env.SPG_HOST;
  if (process.env.SPG_PRINT_MODE) cfg.server.printMode = process.env.SPG_PRINT_MODE;
  const argv = process.argv.slice(2);
  argv.forEach((arg) => {
    if (arg === '--live') cfg.server.printMode = 'live';
    if (arg === '--simulate') cfg.server.printMode = 'simulate';
    if (arg.startsWith('--port=')) cfg.server.port = Number(arg.split('=')[1]);
    if (arg.startsWith('--host=')) cfg.server.host = arg.split('=')[1];
  });
}

function sse(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (err) { /* client gone */ }
}

function operatorSummary(job) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    customer: job.customer,
    documents: job.documents.map((d) => ({
      id: d.id, name: d.name, kind: d.kind, pages: d.pages, size: d.size, hasPrintReady: !!d.printReadyName
    })),
    pricing: job.pricing,
    settings: job.settings,
    warnings: job.warnings,
    queuePosition: store.queuePosition(job),
    exactImposition: job.exactImposition,
    print: job.print,
    operator: job.operator,
    history: job.history,
    source: { ip: job.source.ip, userAgent: job.source.userAgent }
  };
}

function operatorJob(job) {
  const out = operatorSummary(job);
  out.documents = job.documents.map((d) => ({
    id: d.id, name: d.name, kind: d.kind, pages: d.pages, colorPages: d.colorPages,
    size: d.size, mime: d.mime, hasPrintReady: !!d.printReadyName, printReadyPages: d.printReadyPages
  }));
  return out;
}

function requireOperator(req) {
  return auth.require(req);
}

function jobToken(req, url) {
  return url.searchParams.get('token') || req.headers['x-job-token'] || '';
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  setSecurityHeaders(res);

  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, url, pathname, method);
  }

  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(req, res, pathname, method === 'HEAD');
  }

  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
}

async function handleApi(req, res, url, pathname, method) {
  /* ---------------- Public ---------------- */

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      name: 'Smart Print Gateway',
      version: require('./package.json').version,
      shop: { name: config.shop.name, phone: config.shop.phone, address: config.shop.address },
      open: isOpenNow(config.shop.hours),
      hours: config.shop.hours,
      printMode: config.server.printMode,
      printers: (config.printers || []).filter((p) => p.enabled !== false).map((p) => ({
        id: p.id, name: p.name, location: p.location, capabilities: p.capabilities
      })),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      serverTime: nowIso()
    });
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, { ok: true, config: publicConfig(config), open: isOpenNow(config.shop.hours), serverTime: nowIso() });
  }

  if (pathname === '/api/sample.pdf' && method === 'GET') {
    const pdf = SamplePdf.build();
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.length,
      'Content-Disposition': 'inline; filename="smart-print-sample.pdf"',
      'Cache-Control': 'public, max-age=3600'
    });
    return res.end(Buffer.from(pdf));
  }

  if (pathname === '/api/jobs' && method === 'POST') {
    if (!jobLimiter.check(clientIp(req))) {
      return sendJson(res, 429, { ok: false, error: 'Too many jobs from this device. Please ask the counter for help.' });
    }
    const maxMb = Number(config.server.maxJobMB) || 180;
    const body = await readJsonBody(req, Math.round(maxMb * 1.45 * 1024 * 1024) + 2 * 1024 * 1024);
    return createJob(req, res, body);
  }

  let m = pathname.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (m && method === 'GET') {
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (jobToken(req, url) !== job.token) return sendJson(res, 403, { ok: false, error: 'Invalid job token' });
    const status = store.publicStatus(job);
    status.printerName = (printer.printerFor(job) || {}).name || '';
    status.printMode = config.server.printMode;
    return sendJson(res, 200, { ok: true, job: status, shop: config.shop });
  }

  m = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (m && method === 'GET') {
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (jobToken(req, url) !== job.token) return sendJson(res, 403, { ok: false, error: 'Invalid job token' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    sse(res, 'job', store.publicStatus(job));
    const set = jobClients.get(job.id) || new Set();
    set.add(res);
    jobClients.set(job.id, set);
    req.on('close', () => {
      set.delete(res);
      if (!set.size) jobClients.delete(job.id);
    });
    return;
  }

  m = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (m && method === 'POST') {
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (jobToken(req, url) !== job.token) return sendJson(res, 403, { ok: false, error: 'Invalid job token' });
    if (job.status !== 'pending') return sendJson(res, 409, { ok: false, error: 'This job is already in progress. Please speak to the counter.' });
    store.update(job.id, { status: 'cancelled' }, { event: 'cancelled', message: 'Cancelled by customer before acceptance.', actor: 'customer' });
    return sendJson(res, 200, { ok: true, job: store.publicStatus(store.get(job.id)) });
  }

  m = pathname.match(/^\/api\/jobs\/([^/]+)\/assist$/);
  if (m && method === 'POST') {
    if (!assistLimiter.check(clientIp(req))) return sendJson(res, 429, { ok: false, error: 'Please ask the counter directly.' });
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (jobToken(req, url) !== job.token) return sendJson(res, 403, { ok: false, error: 'Invalid job token' });
    store.update(job.id, {}, { event: 'assist', message: 'Customer requested assistance at the counter.', actor: 'customer' });
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- Auth ---------------- */

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody(req, 64 * 1024);
    const result = auth.login(body.pin, clientIp(req));
    return sendJson(res, 200, { ok: true, token: result.token, expiresAt: result.expiresAt, defaultPin: auth.isDefaultPin() });
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    requireOperator(req);
    return sendJson(res, 200, { ok: true, defaultPin: auth.isDefaultPin(), shop: config.shop });
  }

  if (pathname === '/api/auth/pin' && method === 'POST') {
    requireOperator(req);
    const body = await readJsonBody(req, 64 * 1024);
    const result = auth.changePin(body.currentPin, body.newPin);
    return sendJson(res, 200, { ok: true, token: result.token, expiresAt: result.expiresAt });
  }

  /* ---------------- Operator ---------------- */

  if (pathname === '/api/operator/events' && method === 'GET') {
    requireOperator(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    operatorClients.add(res);
    sse(res, 'hello', { ok: true, stats: store.stats() });
    req.on('close', () => operatorClients.delete(res));
    return;
  }

  if (pathname === '/api/operator/jobs' && method === 'GET') {
    requireOperator(req);
    const jobs = store.list({
      status: url.searchParams.get('status') || 'all',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit') || 200
    }).map(operatorSummary);
    return sendJson(res, 200, { ok: true, jobs: jobs, stats: store.stats() });
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)$/);
  if (m && method === 'GET') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    return sendJson(res, 200, { ok: true, job: operatorJob(job), diagnostics: printer.diagnostics() });
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)\/files\/([^/]+)$/);
  if (m && method === 'GET') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    const kind = url.searchParams.get('kind') === 'printReady' ? 'printReady' : 'original';
    const info = store.filePath(job, m[2], kind);
    if (!info) return sendJson(res, 404, { ok: false, error: 'File not found' });
    const stat = fs.statSync(info.path);
    res.writeHead(200, {
      'Content-Type': info.mime || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': 'inline; filename="' + encodeURIComponent(info.name) + '"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(info.path).pipe(res);
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)\/accept$/);
  if (m && method === 'POST') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (!['pending', 'failed'].includes(job.status)) {
      return sendJson(res, 409, { ok: false, error: 'Job is ' + job.status + ' and cannot be accepted.' });
    }
    const body = await readJsonBody(req, 64 * 1024);
    const printerId = body.printerId || config.server.defaultPrinterId;
    const chosen = (config.printers || []).find((p) => p.id === printerId && p.enabled !== false);
    if (!chosen) return sendJson(res, 400, { ok: false, error: 'Unknown or disabled printer' });
    if (job.settings.canon.colorMode === 'auto' && !(chosen.capabilities || []).includes('color')) {
      job.settings.canon.colorMode = 'grayscale';
    }
    const updated = store.update(job.id, {
      status: 'accepted',
      settings: job.settings,
      operator: Object.assign({}, job.operator, {
        acceptedAt: nowIso(),
        rejectedAt: null,
        reason: '',
        note: String(body.note || '').slice(0, 500),
        printerId: chosen.id
      }),
      print: Object.assign({}, job.print, { error: '', progress: 0, printerName: chosen.name })
    }, { event: 'accepted', message: 'Accepted by operator on ' + chosen.name + '.', actor: 'operator' });
    sendJson(res, 200, { ok: true, job: operatorJob(updated) });
    printer.enqueue(updated);
    return;
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)\/reject$/);
  if (m && method === 'POST') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (['completed', 'printing'].includes(job.status)) {
      return sendJson(res, 409, { ok: false, error: 'Job is already ' + job.status + '.' });
    }
    const body = await readJsonBody(req, 64 * 1024);
    const reason = String(body.reason || body.note || 'Rejected by operator').slice(0, 300);
    const updated = store.update(job.id, {
      status: 'rejected',
      operator: Object.assign({}, job.operator, {
        rejectedAt: nowIso(),
        reason: reason,
        note: String(body.note || '').slice(0, 500)
      })
    }, { event: 'rejected', message: 'Rejected: ' + reason, actor: 'operator' });
    return sendJson(res, 200, { ok: true, job: operatorJob(updated) });
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)\/reprint$/);
  if (m && method === 'POST') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (!['completed', 'failed', 'rejected'].includes(job.status)) {
      return sendJson(res, 409, { ok: false, error: 'Only completed, failed or rejected jobs can be reprinted.' });
    }
    const body = await readJsonBody(req, 64 * 1024);
    const printerId = body.printerId || job.operator.printerId || config.server.defaultPrinterId;
    const chosen = (config.printers || []).find((p) => p.id === printerId && p.enabled !== false);
    if (!chosen) return sendJson(res, 400, { ok: false, error: 'Unknown or disabled printer' });
    const updated = store.update(job.id, {
      status: 'accepted',
      operator: Object.assign({}, job.operator, {
        acceptedAt: nowIso(), printerId: chosen.id, rejectedAt: null, reason: '',
        note: String(body.note || job.operator.note || '').slice(0, 500)
      }),
      print: Object.assign({}, job.print, { error: '', progress: 0, finishedAt: null })
    }, { event: 'accepted', message: 'Reprint queued on ' + chosen.name + '.', actor: 'operator' });
    sendJson(res, 200, { ok: true, job: operatorJob(updated) });
    printer.enqueue(updated);
    return;
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)\/complete$/);
  if (m && method === 'POST') {
    requireOperator(req);
    const job = store.get(m[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'Job not found' });
    if (!['accepted', 'printing'].includes(job.status)) {
      return sendJson(res, 409, { ok: false, error: 'Job is not active.' });
    }
    const updated = store.update(job.id, {
      status: 'completed',
      operator: Object.assign({}, job.operator, { completedAt: nowIso() }),
      print: Object.assign({}, job.print, { progress: 100, finishedAt: nowIso() })
    }, { event: 'completed', message: 'Marked complete by operator.', actor: 'operator' });
    return sendJson(res, 200, { ok: true, job: operatorJob(updated) });
  }

  m = pathname.match(/^\/api\/operator\/jobs\/([^/]+)$/);
  if (m && method === 'DELETE') {
    requireOperator(req);
    const ok = store.delete(m[1]);
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { ok: false, error: 'Job not found' });
  }

  if (pathname === '/api/operator/stats' && method === 'GET') {
    requireOperator(req);
    return sendJson(res, 200, { ok: true, stats: store.stats(), diagnostics: printer.diagnostics() });
  }

  if (pathname === '/api/operator/settings' && method === 'GET') {
    requireOperator(req);
    return sendJson(res, 200, {
      ok: true,
      config: publicConfig(config),
      server: config.server,
      shop: config.shop,
      pricing: config.pricing,
      printers: config.printers,
      features: config.features,
      diagnostics: printer.diagnostics(),
      defaultPin: auth.isDefaultPin(),
      data: { uploadBytes: store.dataSize(), jobs: store.jobs.length, dataDir: DATA_DIR }
    });
  }

  if (pathname === '/api/operator/settings' && method === 'PUT') {
    requireOperator(req);
    const body = await readJsonBody(req, 2 * 1024 * 1024);
    updateSettings(body);
    return sendJson(res, 200, { ok: true, config: publicConfig(config), server: config.server, shop: config.shop, pricing: config.pricing, printers: config.printers, features: config.features });
  }

  if (pathname === '/api/operator/diagnostics' && method === 'GET') {
    requireOperator(req);
    return sendJson(res, 200, {
      ok: true,
      diagnostics: printer.diagnostics(),
      server: {
        node: process.version, platform: process.platform, arch: process.arch,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        dataDir: DATA_DIR, uploadBytes: store.dataSize(), jobs: store.jobs.length,
        maxFileMB: config.server.maxFileMB, maxJobMB: config.server.maxJobMB,
        retentionDays: config.server.retentionDays, printMode: config.server.printMode
      },
      defaultPin: auth.isDefaultPin()
    });
  }

  if (pathname === '/api/operator/export.csv' && method === 'GET') {
    requireOperator(req);
    const rows = [['Job', 'Created', 'Status', 'Customer', 'Phone', 'Documents', 'Pages', 'Sides', 'Copies', 'Total', 'Currency', 'Printer', 'Mode']];
    store.jobs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).forEach((j) => {
      rows.push([
        j.id, j.createdAt, j.status, j.customer.name, j.customer.phone,
        j.documents.map((d) => d.name).join(' | '), j.pricing.pages, j.pricing.sides,
        j.pricing.copies, j.pricing.total, j.pricing.currency,
        (j.operator && j.operator.printerId) || '', j.print.mode
      ]);
    });
    const csv = rows.map((r) => r.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="smart-print-jobs-' + new Date().toISOString().slice(0, 10) + '.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end('\uFEFF' + csv);
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
}

function createJob(req, res, body) {
  const settings = normalizeSettings(body.settings, config);
  const documents = normalizeDocuments(body.documents, 5000).filter((d) => d.data);
  if (!documents.length) return sendJson(res, 400, { ok: false, error: 'No documents supplied' });
  if (documents.length > 12) return sendJson(res, 400, { ok: false, error: 'Maximum 12 documents per job' });

  const customer = body.customer || {};
  if (config.features && config.features.requireCustomerName && !String(customer.name || '').trim()) {
    return sendJson(res, 400, { ok: false, error: 'Please enter your name so we can match the job at the counter.' });
  }

  const maxMb = Number(config.server.maxJobMB) || 180;
  const totalBytes = documents.reduce((sum, d) => {
    const original = d.data ? d.data.length * 0.75 : 0;
    const ready = d.printReadyData ? d.printReadyData.length * 0.75 : 0;
    return sum + original + ready;
  }, 0);
  if (totalBytes > maxMb * 1024 * 1024) {
    return sendJson(res, 413, { ok: false, error: 'This job is too large. Limit is ' + formatBytes(maxMb * 1024 * 1024) + '.' });
  }

  // Apply the page range per document and drop documents whose range selects nothing.
  documents.forEach((doc) => {
    let selected = doc.pages;
    if (settings.pageRangeType === 'custom') {
      const parsed = parsePageRange(settings.pageRange, doc.pages);
      selected = parsed.pages.length;
      if (!selected) selected = 0;
    } else if (settings.pageRangeType === 'current') {
      selected = 1;
    }
    doc.selectedPages = selected;
  });
  const usable = documents.filter((d) => d.selectedPages > 0);
  if (!usable.length) return sendJson(res, 400, { ok: false, error: 'The page range does not match any pages in the documents.' });

  const pricing = PrintPricing.calculate({
    documents: usable.map((d) => ({ pages: d.selectedPages, colorPages: Math.min(d.colorPages, d.selectedPages), pageW: d.pageW, pageH: d.pageH })),
    settings: settings,
    pricing: config.pricing
  });

  const warnings = (Array.isArray(body.warnings) ? body.warnings : []).slice(0, 40).map((w) => ({
    level: ['error', 'warn', 'info'].includes(w.level) ? w.level : 'info',
    message: String(w.message || '').slice(0, 300),
    hint: String(w.hint || '').slice(0, 300),
    code: String(w.code || '').slice(0, 40)
  }));

  const job = store.create({
    customer: customer,
    settings: settings,
    documents: usable,
    pricing: pricing,
    clientEstimate: body.clientEstimate && typeof body.clientEstimate === 'object' ? {
      total: Number(body.clientEstimate.total) || 0,
      pages: Number(body.clientEstimate.pages) || 0,
      sides: Number(body.clientEstimate.sides) || 0
    } : null,
    warnings: warnings,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || ''
  });

  const status = store.publicStatus(job);
  status.printerName = (printer.printerFor(job) || {}).name || '';
  status.printMode = config.server.printMode;
  return sendJson(res, 201, {
    ok: true,
    job: status,
    shop: config.shop,
    token: job.token,
    pricing: job.pricing,
    estimateMinutes: job.pricing.estimatedMinutes,
    queuePosition: store.queuePosition(job)
  });
}

function updateSettings(body) {
  const shop = body.shop || {};
  const pricing = body.pricing || {};
  const server = body.server || {};
  const features = body.features || {};

  if (shop.name !== undefined) config.shop.name = String(shop.name).slice(0, 120);
  if (shop.phone !== undefined) config.shop.phone = String(shop.phone).slice(0, 60);
  if (shop.whatsapp !== undefined) config.shop.whatsapp = String(shop.whatsapp).slice(0, 60);
  if (shop.address !== undefined) config.shop.address = String(shop.address).slice(0, 240);
  if (shop.welcome !== undefined) config.shop.welcome = String(shop.welcome).slice(0, 500);
  if (shop.paymentNote !== undefined) config.shop.paymentNote = String(shop.paymentNote).slice(0, 300);
  if (shop.pickupNote !== undefined) config.shop.pickupNote = String(shop.pickupNote).slice(0, 300);
  if (shop.hours && typeof shop.hours === 'object') {
    config.shop.hours = Object.assign({}, config.shop.hours, {
      open: String(shop.hours.open || config.shop.hours.open).slice(0, 5),
      close: String(shop.hours.close || config.shop.hours.close).slice(0, 5),
      timezone: String(shop.hours.timezone || config.shop.hours.timezone).slice(0, 60)
    });
  }

  if (pricing.vatPercent !== undefined) config.pricing.vatPercent = Math.min(50, Math.max(0, Number(pricing.vatPercent) || 0));
  if (pricing.minimumCharge !== undefined) config.pricing.minimumCharge = Math.max(0, Number(pricing.minimumCharge) || 0);
  if (pricing.rates && typeof pricing.rates === 'object') {
    const r = pricing.rates;
    const target = config.pricing.rates;
    ['bwPerA4Side', 'colorPerA4Side', 'duplexFactor'].forEach((k) => {
      if (r[k] !== undefined) target[k] = Math.max(0, Number(r[k]) || 0);
    });
    if (target.duplexFactor > 1) target.duplexFactor = 1;
    ['sizeMultipliers', 'paperMultipliers', 'finishing', 'extras'].forEach((group) => {
      if (r[group] && typeof r[group] === 'object') {
        Object.keys(r[group]).forEach((k) => {
          if (target[group][k] !== undefined) target[group][k] = Math.max(0, Number(r[group][k]) || 0);
        });
      }
    });
  }

  if (server.printMode !== undefined) {
    if (!['simulate', 'live'].includes(server.printMode)) {
      const err = new Error('printMode must be "simulate" or "live"'); err.status = 400; throw err;
    }
    config.server.printMode = server.printMode;
  }
  if (server.defaultPrinterId !== undefined) config.server.defaultPrinterId = String(server.defaultPrinterId);
  if (server.retentionDays !== undefined) config.server.retentionDays = Math.min(3650, Math.max(1, Number(server.retentionDays) || 30));
  if (server.maxFileMB !== undefined) config.server.maxFileMB = Math.min(500, Math.max(1, Number(server.maxFileMB) || 60));
  if (server.maxJobMB !== undefined) config.server.maxJobMB = Math.min(1000, Math.max(1, Number(server.maxJobMB) || 180));
  if (server.sumatraPath !== undefined) config.server.sumatraPath = String(server.sumatraPath).slice(0, 500);
  if (server.sofficePath !== undefined) config.server.sofficePath = String(server.sofficePath).slice(0, 500);
  if (server.lpPath !== undefined) config.server.lpPath = String(server.lpPath).slice(0, 500);

  if (Array.isArray(body.printers)) {
    config.printers = body.printers.slice(0, 10).map((p, i) => ({
      id: String(p.id || 'printer-' + (i + 1)).replace(/[^a-z0-9-_]/gi, '').slice(0, 40),
      name: String(p.name || 'Printer ' + (i + 1)).slice(0, 80),
      model: String(p.model || '').slice(0, 100),
      systemName: String(p.systemName || p.name || '').slice(0, 120),
      location: String(p.location || '').slice(0, 100),
      capabilities: Array.isArray(p.capabilities) ? p.capabilities.slice(0, 12).map((c) => String(c).slice(0, 20)) : ['color', 'duplex'],
      enabled: p.enabled !== false
    }));
  }

  ['exactImposition', 'colorDetection', 'chatbot', 'showPrices', 'allowRush', 'allowLamination', 'requireCustomerName'].forEach((k) => {
    if (features[k] !== undefined) config.features[k] = !!features[k];
  });

  if (config.features && config.features.allowRush === false) config.features.allowRush = false;

  saveConfig(config);
  printer.config = config;
  auth.config = config;
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
}

function serveStatic(req, res, pathname, headOnly) {
  let filePath;
  if (pathname === '/' || pathname === '/index.html') filePath = path.join(PUBLIC_DIR, 'index.html');
  else if (pathname === '/dashboard' || pathname === '/dashboard/' || pathname === '/dashboard.html') filePath = path.join(PUBLIC_DIR, 'dashboard.html');
  else if (pathname.startsWith('/shared/')) {
    const name = pathname.replace('/shared/', '');
    if (!/^[a-z0-9._-]+$/i.test(name)) return sendText(res, 404, 'Not found');
    filePath = path.join(SHARED_DIR, name);
  } else {
    const rel = pathname.replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.includes('\0')) return sendText(res, 404, 'Not found');
    filePath = path.join(PUBLIC_DIR, rel);
  }

  const resolved = path.resolve(filePath);
  const allowed = resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep) || resolved.startsWith(path.resolve(SHARED_DIR) + path.sep);
  if (!allowed) return sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendText(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;background:#0b1220;color:#e6edf7;padding:48px"><h1>404</h1><p>This page does not exist. <a style="color:#60a5fa" href="/">Return to the print portal</a>.</p></body>', 'text/html; charset=utf-8');
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = require('./lib/util').MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(resolved);
  const isVendor = resolved.includes(path.sep + 'vendor' + path.sep) || resolved.includes(path.sep + 'fonts' + path.sep);
  const cache = isVendor ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-store' : 'no-cache';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff'
  });
  if (headOnly) return res.end();
  fs.createReadStream(resolved).pipe(res);
}

function lanUrls(port) {
  const urls = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) urls.push('http://' + net.address + ':' + port);
    });
  });
  return urls;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  Port ' + config.server.port + ' is already in use. Stop the other server or set SPG_PORT.\n');
    process.exit(1);
  }
  throw err;
});

server.listen(config.server.port, config.server.host, () => {
  const port = config.server.port;
  const local = 'http://localhost:' + port;
  const lan = lanUrls(port);
  const line = '─'.repeat(64);
  console.log('\n' + line);
  console.log('  SMART PRINT GATEWAY  v' + require('./package.json').version);
  console.log('  ' + config.shop.name);
  console.log(line);
  console.log('  Customer portal   ' + local + '/');
  console.log('  Operator console  ' + local + '/dashboard');
  if (lan.length) console.log('  On the shop LAN   ' + lan.join('  '));
  console.log(line);
  console.log('  Print mode        ' + config.server.printMode.toUpperCase() + (config.server.printMode === 'simulate' ? '  (safe demo — no hardware)' : ''));
  console.log('  Data folder       ' + DATA_DIR);
  console.log('  Keep this window open while the shop is operating.');
  console.log(line + '\n');

  if (process.argv.includes('--open') || process.env.SPG_OPEN === '1') {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', local + '/dashboard'] : [local + '/dashboard'];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch (err) { /* ignore */ }
  }
});

function shutdown() {
  console.log('\n  Shutting down Smart Print Gateway…');
  operatorClients.forEach((res) => { try { res.end(); } catch (e) { /* ignore */ } });
  jobClients.forEach((set) => set.forEach((res) => { try { res.end(); } catch (e) { /* ignore */ } }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('  Unhandled rejection:', err));
