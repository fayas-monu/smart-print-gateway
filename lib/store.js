'use strict';

const fs = require('fs');
const path = require('path');
const {
  ensureDir, readJson, writeJsonAtomic, id, jobNumber, nowIso, sanitizeFilename,
  extOf, validateUpload, formatBytes
} = require('./util');

const STATUSES = ['pending', 'accepted', 'printing', 'completed', 'rejected', 'failed', 'cancelled'];

class JobStore {
  constructor(dataDir, config) {
    this.dataDir = dataDir;
    this.config = config;
    this.jobsFile = path.join(dataDir, 'jobs.json');
    this.metaFile = path.join(dataDir, 'meta.json');
    this.uploadDir = path.join(dataDir, 'uploads');
    ensureDir(this.uploadDir);
    this.jobs = readJson(this.jobsFile, []);
    if (!Array.isArray(this.jobs)) this.jobs = [];
    this.meta = readJson(this.metaFile, { seq: 0 });
    this.listeners = new Set();
    this._recoverInterrupted();
    this.cleanup();
    setInterval(() => this.cleanup(), 6 * 60 * 60 * 1000).unref();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(job, event) {
    this.listeners.forEach((fn) => {
      try { fn(job, event); } catch (err) { console.error('listener error', err); }
    });
  }

  _persist() {
    writeJsonAtomic(this.jobsFile, this.jobs);
    writeJsonAtomic(this.metaFile, this.meta);
  }

  _recoverInterrupted() {
    let changed = false;
    this.jobs.forEach((job) => {
      if (job.status === 'printing') {
        job.status = 'failed';
        job.print = Object.assign({}, job.print, {
          finishedAt: nowIso(),
          error: 'Server restarted while the job was printing. Check the printer, then retry.'
        });
        job.updatedAt = nowIso();
        job.history.push({ at: nowIso(), type: 'failed', message: 'Server restarted during printing — marked for retry.', actor: 'system' });
        changed = true;
      }
    });
    if (changed) this._persist();
  }

  cleanup() {
    const days = Number(this.config.server && this.config.server.retentionDays) || 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const keep = [];
    const remove = [];
    this.jobs.forEach((job) => {
      const t = new Date(job.createdAt).getTime();
      if (t < cutoff) remove.push(job); else keep.push(job);
    });
    if (!remove.length) return;
    this.jobs = keep;
    this._persist();
    remove.forEach((job) => {
      try { fs.rmSync(path.join(this.uploadDir, job.id), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    });
    console.log('  Cleaned up ' + remove.length + ' expired job' + (remove.length === 1 ? '' : 's') + '.');
  }

  _nextId() {
    this.meta.seq = (Number(this.meta.seq) || 0) + 1;
    let candidate = jobNumber(this.meta.seq, new Date());
    while (this.jobs.some((j) => j.id === candidate)) {
      this.meta.seq += 1;
      candidate = jobNumber(this.meta.seq, new Date());
    }
    return candidate;
  }

  create(input) {
    const jobId = this._nextId();
    const dir = ensureDir(path.join(this.uploadDir, jobId));
    const docs = [];
    const maxFileBytes = (Number(this.config.server && this.config.server.maxFileMB) || 60) * 1024 * 1024;

    try {
      input.documents.forEach((doc, index) => {
        if (!doc.data) throw Object.assign(new Error('Missing file data for ' + doc.name), { status: 400 });
        const bytes = Buffer.from(doc.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (!bytes.length) throw Object.assign(new Error('Empty file: ' + doc.name), { status: 400 });
        if (bytes.length > maxFileBytes) {
          throw Object.assign(new Error(doc.name + ' is larger than the ' + formatBytes(maxFileBytes) + ' limit'), { status: 413 });
        }
        const check = validateUpload(bytes, doc.name, doc.mime);
        if (!check.ok) {
          throw Object.assign(new Error('Unsupported or corrupted file: ' + doc.name), { status: 415 });
        }
        const docId = id(8);
        const ext = extOf(doc.name) || (check.kind === 'pdf' ? '.pdf' : check.kind === 'image' ? '.img' : '');
        const storedName = docId + ext;
        fs.writeFileSync(path.join(dir, storedName), bytes);

        let printReadyName = null;
        if (doc.printReadyData) {
          const prBytes = Buffer.from(doc.printReadyData.replace(/^data:[^;]+;base64,/, ''), 'base64');
          if (prBytes.length >= 4 && prBytes.subarray(0, 4).toString('latin1') === '%PDF') {
            printReadyName = docId + '.printready.pdf';
            fs.writeFileSync(path.join(dir, printReadyName), prBytes);
          }
        }

        docs.push({
          id: docId,
          name: sanitizeFilename(doc.name),
          storedName: storedName,
          printReadyName: printReadyName,
          mime: doc.mime,
          kind: doc.kind,
          size: bytes.length,
          pages: doc.pages,
          colorPages: doc.colorPages,
          printReadyPages: printReadyName ? doc.printReadyPages : 0
        });
      });

      const customer = input.customer || {};
      const job = {
        id: jobId,
        token: id(24),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: 'pending',
        customer: {
          name: String(customer.name || 'Walk-in customer').slice(0, 120),
          phone: String(customer.phone || '').slice(0, 40),
          email: String(customer.email || '').slice(0, 120),
          note: String(customer.note || '').slice(0, 1000),
          payment: ['counter', 'card', 'cash'].includes(customer.payment) ? customer.payment : 'counter'
        },
        documents: docs,
        settings: input.settings,
        pricing: input.pricing,
        clientEstimate: input.clientEstimate || null,
        warnings: Array.isArray(input.warnings) ? input.warnings.slice(0, 40) : [],
        exactImposition: !!input.settings.exactImposition,
        operator: { acceptedAt: null, rejectedAt: null, completedAt: null, reason: '', note: '', printerId: null },
        print: { mode: (this.config.server && this.config.server.printMode) || 'simulate', progress: 0, attempts: 0, startedAt: null, finishedAt: null, error: '', output: '' },
        history: [{ at: nowIso(), type: 'created', message: 'Job received from customer portal.', actor: 'customer' }],
        source: {
          ip: input.ip || '',
          userAgent: String(input.userAgent || '').slice(0, 300)
        }
      };
      this.jobs.push(job);
      this._persist();
      this._emit(job, 'created');
      return job;
    } catch (err) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      throw err;
    }
  }

  get(jobId) {
    return this.jobs.find((j) => j.id === jobId) || null;
  }

  list(filters) {
    const f = filters || {};
    let list = this.jobs.slice();
    if (f.status && f.status !== 'all') {
      if (f.status === 'active') list = list.filter((j) => ['pending', 'accepted', 'printing'].includes(j.status));
      else list = list.filter((j) => j.status === f.status);
    }
    if (f.q) {
      const q = String(f.q).toLowerCase();
      list = list.filter((j) =>
        j.id.toLowerCase().includes(q) ||
        (j.customer.name || '').toLowerCase().includes(q) ||
        (j.customer.phone || '').toLowerCase().includes(q) ||
        j.documents.some((d) => d.name.toLowerCase().includes(q))
      );
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const limit = Math.min(Number(f.limit) || 200, 500);
    return list.slice(0, limit);
  }

  update(jobId, changes, meta) {
    const job = this.get(jobId);
    if (!job) return null;
    const m = meta || {};
    Object.assign(job, changes);
    job.updatedAt = nowIso();
    if (m.message) {
      job.history.push({
        at: job.updatedAt,
        type: m.event || 'update',
        message: m.message,
        actor: m.actor || 'system'
      });
      if (job.history.length > 100) job.history = job.history.slice(-100);
    }
    this._persist();
    this._emit(job, m.event || 'updated');
    return job;
  }

  setStatus(jobId, status, meta) {
    if (!STATUSES.includes(status)) throw new Error('Invalid status');
    const job = this.get(jobId);
    if (!job) return null;
    job.status = status;
    return this.update(jobId, {}, meta);
  }

  queuePosition(job) {
    if (!job || job.status !== 'pending') return 0;
    const earlier = this.jobs.filter((j) => j.status === 'pending' && new Date(j.createdAt) < new Date(job.createdAt));
    return earlier.length + 1;
  }

  publicStatus(job) {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      customer: { name: job.customer.name, phone: job.customer.phone },
      pricing: job.pricing,
      documents: job.documents.map((d) => ({ name: d.name, pages: d.pages, kind: d.kind })),
      settings: {
        copies: job.settings.canon.copies,
        colorMode: job.settings.canon.colorMode,
        pageSize: job.settings.canon.pageSize,
        printStyle: job.settings.canon.printStyle,
        sizingMode: job.settings.sizingMode
      },
      queuePosition: this.queuePosition(job),
      operator: { note: job.operator.note, reason: job.operator.reason, acceptedAt: job.operator.acceptedAt },
      print: { progress: job.print.progress, error: job.print.error },
      history: job.history.filter((h) => ['created', 'accepted', 'rejected', 'printing', 'completed', 'failed', 'cancelled'].includes(h.type)),
      estimateMinutes: job.pricing ? job.pricing.estimatedMinutes : 0
    };
  }

  delete(jobId) {
    const idx = this.jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return false;
    const [job] = this.jobs.splice(idx, 1);
    this._persist();
    try { fs.rmSync(path.join(this.uploadDir, job.id), { recursive: true, force: true }); } catch (err) { /* ignore */ }
    this._emit(job, 'deleted');
    return true;
  }

  stats() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const today = this.jobs.filter((j) => new Date(j.createdAt).getTime() >= startOfDay);
    const completed = today.filter((j) => j.status === 'completed');
    const active = this.jobs.filter((j) => ['pending', 'accepted', 'printing'].includes(j.status));
    const revenue = completed.reduce((sum, j) => sum + (Number(j.pricing && j.pricing.total) || 0), 0);
    const pages = today.reduce((sum, j) => sum + (Number(j.pricing && j.pricing.sides) || 0), 0);
    const waits = today
      .filter((j) => j.operator.acceptedAt)
      .map((j) => (new Date(j.operator.acceptedAt) - new Date(j.createdAt)) / 60000);
    const avgWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;

    const series = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
      const dayJobs = this.jobs.filter((j) => {
        const t = new Date(j.createdAt).getTime();
        return t >= day.getTime() && t < next.getTime();
      });
      series.push({
        date: day.toISOString().slice(0, 10),
        label: day.toLocaleDateString('en-GB', { weekday: 'short' }),
        jobs: dayJobs.length,
        revenue: dayJobs.filter((j) => j.status === 'completed').reduce((s, j) => s + (Number(j.pricing && j.pricing.total) || 0), 0),
        pages: dayJobs.reduce((s, j) => s + (Number(j.pricing && j.pricing.sides) || 0), 0)
      });
    }

    const paperCounts = {};
    this.jobs.forEach((j) => {
      const k = (j.settings && j.settings.canon && j.settings.canon.pageSize) || 'A4';
      paperCounts[k] = (paperCounts[k] || 0) + 1;
    });

    const recent = [];
    this.jobs.slice(-60).forEach((j) => {
      j.history.slice(-4).forEach((h) => {
        recent.push({ jobId: j.id, at: h.at, type: h.type, message: h.message, actor: h.actor, customer: j.customer.name });
      });
    });
    recent.sort((a, b) => new Date(b.at) - new Date(a.at));

    return {
      today: {
        jobs: today.length,
        completed: completed.length,
        revenue: Math.round(revenue * 1000) / 1000,
        pages: pages,
        avgWaitMinutes: Math.round(avgWait * 10) / 10
      },
      active: active.length,
      pending: this.jobs.filter((j) => j.status === 'pending').length,
      printing: this.jobs.filter((j) => j.status === 'printing').length,
      totalJobs: this.jobs.length,
      series: series,
      paperCounts: paperCounts,
      recent: recent.slice(0, 18)
    };
  }

  filePath(job, docId, kind) {
    const doc = job.documents.find((d) => d.id === docId);
    if (!doc) return null;
    const name = kind === 'printReady' ? doc.printReadyName : doc.storedName;
    if (!name) return null;
    const full = path.join(this.uploadDir, job.id, name);
    if (!full.startsWith(path.join(this.uploadDir, job.id))) return null;
    if (!fs.existsSync(full)) return null;
    return { path: full, name: kind === 'printReady' ? 'print-ready.pdf' : doc.name, mime: kind === 'printReady' ? 'application/pdf' : doc.mime };
  }

  dataSize() {
    try {
      let total = 0;
      const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p); else total += fs.statSync(p).size;
        });
      };
      walk(this.uploadDir);
      return total;
    } catch (err) { return 0; }
  }
}

module.exports = JobStore;
