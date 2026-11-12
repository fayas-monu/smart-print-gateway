/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Local JSON job store and upload storage. (AL SHAJAR TEAM)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJsonAtomic, randomId, removeDir } = require('./util');

class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'jobs.json');
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.jobs = new Map();
    ensureDir(this.dataDir);
    ensureDir(this.uploadsDir);
    this.load();
  }

  load() {
    let raw = readJson(this.filePath, null);
    if (!raw && fs.existsSync(this.filePath + '.bak')) {
      raw = readJson(this.filePath + '.bak', null);
    }
    const list = Array.isArray(raw) ? raw : [];
    this.jobs = new Map();
    list.forEach(function (job) {
      if (job && job.id) this.jobs.set(job.id, job);
    }, this);
    if (!fs.existsSync(this.filePath)) this.save();
  }

  save() {
    writeJsonAtomic(this.filePath, Array.from(this.jobs.values()));
  }

  newId() {
    const date = new Date();
    const yy = String(date.getFullYear()).slice(-2);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    let id;
    let attempts = 0;
    do {
      id = 'SHS-' + yy + mm + dd + '-' + randomId(4);
      attempts += 1;
    } while (this.jobs.has(id) && attempts < 50);
    return id;
  }

  create(job) {
    if (!job || !job.id) throw new Error('A job id is required.');
    if (this.jobs.has(job.id)) throw new Error('Job id already exists.');
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  get(id) {
    return this.jobs.get(String(id || '')) || null;
  }

  update(id, patch) {
    const job = this.get(id);
    if (!job) return null;
    Object.assign(job, patch || {});
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  all() {
    return Array.from(this.jobs.values());
  }

  remove(id) {
    const job = this.get(id);
    if (!job) return false;
    this.jobs.delete(job.id);
    this.save();
    removeDir(this.jobDir(job.id));
    return true;
  }

  jobDir(id) {
    return path.join(this.uploadsDir, String(id));
  }

  ensureJobDir(id) {
    const dir = this.jobDir(id);
    ensureDir(dir);
    return dir;
  }

  cleanup(retentionDays) {
    const days = Math.max(1, Number(retentionDays) || 30);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const removable = ['completed', 'rejected', 'cancelled', 'failed'];
    let removed = 0;
    this.all().forEach(function (job) {
      if (removable.indexOf(job.status) < 0) return;
      const stamped = Date.parse(job.updatedAt || job.createdAt || 0);
      if (!Number.isFinite(stamped) || stamped > cutoff) return;
      this.jobs.delete(job.id);
      removeDir(this.jobDir(job.id));
      removed += 1;
    }, this);
    if (removed) this.save();
    return removed;
  }

  totalBytes() {
    function walk(dir) {
      let total = 0;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { return 0; }
      entries.forEach(function (entry) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += walk(full);
        else {
          try { total += fs.statSync(full).size; } catch (err) { /* ignore */ }
        }
      });
      return total;
    }
    return walk(this.dataDir);
  }
}

module.exports = { JobStore };
