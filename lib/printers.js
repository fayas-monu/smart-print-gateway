'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { nowIso, parsePageRange, ensureDir } = require('./util');

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (err) { return false; }
}

function which(cmd) {
  try {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(tool, [cmd], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    return out.split(/\r?\n/)[0] || '';
  } catch (err) { return ''; }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function plural(n, word) {
  return n + ' ' + word + (Number(n) === 1 ? '' : 's');
}

class PrintManager {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.queue = Promise.resolve();
    this.tools = this.detect();
  }

  detect() {
    const cfg = this.config.server || {};
    const env = process.env;
    const candidates = {
      sumatra: [
        cfg.sumatraPath, env.SUMATRA_PATH,
        'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
        'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
        path.join(env.LOCALAPPDATA || '', 'SumatraPDF', 'SumatraPDF.exe'),
        path.join(env.USERPROFILE || '', 'scoop', 'apps', 'sumatrapdf', 'current', 'SumatraPDF.exe')
      ].filter(Boolean),
      soffice: [
        cfg.sofficePath, env.SOFFICE_PATH,
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        '/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'
      ].filter(Boolean),
      lp: [cfg.lpPath, env.LP_PATH, '/usr/bin/lp', '/usr/local/bin/lp'].filter(Boolean),
      powershell: [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        which('powershell.exe'), which('pwsh')
      ].filter(Boolean)
    };
    const found = {};
    Object.keys(candidates).forEach((key) => {
      found[key] = candidates[key].find(exists) || (key === 'lp' ? which('lp') : '') || '';
    });
    return {
      platform: process.platform,
      sumatra: found.sumatra,
      soffice: found.soffice,
      lp: found.lp,
      powershell: found.powershell,
      mode: (this.config.server && this.config.server.printMode) || 'simulate'
    };
  }

  diagnostics() {
    const t = this.detect();
    this.tools = t;
    return {
      platform: t.platform,
      mode: t.mode,
      sumatra: t.sumatra || null,
      libreOffice: t.soffice || null,
      cupsLp: t.lp || null,
      powershell: t.powershell || null,
      canPrintPdf: !!(t.sumatra || t.lp || t.powershell),
      canConvertOffice: !!t.soffice,
      note: t.mode === 'simulate'
        ? 'Simulation mode: Accepting a job will simulate the printer and complete it. Set server.printMode to "live" for real printing.'
        : 'Live mode: jobs are sent to the configured printer. Install SumatraPDF for reliable PDF printing on Windows.'
    };
  }

  printerFor(job) {
    const id = (job.operator && job.operator.printerId) || job.settings.printerId;
    const p = (this.config.printers || []).find((x) => x.id === id) || (this.config.printers || [])[0] || {};
    return p;
  }

  enqueue(job) {
    const run = () => this.execute(job).catch((err) => {
      console.error('  Print error for ' + job.id + ':', err.message);
      const current = this.store.get(job.id);
      if (!current) return;
      this.store.update(job.id, {
        status: 'failed',
        print: Object.assign({}, current.print, { finishedAt: nowIso(), error: err.message }),
        operator: Object.assign({}, current.operator, { completedAt: null })
      }, { event: 'failed', message: 'Print failed: ' + err.message, actor: 'system' });
    });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async execute(jobStub) {
    let job = this.store.get(jobStub.id);
    if (!job) return;
    if (job.status !== 'accepted' && job.status !== 'failed') return;

    const mode = (this.config.server && this.config.server.printMode) || 'simulate';
    const printer = this.printerFor(job);
    const started = nowIso();
    const attempts = (job.print.attempts || 0) + 1;
    job = this.store.update(job.id, {
      status: 'printing',
      operator: Object.assign({}, job.operator, { printerId: printer.id, acceptedAt: job.operator.acceptedAt || started }),
      print: Object.assign({}, job.print, {
        mode: mode, progress: 2, attempts: attempts, startedAt: started, finishedAt: null, error: '', output: ''
      })
    }, {
      event: 'printing',
      message: 'Printing started on ' + (printer.name || 'printer') + (mode === 'simulate' ? ' (simulation)' : ''),
      actor: 'system'
    });

    if (mode === 'simulate') {
      await this.simulate(job, printer);
      return;
    }

    const docs = job.documents;
    const outputs = [];
    const tmpDir = ensureDir(path.join(os.tmpdir(), 'spg-print-' + job.id + '-' + Date.now()));

    for (let i = 0; i < docs.length; i++) {
      const current = this.store.get(job.id);
      if (!current || current.status !== 'printing') return;
      const doc = docs[i];
      let fileInfo = this.store.filePath(job, doc.id, 'printReady');
      if (!fileInfo) fileInfo = this.store.filePath(job, doc.id, 'original');
      if (!fileInfo) throw new Error('Stored file missing for ' + doc.name);

      let printFile = fileInfo.path;
      const isOffice = doc.kind === 'word' || doc.kind === 'excel';
      const isImage = doc.kind === 'image';
      const tools = this.detect();

      if ((isOffice || (isImage && !tools.sumatra && !tools.lp)) && tools.soffice) {
        const converted = await this.convertToPdf(tools.soffice, printFile, tmpDir);
        if (converted) printFile = converted;
      }

      const ext = path.extname(printFile).toLowerCase();
      const isPdf = ext === '.pdf' || fileInfo.mime === 'application/pdf';
      let output;
      if (isPdf && tools.sumatra) {
        output = await this.printWithSumatra(tools.sumatra, printFile, printer, job, doc, !!this.store.filePath(job, doc.id, 'printReady'));
      } else if (isPdf && tools.lp) {
        output = await this.printWithCups(tools.lp, printFile, printer, job, !!this.store.filePath(job, doc.id, 'printReady'));
      } else if (tools.powershell) {
        output = await this.printWithPowerShell(tools.powershell, printFile, printer);
      } else {
        throw new Error('No printing tool available. Install SumatraPDF (Windows) or CUPS lp (Linux/macOS), or keep printMode as "simulate".');
      }
      outputs.push(doc.name + ': ' + output);
      this.store.update(job.id, {
        print: Object.assign({}, this.store.get(job.id).print, { progress: Math.round(((i + 1) / docs.length) * 92) + 5, output: outputs.join('\n') })
      }, { event: 'progress' });
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (err) { /* ignore */ }

    const finalJob = this.store.get(job.id);
    if (!finalJob || finalJob.status !== 'printing') return;
    this.store.update(job.id, {
      status: 'completed',
      operator: Object.assign({}, finalJob.operator, { completedAt: nowIso() }),
      print: Object.assign({}, finalJob.print, {
        progress: 100, finishedAt: nowIso(), output: outputs.join('\n')
      })
    }, { event: 'completed', message: 'Print job completed on ' + (printer.name || 'printer') + '.', actor: 'system' });
  }

  async simulate(job, printer) {
    const targetSeconds = Math.max(3, Math.min(14, (job.pricing.estimatedMinutes || 2) * 1.2));
    const steps = Math.max(6, Math.round(targetSeconds * 2));
    for (let i = 1; i <= steps; i++) {
      await sleep((targetSeconds * 1000) / steps);
      const current = this.store.get(job.id);
      if (!current || current.status !== 'printing') return;
      this.store.update(job.id, {
        print: Object.assign({}, current.print, { progress: Math.min(99, Math.round((i / steps) * 100)) })
      }, { event: 'progress' });
    }
    const current = this.store.get(job.id);
    if (!current || current.status !== 'printing') return;
    this.store.update(job.id, {
      status: 'completed',
      operator: Object.assign({}, current.operator, { completedAt: nowIso() }),
      print: Object.assign({}, current.print, {
        progress: 100,
        finishedAt: nowIso(),
        output: 'Simulated print on ' + (printer.name || 'printer') + ' — ' + plural(job.pricing.sheets, 'sheet') + ', ' + plural(job.pricing.copies, 'set') + '.'
      })
    }, { event: 'completed', message: 'Simulation complete — ' + plural(job.pricing.sheets, 'sheet') + ', ' + plural(job.pricing.copies, 'set') + '.', actor: 'system' });
  }

  convertToPdf(soffice, inputFile, outDir) {
    return new Promise((resolve) => {
      const args = ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, inputFile];
      const child = spawn(soffice, args, { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      const timer = setTimeout(() => { try { child.kill(); } catch (err) { /* ignore */ } }, 120000);
      child.on('close', () => {
        clearTimeout(timer);
        const base = path.basename(inputFile, path.extname(inputFile)) + '.pdf';
        const target = path.join(outDir, base);
        resolve(fs.existsSync(target) ? target : null);
      });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
    });
  }

  pageRangeFor(job, doc, printReady) {
    if (printReady) return '';
    const s = job.settings;
    if (s.pageRangeType === 'current') return '1';
    if (s.pageRangeType === 'custom') {
      const parsed = parsePageRange(s.pageRange, doc.pages);
      if (!parsed.pages.length) return '';
      return compressRanges(parsed.pages);
    }
    return '';
  }

  sumatraSettings(job, doc, printReady) {
    const s = job.settings;
    const c = s.canon;
    const opts = [];
    if (c.copies > 1) opts.push(c.copies + 'x');
    const booklet = c.printStyle === 'booklet' || s.sizingMode === 'booklet';
    if (booklet) {
      // Manual booklet imposition: the PDF already holds the imposed sides, so
      // the printer only needs to flip each sheet around its short edge.
      opts.push('duplexshort');
    } else if (c.printStyle === '2sided') {
      const short = c.bindingLocation === 'shortEdgeTop' || c.bindingLocation === 'shortEdgeBottom';
      opts.push(short ? 'duplexshort' : 'duplexlong');
    } else {
      opts.push('simplex');
    }
    opts.push(c.colorMode === 'auto' ? 'color' : 'monochrome');
    opts.push('paper=' + c.pageSize);
    // A print-ready PDF already carries the final page orientation.
    if (!printReady && (s.orientation === 'landscape' || c.orientation === 'landscape')) opts.push('landscape');
    const range = this.pageRangeFor(job, doc, printReady);
    if (range) opts.push(range);
    return opts.join(',');
  }

  printWithSumatra(exe, file, printer, job, doc, printReady) {
    const settings = this.sumatraSettings(job, doc, printReady);
    const printerName = printer.systemName || printer.name;
    const args = ['-print-to', printerName, '-silent', '-print-settings', settings, file];
    return this.runProcess(exe, args, 'SumatraPDF').then((res) => {
      return 'sent to ' + printerName + ' [' + settings + ']' + (res.output ? ' — ' + res.output.slice(0, 200) : '');
    });
  }

  printWithCups(lp, file, printer, job, printReady) {
    const c = job.settings.canon;
    const printerName = printer.systemName || printer.name;
    const args = ['-d', printerName, '-n', String(c.copies)];
    const booklet = c.printStyle === 'booklet' || job.settings.sizingMode === 'booklet';
    if (booklet) {
      args.push('-o', 'sides=two-sided-short-edge');
    } else if (c.printStyle === '2sided') {
      const short = c.bindingLocation === 'shortEdgeTop' || c.bindingLocation === 'shortEdgeBottom';
      args.push('-o', short ? 'sides=two-sided-short-edge' : 'sides=two-sided-long-edge');
    } else args.push('-o', 'sides=one-sided');
    args.push('-o', 'media=' + c.pageSize);
    args.push('-o', 'ColorModel=' + (c.colorMode === 'auto' ? 'RGB' : 'Gray'));
    if (c.stapleCollate === 'stapleCollate') args.push('-o', 'StapleLocation=staple');
    args.push(file);
    return this.runProcess(lp, args, 'CUPS').then((res) => 'sent to ' + printerName + (res.output ? ' — ' + res.output.slice(0, 200) : ''));
  }

  printWithPowerShell(exe, file, printer) {
    const printerName = printer.systemName || printer.name;
    const safeFile = String(file).replace(/'/g, "''");
    const safePrinter = String(printerName).replace(/'/g, "''");
    const script = "Start-Process -FilePath '" + safeFile + "' -Verb PrintTo -ArgumentList '" + safePrinter + "' -Wait -WindowStyle Hidden";
    return this.runProcess(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 'PowerShell')
      .then(() => 'handed to Windows print handler for ' + printerName + ' (driver defaults apply)');
  }

  runProcess(exe, args, label) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(exe, args, { windowsHide: true });
      } catch (err) { reject(err); return; }
      let output = '';
      const timeoutMs = (Number(this.config.server && this.config.server.printTimeoutSeconds) || 180) * 1000;
      const timer = setTimeout(() => {
        try { child.kill(); } catch (err) { /* ignore */ }
        reject(new Error(label + ' timed out after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.stderr.on('data', (d) => { output += d.toString(); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ output: output.trim() });
        else reject(new Error(label + ' exited with code ' + code + (output ? ': ' + output.trim().slice(0, 300) : '')));
      });
    });
  }
}

function compressRanges(pages) {
  const sorted = pages.slice().sort((a, b) => a - b);
  const parts = [];
  let start = null;
  let prev = null;
  sorted.forEach((p) => {
    if (start === null) { start = p; prev = p; return; }
    if (p === prev + 1) { prev = p; return; }
    parts.push(start === prev ? String(start) : start + '-' + prev);
    start = p; prev = p;
  });
  if (start !== null) parts.push(start === prev ? String(start) : start + '-' + prev);
  return parts.join(',');
}

module.exports = PrintManager;
