/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Canon printer execution with a per-printer queue. (AL SHAJAR TEAM)
 *
 * Live mode uses SumatraPDF on Windows or CUPS `lp` on macOS/Linux.
 * Simulate mode (default) is safe for demos and training and never touches
 * the printer. The print-ready PDF is already imposed, so the driver only
 * applies paper, copies, colour and duplex.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { sleep } = require('./util');
const { detectConverters } = require('./office');

function exists(filePath) {
  try { return !!filePath && fs.existsSync(filePath); } catch (err) { return false; }
}

function fromPath(command) {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (result.status === 0) {
      const line = String(result.stdout || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean)[0];
      if (line && exists(line)) return line;
    }
  } catch (err) { /* ignore */ }
  return '';
}

function findSumatra(config) {
  const candidates = [
    config && config.server ? config.server.sumatraPath : '',
    process.env.SUMATRA_PATH,
    fromPath('SumatraPDF.exe'),
    fromPath('SumatraPDF'),
    'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    'C:\\Program Files (x86)\\SumatraPDF\\SumatraPDF.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'SumatraPDF', 'SumatraPDF.exe') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'SumatraPDF', 'SumatraPDF.exe') : ''
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return '';
}

function findLp(config) {
  const candidates = [
    config && config.server ? config.server.lpPath : '',
    process.env.LP_PATH,
    fromPath('lp'),
    '/usr/bin/lp',
    '/usr/local/bin/lp'
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return '';
}

function run(command, args, timeoutMs) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err.message || err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (err) { /* ignore */ }
      resolve({ ok: false, code: -1, stdout: stdout, stderr: 'The printer command timed out.' });
    }, timeoutMs);

    child.stdout.on('data', function (chunk) { stdout += chunk.toString(); });
    child.stderr.on('data', function (chunk) { stderr += chunk.toString(); });
    child.on('error', function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: stdout, stderr: String(err.message || err) });
    });
    child.on('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code, stdout: stdout, stderr: stderr });
    });
  });
}

function sumatraSettings(job, printReady) {
  const settings = job.settings || {};
  const parts = [];
  const copies = Math.max(1, Math.round(Number(settings.copies) || 1));
  if (copies > 1) parts.push(copies + 'x');
  parts.push(settings.duplex ? 'duplexlong' : 'simplex');
  parts.push(settings.color === 'color' ? 'color' : 'monochrome');
  parts.push('paper=' + (settings.paper || 'A4'));
  parts.push(printReady ? 'noscale' : 'fit');
  if (copies > 1) parts.push('collate');
  parts.push('ignore-pdf-print-settings');
  return parts.join(',');
}

function cupsOptions(job, printReady) {
  const settings = job.settings || {};
  const options = [
    '-o', 'media=' + (settings.paper || 'A4'),
    '-o', 'sides=' + (settings.duplex ? 'two-sided-long-edge' : 'one-sided'),
    '-o', 'print-color-mode=' + (settings.color === 'color' ? 'color' : 'monochrome'),
    '-o', 'collate=true'
  ];
  if (!printReady) options.push('-o', 'fit-to-page');
  return options;
}

const SUMATRA_ERRORS = {
  2: 'SumatraPDF could not open the print-ready file.',
  3: 'The document does not allow printing.',
  4: 'The Windows printer name was not found. Check the printer system name in Settings.',
  5: 'The printer driver failed. Check the Canon printer and driver.',
  6: 'Printing is disabled by SumatraPDF policy.'
};

class PrintManager {
  constructor(config) {
    this.config = config;
    this.chains = new Map();
  }

  setConfig(config) {
    this.config = config;
  }

