# AL SHAJAR STATIONERY · Smart Print Gateway (SHS)

A dependency-free web app for the Al Shaajar stationery print desk in the UAE: a public customer
print portal with live layout preview, pricing and VAT handling, plus a PIN-protected operator
console that previews jobs and sends print-ready files straight to the Canon printer over the LAN.

No runtime npm packages are required — Node.js built-ins plus vendored libraries only.

## Features

- **Customer portal** (`/`)
  - Public, no login required.
  - Upload **PDF, Word (.docx), JPG or PNG** files; Word files are converted to PDF on the shop computer.
  - **Live HTML5 canvas preview** of the exact imposed sheet layout (orientation, duplex, N-up).
  - **AED pricing, VAT inclusive** (5% UAE VAT). All totals shown as final amount; the receipt
    reverses the VAT into subtotal and tax parts.
  - **Store pickup** or **Home delivery** (delivery fee below a free-delivery threshold).
  - Payment method selection: **Cash** or **Card**.

- **Operator console** (`/dashboard`, protected by console PIN, default **1234**)
  - **Live queue** with real-time updates (SSE + polling fallback).
  - Job detail: customer, settings, price breakdown (VAT included), files, timeline, actions.
  - **Accept & print** → builds a print-ready PDF (imposed/duplex aware) and sends it to the printer.
  - **Reject** with a customer-visible reason.
  - **Reprint** and **Mark complete**.
  - **Stats**: waiting, printing, completed, today's revenue (VAT inclusive).
  - **QR code** for the customer portal (phones on the shop Wi-Fi).
  - **Settings**: shop details, pricing, delivery, server limits, printers, PIN.
  - **Diagnostics**: driver, converter, runtime status.

- **Live printing**
  - Print driver precedence: **SumatraPDF** (Windows), **CUPS `lp`** (Linux/macOS); **simulate mode** by default.
  - Live mode: `node server.js --live` (or set `server.printMode: "live"` in `config/shop.config.json`).
  - Direct execution of the Canon imageRUNNER ADVANCE via the print-ready file.

- **Compliance / brand**
  - All money in **AED**, VAT inclusive at **5%**.
  - Footer: `© 2026 AL SHAJAR STATIONERY. All rights reserved.`
  - Terms & Conditions and Privacy Policy modals.

## Quick start

```bash
node server.js            # HTTP server on 0.0.0.0:4173 (simulate print mode)
node server.js --live     # live printing mode
```

- Customer portal: `http://<this-computer-LAN-IP>:4173/`
- Operator console: `http://<this-computer-LAN-IP>:4173/dashboard` (PIN `1234`)

The terminal prints the LAN URL and the QR code is rendered in the Operator Dashboard.

## Pricing (AED, VAT inclusive)

| Size | Ink | Rate |
| --- | --- | --- |
| A4 / A5 | Black & white | AED 1.00 per 8 pages or part thereof (single/double-sided same) |
| A4 / A5 | Colour | AED 1.00 per page |
| A3 | Black & white | AED 2.00 per page |
| A3 | Colour | AED 3.00 per page |

VAT (5%) is included in every total; the customer receipt shows subtotal before VAT and the included VAT.

## Configuration

`config/shop.config.json`:

- `shop` — name, contact, notes, welcome text.
- `pricing` — currency, VAT percent, black & white block size, rates per size.
- `delivery` — delivery fee and free-delivery threshold (default fee 10 AED, free from 50 AED).
- `server` — port, host, retention, limits, print mode, default printer, timeouts.
- `printers` — Canon printer entries (id, name, systemName, location, capabilities, enabled).

## Project layout

- `server.js` — HTTP server, API, auth, SSE live queue, job handling, printing, security headers.
- `lib/` — server helpers (auth, store, docs, printers, QR, utilities, config).
- `shared/` — pricing engine, layout planning, imposed PDF builder, sample PDF.
- `public/` — customer portal and operator console UI (HTML, CSS, JS, vendored PDF.js / QR / pdf-lib).
- `config/` — shop configuration.

## Security & operations

- Operator auth: scrypt hash + HMAC-signed, HttpOnly, SameSite=Strict session cookie; rate-limited login.
- Console PIN (default `1234`) changeable in the dashboard; rotation invalidates sessions.
- Security headers: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, CSP.
- Uploads stored under `data/uploads/<jobId>/`; retention cleanup after configured days.
- Jobs stored in `data/jobs.json`.

## Notes for the shop

- Live printing requires the print driver of the target machine (SumatraPDF on Windows, CUPS on Linux/macOS).
- The operator dashboard prints the selected printer; live mode sends the imposed print-ready PDF.
- Keep the shop PC on the same Wi-Fi/LAN as customer phones for the QR-driven portal.

## Source credits

AL SHAJAR team implementation; shared code authored for AL SHAJAR STATIONERY.
