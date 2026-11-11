# Smart Print Gateway

A production-ready print portal and operator console for high-volume print shops.
Customers configure a print job in a browser with Acrobat-style layout controls and
Canon-style driver settings, see an exact sheet preview, and send it to a local
Node.js server. The operator reviews each job in a dashboard, previews the imposed
output, then accepts (prints) or rejects it.

Everything runs on the shop's own computer or LAN. There is **no cloud service, no
database server and no npm dependency** — just Node.js and the files in this folder.

---

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using the customer portal](#using-the-customer-portal)
- [Using the operator console](#using-the-operator-console)
- [Print modes and hardware setup](#print-modes-and-hardware-setup)
- [Configuration](#configuration)
- [Pricing model](#pricing-model)
- [HTTP API](#http-api)
- [Data, privacy and retention](#data-privacy-and-retention)
- [Folder structure](#folder-structure)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Development](#development)
- [License](#license)

---

## Highlights

**Customer portal**

- PDF, Word (`.docx`), Excel, JPEG, PNG, WebP and TIFF upload; up to 12 documents per job.
- Local PDF.js rendering with page counts, thumbnails and per-page colour detection.
- Adobe Acrobat-style layout controls:
  - Page range: all, current page, or a custom range such as `1-4, 7, 10-12`.
  - Fit, actual size, shrink oversized pages, or custom scale from 25–400%.
  - Poster mode with tile scale, overlap and cut marks.
  - N-up from 2-up to 16-up, custom rows/columns, page order and borders.
  - Booklet imposition with left/right/top binding, front/back/both subsets and gutter.
  - Auto-rotate, force portrait, or force landscape.
- Canon driver-style settings:
  - A3, A4, A5, Letter and Legal paper.
  - 1–9999 copies, collate/group, staple, eco staple-free.
  - Auto colour, black & white, or pure B&W.
  - Long-edge/short-edge duplex and booklet finishing.
  - Paper drawers, paper type, 600/1200 dpi and output objectives.
- Live interactive HTML5 canvas preview with sheet navigation, zoom, fit-to-frame and
  grayscale proofing.
- Print-ready PDF generation: for PDF/image jobs the browser renders the exact imposed
  sheets, so N-up, booklet, poster, scaling and colour match the preview.
- Live pricing with itemised lines, VAT, minimum charge and finishing costs.
- Paper/aspect-ratio warnings, job tracker, cancellation and "call the counter".
- Built-in print assistant (chatbot) and guided tour. Works fully offline.

**Operator console**

- PIN-protected dashboard with rate-limited login and HMAC-signed session tokens.
- Live queue over Server-Sent Events, with polling fallback.
- Job cards with status, customer, document count, pages, price and queue position.
- Full job detail: authenticated original/print-ready preview, print setup, pricing,
  activity log, warnings and customer notes.
- Accept on a chosen printer, reject with a reason, mark complete, reprint, or delete.
- History, printer status, statistics and CSV export.
- Settings editor for shop details, pricing, printers, features and print mode.
- PIN change and default-PIN warning.
- Dark/light premium theme, responsive touch-friendly layout.

---

## Requirements

- **Node.js 18 or newer** (tested with Node 26). No `npm install` is required.
- A modern browser (Chrome, Edge, Firefox or Safari).
- Optional, only for real printing:
  - Windows: a printer driver plus [SumatraPDF](https://www.sumatrapdfreader.org/).
  - Linux/macOS: CUPS `lp`.
  - Optional: LibreOffice for converting Word/Excel files to PDF before printing.

The repository already vendors PDF.js and the Inter font, so the portal works without
internet access.

---

## Quick start

### Windows (one click)

Double-click `scripts\start.bat`, or run:

```bat
scripts\start.bat
```

### Any platform

```bash
node server.js
# or
npm start
```

Then open:

- Customer portal — <http://localhost:4173/>
- Operator console — <http://localhost:4173/dashboard>

The server prints the operator PIN to the console the first time it runs. The default
is **1234**; change it in **Dashboard → Settings → Operator security** before the shop
opens.

Useful options:

```bash
node server.js --open          # start and open the portal in a browser
node server.js --live          # start in live print mode
node server.js --live --open   # both
```

Environment overrides:

| Variable | Purpose |
| --- | --- |
| `SPG_PORT` | HTTP port (default `4173`) |
| `SPG_HOST` | Bind address (default `0.0.0.0`) |
| `SPG_PRINT_MODE` | `simulate` or `live` |
| `SPG_PIN` | PIN to use when `data/auth.json` is first created |
| `SPG_OPEN` | Set to `1` to open the browser on start |
| `SPG_LOG` | Set to `1` for request logging |
| `SUMATRA_PATH` | Full path to `SumatraPDF.exe` |
| `SOFFICE_PATH` | Full path to LibreOffice `soffice` |
| `LP_PATH` | Full path to CUPS `lp` |

To let other devices on the shop LAN use the portal, allow Node.js through the
Windows firewall (or the host firewall) and browse to the LAN address printed at
startup, for example `http://192.168.1.20:4173`.

---

## Using the customer portal

1. **Add files.** Drag files onto the page, use the file picker, or load the built-in
   sample. PDFs are analysed locally for page count and colour pages.
2. **Choose a preset or build the job.** Presets cover 4-up duplex handouts, A4 saddle
   stitch booklets, poster tiles, B&W duplex reports, photo printing and eco 8-up.
3. **Set the layout.** Pick page range, sizing mode and orientation. Poster, N-up and
   Booklet each show their own options.
4. **Set the Canon options.** Paper size, copies, colour mode, duplex, finishing,
   drawer, paper type, resolution and objective.
5. **Review the preview.** Use the filmstrip, arrows, zoom and fit button. The preview
   is the imposed output, not just the source page.
6. **Check price and warnings.** Warnings explain clipped edges, unsupported paper,
   booklet padding, colour conversion and similar issues.
7. **Send the job.** Enter a name, confirm "Pre-impose exact sheets", and send. You get
   a job number and a live tracker. You can cancel while the job is still pending.
8. **Ask the assistant.** The floating assistant explains Booklet, N-up, duplex,
   poster, paper, supported formats, pricing and job status, and can run a short tour.

**Note on Word and Excel:** browsers cannot reliably render Office files, so the shop
server converts them with LibreOffice in live mode. When a job contains Word or Excel,
exact browser-side imposition is disabled and the printer driver applies the layout.
For guaranteed layout, export to PDF first.

---

## Using the operator console

1. Open `/dashboard` and enter the operator PIN.
2. The **Live queue** shows pending jobs first, then active jobs. New jobs arrive over
   SSE without refreshing.
3. Click a job card to open the detail view:
   - Toggle between **Print-ready** and **Original** files.
   - Check the print setup, pricing breakdown, warnings, source and activity log.
   - Choose the printer and add an optional note to the customer.
4. **Accept & print** queues the job on the selected printer. In simulate mode the job
   completes automatically; in live mode it is sent to the printer.
5. **Reject** records a reason and leaves the job in history.
6. Use **Reprint** on completed, failed or rejected jobs, or **Delete** to remove a
   record and its files.
7. **History**, **Printers**, **Statistics** and **Settings** are in the sidebar.
   Settings includes shop details, pricing rates, printer definitions, feature flags,
   print mode, data usage and PIN security.

Statuses: `pending → accepted → printing → completed`, plus `rejected`, `failed` and
`cancelled`.

---

## Print modes and hardware setup

### Simulate (default)

`server.printMode` is `"simulate"` in `config/shop.config.json`. Accepting a job
simulates the printer and marks the job complete after a short delay. This is safe for
demos, training and development — no hardware is touched.

### Live mode

Set `printMode` to `"live"` in the config, or start with `--live`. The server detects
available tools at startup and uses this order:

| Job/file | Windows | Linux/macOS |
| --- | --- | --- |
| PDF | SumatraPDF (preferred) → PowerShell print handler | CUPS `lp` |
| Word / Excel | LibreOffice → PDF → SumatraPDF/CUPS | LibreOffice → PDF → CUPS |
| Images | SumatraPDF/CUPS; converted with LibreOffice if needed | CUPS; LibreOffice if needed |

**Windows setup**

1. Install the Canon printer driver and confirm the exact Windows printer name in
   *Settings → Bluetooth & devices → Printers & scanners*.
2. Put that exact name in `printers[].systemName` in `config/shop.config.json`.
3. Install SumatraPDF. Either add it to `PATH` or set `server.sumatraPath` to the full
   executable path.
4. Optional: install LibreOffice and set `server.sofficePath`.
5. Set `server.printMode` to `"live"`, restart the server, and send a one-page test job.
6. Keep **Pre-impose exact sheets** enabled in the portal for PDF/image jobs. The
   print-ready PDF already contains the imposed sides, so the driver is told to duplex
   or simplex without re-imposing the layout.

**Linux/macOS setup**

1. Add the printer to CUPS and use the queue name as `printers[].systemName`.
2. Ensure `lp` is installed (`which lp`).
3. Optional: install LibreOffice and set `server.sofficePath`.
4. Set `server.printMode` to `"live"` and restart.

**Driver arguments used**

- SumatraPDF: copies, `simplex`/`duplexlong`/`duplexshort`, colour mode, paper size and
  optional page range. Booklet jobs are imposed in the PDF and printed two-sided short
  edge so the back is correctly oriented.
- CUPS: `-n` copies, `sides=one-sided|two-sided-long-edge|two-sided-short-edge`,
  `media=`, `ColorModel=` and optional stapling.
- PowerShell fallback: hands the PDF to the Windows print handler using driver
  defaults. Use SumatraPDF when exact settings matter.

Print jobs run through an internal queue (`PrintManager`) so two accepted jobs cannot
operate the same printer at the same time.

---

## Configuration

Main file: `config/shop.config.json`. Changes made in **Dashboard → Settings** are
written back here (a `.bak` copy is kept). Restart the server after editing the file
by hand.

### `shop`

Name, tagline, phone, WhatsApp, email, address, currency, opening hours, timezone,
closed days, welcome text, payment note and pickup note. Opening hours control the
"Open now" badge.

### `server`

| Key | Meaning |
| --- | --- |
| `port`, `host` | HTTP listener |
| `retentionDays` | Delete completed jobs and files after this many days |
| `maxFileMB` | Per-file limit |
| `maxJobMB` | Whole-job limit (original + print-ready data) |
| `sessionHours` | Operator token lifetime |
| `printMode` | `simulate` or `live` |
| `defaultPrinterId` | Printer used when the customer does not choose one |
| `sumatraPath`, `sofficePath`, `lpPath` | Explicit tool paths |
| `printTimeoutSeconds` | Kill a stuck print/conversion process |
| `autoRefreshSeconds` | Dashboard polling fallback interval |

### `printers`

Each printer has `id`, `name`, `model`, `systemName`, `location`, `capabilities` and
`enabled`. Capabilities include `color`, `mono`, `duplex`, `staple`, `booklet`, `a3`
and `1200dpi`. The shipped config contains the Canon iR-ADV C5760i (colour) and
iR-ADV C5550 (B&W).

### `pricing`

See [Pricing model](#pricing-model).

### `features`

`exactImposition`, `colorDetection`, `chatbot`, `showPrices`, `allowRush`,
`allowLamination`, `requireCustomerName`. These toggle portal behaviour.

---

## Pricing model

Money is handled in baisa internally (1 OMR = 1000 baisa) and displayed in OMR with
three decimals. The same engine (`shared/pricing.js`) runs in the browser and on the
server, so the customer estimate and the operator total agree.

Default rates:

- B&W A4 side: **0.025 OMR**
- Colour A4 side: **0.150 OMR**
- Size multipliers: A4 1×, A3 2×, A5 0.7×, Letter 1×, Legal 1.3×
- Paper multipliers: plain 1×, recycled 0.95×, heavy 1.25–1.5×, photo 2.5×,
  transparency 3×
- Duplex: **5% paper-saving discount**
- Finishing: staple + collate 0.5, eco staple 0.3, booklet 0.75, fold 0.2
- Extras: lamination 0.3/sheet, cutting 0.1/sheet, rush +20%
- Minimum order: **0.500 OMR**
- VAT: **5%**

The engine accounts for N-up, booklet, duplex and copies when counting printed sides
and physical sheets. Poster mode prices every tile. The customer's browser sends page
width/height so poster tiling is priced accurately.

Change any rate in **Dashboard → Settings → Pricing** or in the config file.

---

## HTTP API

All responses are JSON unless noted. Errors use `{ "ok": false, "error": "..." }` with
an appropriate HTTP status.

### Public

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Shop, printers, print mode, uptime |
| `GET` | `/api/config` | Public shop/pricing/feature configuration |
| `GET` | `/api/sample.pdf` | Built-in demo PDF |
| `POST` | `/api/jobs` | Create a print job |
| `GET` | `/api/jobs/:id/status?token=…` | Job status (client token required) |
| `GET` | `/api/jobs/:id/events?token=…` | SSE stream for one job |
| `POST` | `/api/jobs/:id/cancel?token=…` | Cancel while pending |
| `POST` | `/api/jobs/:id/assist?token=…` | Ask the counter for help |

### Authentication

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/login` | `{ "pin": "1234" }` → token |
| `GET` | `/api/auth/session` | Validate an operator token |
| `POST` | `/api/auth/pin` | `{ "currentPin", "newPin" }` → new token |

Send the operator token as `Authorization: Bearer <token>`. For file previews and
EventSource connections the token may also be passed as `?token=<token>`.

### Operator

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/operator/events` | SSE queue/stat events |
| `GET` | `/api/operator/jobs?status=&q=&limit=` | List jobs |
| `GET` | `/api/operator/jobs/:id` | Full job detail |
| `GET` | `/api/operator/jobs/:id/files/:docId?kind=original\|printReady` | Stream a file |
| `POST` | `/api/operator/jobs/:id/accept` | `{ printerId, note }` |
| `POST` | `/api/operator/jobs/:id/reject` | `{ reason, note }` |
| `POST` | `/api/operator/jobs/:id/reprint` | `{ printerId }` |
| `POST` | `/api/operator/jobs/:id/complete` | Mark complete manually |
| `DELETE` | `/api/operator/jobs/:id` | Delete a job and its files |
| `GET` | `/api/operator/stats` | Counts and diagnostics |
| `GET` | `/api/operator/settings` | Full editable configuration |
| `PUT` | `/api/operator/settings` | Partial settings update |
| `GET` | `/api/operator/diagnostics` | Node, data and printer diagnostics |
| `GET` | `/api/operator/export.csv` | CSV export |

### Creating a job

Minimal shape (file data is base64, without the `data:` prefix):

```json
{
  "customer": { "name": "Aisha", "phone": "+96890000000", "note": "Please staple" },
  "settings": {
    "printerId": "canon-c5760i",
    "pageRangeType": "all",
    "pageRange": "",
    "sizingMode": "size",
    "sizeMode": "fit",
    "orientation": "auto",
    "exactImposition": true,
    "nup": { "pagesPerSheet": 4, "customCols": 2, "customRows": 2, "pageOrder": "horizontal", "border": true, "gutter": 0 },
    "booklet": { "subset": "both", "binding": "left", "gutter": 0, "fold": true },
    "canon": {
      "pageSize": "A4", "outputSize": "same", "copies": 1, "orientation": "portrait",
      "colorMode": "auto", "printStyle": "2sided", "bindingLocation": "longEdgeLeft",
      "stapleCollate": "collate", "paperSource": "auto", "paperType": "plain",
      "objective": "general", "resolution": 600
    }
  },
  "documents": [
    {
      "name": "flyer.pdf",
      "mime": "application/pdf",
      "size": 123456,
      "kind": "pdf",
      "pages": 8,
      "colorPages": 8,
      "pageW": 595.28,
      "pageH": 841.89,
      "data": "<base64 original>",
      "printReadyData": "<base64 imposed PDF>",
      "printReadyPages": 4
    }
  ],
  "warnings": [],
  "clientEstimate": { "total": 1.26, "pages": 8, "sides": 8 }
}
```

`printReadyData` is optional. When present, the operator preview and the live driver
use it instead of the original. `pageW`/`pageH` are PDF points and improve poster
pricing.

Limits: 12 documents, `server.maxFileMB` per file and `server.maxJobMB` per job
(defaults 60 MB and 180 MB).

Example:

```bash
curl -s http://localhost:4173/api/health
curl -s -X POST http://localhost:4173/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}'
```

---

## Data, privacy and retention

- Everything is stored locally under `data/`.
- `data/auth.json` holds a scrypt PIN hash and the HMAC signing secret — never a
  plaintext PIN.
- Each job gets a random 32-byte client token. The job ID alone is not enough to read
  or cancel a job.
- Operator sessions expire after `server.sessionHours` (default 12 hours). Changing
  the PIN rotates the signing secret and invalidates existing sessions.
- Uploaded files and print-ready PDFs live in `data/uploads/<job-id>/`.
- Job metadata lives in `data/jobs.json` with an atomic `.bak` copy.
- Completed jobs are deleted after `server.retentionDays` (default 30). Operators can
  also delete a job immediately.
- No analytics, telemetry or external API calls are made. PDF.js and the font are
  served from this folder.

Back up `config/` and `data/` if you need job history. To start completely fresh, stop
the server and empty `data/`; the default PIN is recreated on next start.

---

## Folder structure

```
smart-print-gateway-main/
├─ server.js                 HTTP server, routing, job creation, SSE
├─ config/
│  └─ shop.config.json       Shop, server, printers, pricing, features
├─ lib/
│  ├─ auth.js                PIN hashing, HMAC tokens, rate limiting
│  ├─ config.js              Config load/save and public filtering
│  ├─ normalize.js           Validation/normalisation of jobs and settings
│  ├─ printers.js            Driver detection, queue, Sumatra/CUPS/LibreOffice
│  ├─ store.js               Atomic JSON job store and file storage
│  └─ util.js                Helpers, page ranges, atomic writes, rate limiter
├─ shared/
│  ├─ pricing.js             Shared pricing engine (browser + server)
│  ├─ pdf-builder.js         JPEG → PDF builder for print-ready output
│  └─ sample-pdf.js          Built-in demo PDF
├─ public/
│  ├─ index.html             Customer portal
│  ├─ dashboard.html         Operator console
│  └─ assets/
│     ├─ css/                Premium theme and dashboard styles
│     ├─ js/                 Portal, dashboard, preview, documents, chatbot, UI
│     ├─ fonts/              Inter variable font
│     └─ vendor/             PDF.js 3.11.174
├─ scripts/
│  ├─ start.bat              Windows launcher
│  └─ start.sh               macOS/Linux launcher
├─ data/                     Created at runtime (ignored by git)
└─ package.json
```

The root `index.html` is an older standalone prototype and is not served by the
application. The live portal is `public/index.html`.

---

## Troubleshooting

**Port already in use** — another copy of the server is running. Stop it or set
`SPG_PORT=4174`.

**Dashboard says the PIN is wrong** — the PIN may have been changed earlier. Delete
`data/auth.json` while the server is stopped to reset to `1234`, then change it again.
Login attempts are rate-limited; wait a minute after several failures.

**Word/Excel job looks different from the preview** — browsers cannot render Office
files exactly. Install LibreOffice for server conversion, or send a PDF for exact
imposition.

**Colour pages print in black & white** — the selected printer may be mono, or the
colour mode is set to B&W. Choose the Canon C5760i and "Auto colour".

**Nothing prints in live mode** — check `GET /api/operator/diagnostics` (or
Dashboard → Printers) for detected SumatraPDF/CUPS/LibreOffice paths. Confirm the
`systemName` matches the operating-system printer name exactly.

**A job is stuck in printing** — check the server console. In simulate mode it should
finish within seconds. Use **Mark complete** or **Reprint** after fixing the cause.

**Uploads fail with 413** — the job exceeds `maxFileMB`/`maxJobMB`. Increase the limits
in Settings or the config file.

**Poster uses a lot of paper** — that is expected: tiles = columns × rows × selected
pages. Reduce the tile scale or overlap. The portal warns above 24 tiles per page.

**PDF asks for a password** — password-protected PDFs are supported; the portal asks
for the password when the file is opened.

**Other devices cannot connect** — use the LAN URL printed at startup and allow the
port through the firewall. Both devices must be on the same network.

---

## Security notes

This server is designed for a trusted shop LAN, not direct exposure to the internet.

- Change the default PIN immediately.
- Keep `data/` and `config/` out of version control (already ignored).
- Do not run the server as an administrator unless required by the printer driver.
- If remote access is needed, put it behind a VPN or an HTTPS reverse proxy with
  authentication. Do not port-forward it directly.
- The API accepts operator tokens in a query string for file previews and SSE. Treat
  those URLs as sensitive.
- Uploaded files are stored as-is for printing. Only accept jobs from customers you
  serve, and delete old jobs with the retention setting.

---

## Development

No build step. Edit files and restart the server (or use `npm run dev` for
`node --watch`).

```bash
npm run dev
```

Syntax checks:

```bash
node --check server.js
node --check lib/printers.js
node --check public/assets/js/app.js
node --check public/assets/js/dashboard.js
```

Key modules:

- `public/assets/js/preview.js` — layout planning, canvas rendering and print-ready
  PDF export.
- `public/assets/js/documents.js` — PDF.js loading, page ranges, colour analysis.
- `public/assets/js/app.js` — portal controller and settings persistence.
- `public/assets/js/dashboard.js` — operator console, SSE, job actions.
- `public/assets/js/chatbot.js` — offline assistant rules and guided tour.
- `shared/pricing.js` — pricing used by both sides.
- `lib/printers.js` — live print execution and simulation.

---

## License

MIT. See `LICENSE`.