  diagnostics() {
    const sumatra = findSumatra(this.config);
    const lp = findLp(this.config);
    const converters = detectConverters(this.config);
    const mode = this.config.server.printMode;
    return {
      mode: mode,
      ready: mode === 'simulate' || (process.platform === 'win32' ? !!sumatra : !!lp),
      sumatra: sumatra,
      lp: lp,
      soffice: converters.soffice,
      word: converters.word,
      wordConversion: converters.available,
      printers: this.config.printers.map(function (printer) {
        return {
          id: printer.id,
          name: printer.name,
          systemName: printer.systemName,
          enabled: printer.enabled,
          location: printer.location
        };
      }),
      note: mode === 'simulate'
        ? 'Simulate mode is on. Accepting a job marks it complete without touching the printer.'
        : (process.platform === 'win32'
          ? (sumatra ? 'Live mode: jobs are sent to the selected Windows printer through SumatraPDF.' : 'Live mode needs SumatraPDF. Install it and set the path in Settings.')
          : (lp ? 'Live mode: jobs are sent through CUPS.' : 'Live mode needs CUPS `lp`.'))
    };
  }

  resolvePdf(job) {
    if (job.printReadyPath && exists(job.printReadyPath)) return job.printReadyPath;
    const docs = Array.isArray(job.docs) ? job.docs : [];
    for (const doc of docs) {
      if (doc && doc.path && /\.pdf$/i.test(doc.path) && exists(doc.path)) return doc.path;
    }
    return '';
  }

  submit(job, printer) {
    const key = String((printer && printer.id) || 'default');
    const previous = this.chains.get(key) || Promise.resolve();
    const task = previous.then(() => this.execute(job, printer)).catch((err) => ({
      ok: false,
      message: String((err && err.message) || err || 'Print failed.')
    }));
    this.chains.set(key, task.then(function () { /* keep the chain alive */ }));
    return task;
  }

  async execute(job, printer) {
    const mode = this.config.server.printMode;
    if (mode === 'simulate') {
      await sleep(2200);
      return {
        ok: true,
        simulated: true,
        message: 'Simulated print completed. No hardware was used.'
      };
    }

    const pdfPath = this.resolvePdf(job);
    if (!pdfPath) {
      return { ok: false, message: 'No printable PDF was found for this job.' };
    }
    const printReady = !!(job.printReadyPath && pdfPath === job.printReadyPath);
    const systemName = String((printer && printer.systemName) || '').trim();
    if (!systemName) {
      return { ok: false, message: 'The selected printer has no Windows/CUPS queue name in Settings.' };
    }

    if (process.platform === 'win32') {
      const sumatra = findSumatra(this.config);
      if (!sumatra) {
        return {
          ok: false,
          message: 'Live printing needs SumatraPDF. Install it from sumatrapdfreader.org, then set the path in Dashboard → Settings → Printing.'
        };
      }
      const settings = sumatraSettings(job, printReady);
      const args = ['-print-to', systemName, '-print-settings', settings, '-silent', pdfPath];
      const result = await run(sumatra, args, Math.max(20, Number(this.config.server.printTimeoutSeconds) || 180) * 1000);
      if (result.ok) {
        return {
          ok: true,
          message: 'Sent to ' + systemName + ' (' + settings + ').',
          command: 'SumatraPDF ' + args.join(' ')
        };
      }
      return {
        ok: false,
        message: SUMATRA_ERRORS[result.code] || ('SumatraPDF failed: ' + (result.stderr || result.stdout || 'exit code ' + result.code).trim())
      };
    }

    const lp = findLp(this.config);
    if (!lp) {
      return { ok: false, message: 'Live printing needs CUPS `lp` on this computer.' };
    }
    const copies = Math.max(1, Math.round(Number((job.settings || {}).copies) || 1));
    const args = ['-d', systemName, '-n', String(copies)].concat(cupsOptions(job, printReady)).concat([pdfPath]);
    const result = await run(lp, args, Math.max(20, Number(this.config.server.printTimeoutSeconds) || 180) * 1000);
    if (result.ok) {
      return { ok: true, message: 'Sent to ' + systemName + '.', command: 'lp ' + args.join(' ') };
    }
    return { ok: false, message: 'CUPS failed: ' + (result.stderr || result.stdout || 'exit code ' + result.code).trim() };
  }
}

module.exports = {
  PrintManager,
  findSumatra,
  findLp,
  detectConverters
};
