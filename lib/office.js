/*
 * AL SHAJAR STATIONERY — Smart Print Gateway
 * Word (.docx) to PDF conversion using LibreOffice or Microsoft Word. (AL SHAJAR TEAM)
 *
 * Word files cannot be rendered faithfully by a browser. When LibreOffice or
 * Microsoft Word is available on the shop computer, the server converts the
 * file to PDF so the customer sees the same pages that will print.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ensureDir, removeDir, randomId, safeFilename } = require('./util');

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

function findSoffice(config) {
  const candidates = [
    config && config.server ? config.server.sofficePath : '',
    process.env.SOFFICE_PATH,
    fromPath('soffice'),
    fromPath('soffice.exe'),
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return '';
}

function findWord() {
  if (process.platform !== 'win32') return '';
  const candidates = [
    process.env.WINWORD_PATH,
    fromPath('WINWORD.EXE'),
    'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    'C:\\Program Files\\Microsoft Office\\Office16\\WINWORD.EXE',
    'C:\\Program Files (x86)\\Microsoft Office\\Office16\\WINWORD.EXE',
    'C:\\Program Files\\Microsoft Office\\Office15\\WINWORD.EXE'
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return '';
}

function detectConverters(config) {
  const soffice = findSoffice(config);
  const word = findWord();
  return {
    soffice: soffice,
    word: word,
    available: !!(soffice || word)
  };
}

function run(command, args, timeoutMs, options) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(command, args, Object.assign({
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }, options || {}));
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
      resolve({ ok: false, code: -1, stdout: stdout, stderr: stderr || 'Conversion timed out.' });
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

function pdfInDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    const pdf = files.filter(function (name) { return /\.pdf$/i.test(name); })[0];
    return pdf ? path.join(dir, pdf) : '';
  } catch (err) {
    return '';
  }
}

async function convertWithSoffice(soffice, inputPath, outDir, timeoutMs) {
  const profile = path.join(outDir, 'profile');
  ensureDir(profile);
  const args = [
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--norestore',
    '-env:UserInstallation=' + pathToFileURL(profile).href,
    '--convert-to',
    'pdf:writer_pdf_Export',
    '--outdir',
    outDir,
    inputPath
  ];
  const result = await run(soffice, args, timeoutMs);
  const output = pdfInDir(outDir);
  if (output) return { ok: true, path: output, message: result.stdout || result.stderr || 'Converted with LibreOffice.' };
  return {
    ok: false,
    message: 'LibreOffice could not convert this Word file. ' + (result.stderr || result.stdout || '').trim()
  };
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function convertWithWord(inputPath, outDir, timeoutMs) {
  const outputPath = path.join(outDir, 'word-output.pdf');
  const scriptPath = path.join(outDir, 'convert.ps1');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$word = New-Object -ComObject Word.Application',
    '$word.Visible = $false',
    '$word.DisplayAlerts = 0',
    'try {',
    '  $doc = $word.Documents.Open(' + psQuote(inputPath) + ', $false, $true)',
    '  $doc.SaveAs([ref]' + psQuote(outputPath) + ', [ref]17)',
    '  $doc.Close($false)',
    '} finally {',
    '  try { $word.Quit() } catch {}',
    '}'
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');

  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath
  ], timeoutMs);

  if (exists(outputPath)) {
    return { ok: true, path: outputPath, message: 'Converted with Microsoft Word.' };
  }
  return {
    ok: false,
    message: 'Microsoft Word could not convert this file. ' + (result.stderr || result.stdout || '').trim()
  };
}

async function convertDocxBuffer(buffer, originalName, config, dataDir) {
  const tempDir = path.join(dataDir, 'tmp', 'convert-' + randomId(12));
  ensureDir(tempDir);
  const safeName = safeFilename(originalName || 'document.docx', 'document.docx').replace(/\.[^.]+$/, '') || 'document';
  const inputPath = path.join(tempDir, safeName + '.docx');

  try {
    fs.writeFileSync(inputPath, buffer);
    const converters = detectConverters(config);
    const timeoutMs = Math.max(30000, (Number(config && config.server && config.server.printTimeoutSeconds) || 180) * 1000);
    let attempt = { ok: false, message: '' };

    if (converters.soffice) {
      attempt = await convertWithSoffice(converters.soffice, inputPath, tempDir, timeoutMs);
    }
    if (!attempt.ok && converters.word) {
      attempt = await convertWithWord(inputPath, tempDir, timeoutMs);
    }
    if (!attempt.ok) {
      throw new Error(
        'Word conversion is not available on the shop computer. Install LibreOffice (free) or Microsoft Word, ' +
        'or ask the customer to save the file as PDF. ' + (attempt.message || '')
      );
    }

    const bytes = fs.readFileSync(attempt.path);
    return {
      bytes: bytes,
      converter: converters.soffice ? 'libreoffice' : 'microsoft-word',
      name: safeName + '.pdf'
    };
  } finally {
    removeDir(tempDir);
  }
}

module.exports = {
  detectConverters,
  findSoffice,
  findWord,
  convertDocxBuffer
};
