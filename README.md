# Company eSign

A self-hosted electronic signature system: upload a PDF, place signature fields, send it to signers, and get back a signed PDF with an audit certificate.

## Features

- **Admin dashboard** (password protected): upload PDFs; add signers; drag and drop fields (signature, initials, date signed, full name, text, checkbox); send; void; send reminders; delete
- **Signing order**: everyone at once, or one after another
- **Signer page**: personal secure link (no account needed); draw or type a signature; guided "next field" navigation; consent checkbox; decline option
- **Completed PDF**: values stamped onto the pages, an envelope ID footer on every page, and an appended **Certificate of Completion** (signers, emails, IPs, devices, timestamps, consent, full event history, SHA-256 of the original)
- **Tamper check**: `/verify.html` lets anyone upload a signed PDF to confirm it matches the stored SHA-256 fingerprint
- **Email** via any SMTP server (optional). Without SMTP, copy each signer's link from the dashboard.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. The default password is `admin`.

## Configuration (environment variables)

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Dashboard password. **Set this.** | `admin` |
| `COMPANY_NAME` | Shown in the UI, emails and certificate | `Our Company` |
| `BASE_URL` | Public URL used in signing links, e.g. `https://sign.yourcompany.com` | `http://localhost:3000` |
| `PORT` | HTTP port | `3000` |
| `DATA_DIR` | Where the database and PDFs are stored | `./data` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email (e.g. Gmail, Microsoft 365, SendGrid SMTP) | email off |

| `NOTIFY_EMAIL` | Gets "X signed", "declined" and "completed" emails (with the signed PDF) | off |

The easiest way is a `.env` file: copy `.env.example` to `.env`, fill it in, and restart. `.env` is git-ignored.

### Email with Microsoft 365 (Outlook)

1. Pick a mailbox to send from, e.g. `esign@yourcompany.com` (a normal licensed user or shared mailbox with a password).
2. In the **Microsoft 365 admin center** → Users → that user → **Mail** → *Manage email apps* → tick **Authenticated SMTP**. (Tenant-wide SMTP AUTH must not be disabled.)
3. If the mailbox uses MFA, create an **app password** for it and use that as `SMTP_PASS`.
4. In `.env`: `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, `SMTP_USER` and `MAIL_FROM` = that mailbox.
5. Restart, then use **Send test email** on the dashboard.

Gmail / Google Workspace: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, and an App Password.

## Going live checklist

1. Put it behind **HTTPS** (e.g. Caddy, Nginx, or IIS reverse proxy) and set `BASE_URL` to the https address.
2. Set a strong `ADMIN_PASSWORD`.
3. Configure SMTP so signers get emails automatically.
4. **Back up the `data/` folder** regularly: it holds every document, signed copy and audit trail.

## Desktop and installable app

Both are windows onto the **same server and database**. Nothing about agreements is stored on the PC.

### Installable web app (no installer needed)

1. Open the eSign address over **HTTPS** in Chrome or Edge (e.g. the ngrok or company address). Installing does not work over plain `http://` IP addresses.
2. Click the **Install** icon (⊕) in the address bar, or menu ⋮ → *Apps* → *Install JRS LLC eSign*.
3. It gets its own window, Start-menu and taskbar icon, desktop notifications, and an offline screen. Updates arrive automatically with the website.

The service worker caches only the page design and the offline page, never agreements, PDFs or `/api/` data.

### Windows desktop app (`desktop/`)

```bash
cd desktop
npm install
npm start          # run it
npm run dist       # build the installer: desktop/dist/JRS eSign Setup <version>.exe
npm run icons      # rebuild icons after changing public/logo.png
```

- Server address: set in `desktop/config.json` before building, changeable later in **File → Settings**. IT can force it on every PC with the `ESIGN_SERVER_URL` environment variable.
- Tray icon (keeps notifications coming when the window is closed), optional *Start with Windows*, offline screen with automatic retry.
- Security: only the eSign server's pages open inside the app (other links open in the browser); the website has no access to the PC; only notification and clipboard permissions are granted.
- The installer is not code-signed, so Windows SmartScreen shows "Windows protected your PC" → *More info* → *Run anyway*. For company-wide rollout, sign it with a code-signing certificate.

## Legal note

Signatures made this way are "simple electronic signatures", backed by an audit trail and consent record. They are legally accepted for most business contracts in many places (e.g. US ESIGN/UETA, EU eIDAS, India IT Act for many document types). Some documents need stronger signatures or wet ink, such as wills, some property transfers, or qualified/Aadhaar e-signatures in some countries. Check with your lawyer for your use cases.

## Project layout

```
server.js          API + routes
lib/store.js       JSON-file database
lib/finalize.js    Builds the signed PDF + certificate
lib/mailer.js      SMTP email
public/            Dashboard (index.html, admin.js), signer page (sign.html, sign.js), verify.html
public/manifest.webmanifest, sw.js, offline.html, icons/   Installable web app
desktop/           Windows desktop app (Electron)
```
