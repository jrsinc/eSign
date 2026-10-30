# Method 365

Electronic signatures for JRS.

A self-hosted electronic signature system: upload a PDF, place signature fields, send it to signers, and get back a digitally signed, locked PDF with an audit report.

**Going live?** See [PRODUCTION.md](PRODUCTION.md): server, HTTPS, company email, moving your data, backups.

## Features

- **Personal accounts**: email + password + emailed one-time code. Administrators add users, set passwords and grant access (audit trail view/download, full administrator).
- **Agreements**: upload or merge PDFs, organize pages, place 17 field types, copy and paste fields, numbered signing order, reminders. Sent agreements get an ID and can be cancelled, never deleted.
- **Signer identity**: only the invited recipient can sign. Account holders sign in and re-enter their password; outside recipients get a one-time temporary password by email. Wrong passwords lock signing and notify the sender.
- **Completed PDF**: values stamped onto the pages, a signature page per signer, an Adobe-style audit report, certificate-based digital signatures and a certification lock.
- **Tamper check**: `/verify.html` checks a signed PDF against the records and its embedded signatures.
- **Policies**: `/policy.html` holds the Electronic Record and Signature Disclosure, privacy policy, retention and terms of use. Signers agree to the disclosure before signing, and its version is recorded with each signature.
- **Administration**: hash-chained system log, audit trail PDFs, print copies, company list, backup and restore.

## Run it (testing on this PC)

Requires Node.js 20.12 or newer.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. On first visit, create the first administrator with the setup password (`ADMIN_PASSWORD`).

## Tests and CI/CD

```bash
npm test
```

Runs every suite in `test/` against its own temporary server (email off, no `.env`). `npm test -- identity` runs one suite.
GitHub Actions runs the tests and a Docker build on every push, and deploys `main` to production automatically
when the server is set up for it (see [PRODUCTION.md](PRODUCTION.md), section 3a).

## Configuration

Copy `.env.example` to `.env`, fill it in, and restart. Every setting is explained in that file. `.env` is git-ignored.

| Variable | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | Setup password for the first administrator. **Set this.** | `admin` |
| `COMPANY_NAME`, `AGREEMENT_PREFIX` | Shown in the UI, emails and certificates; agreement numbers | `Our Company`, `AGR` |
| `BASE_URL` | Public URL used in signing links, e.g. `https://esign.yourcompany.com` | `http://localhost:3000` |
| `NODE_ENV` | `production` turns on start-up safety checks | |
| `PORT`, `DATA_DIR`, `BACKUP_DIR` | Port, data folder, backups folder | `3000`, `./data`, `./backups` |
| `AUTO_BACKUP_HOURS`, `BACKUP_KEEP` | Automatic backups until a schedule is set on the Backup page (production: daily 02:00) | off, 14 |
| `SYSTEM_ADMIN_EMAIL` | The only account allowed to restart the server or erase data | first administrator |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing email | email off |
| `NOTIFY_EMAIL` | Copy of "signed", "declined", "completed" and "signing locked" notices | off |
| `SESSION_IDLE_MINUTES`, `TRUST_PROXY`, `PKI_COUNTRY` | Advanced | `30`, private networks, `US` |

### Email

All email is sent from `esign-jrsllc@method365sign.com`, the company mailbox on the webhostbox cPanel server:

1. In `.env`: `SMTP_HOST=sh00007.webhostbox.net`, `SMTP_PORT=465`, `SMTP_SECURE=true`, and `SMTP_USER`, `MAIL_FROM`, `NOTIFY_EMAIL`, `SUPPORT_EMAIL` = `esign-jrsllc@method365sign.com`. Put the mailbox password in `SMTP_PASS`.
2. Make sure the domain's SPF, DKIM and DMARC records exist (see [PRODUCTION.md](PRODUCTION.md) section 6).
3. Restart, then add a test user with an outside email: the welcome email confirms sending works.

## Going live

Follow [PRODUCTION.md](PRODUCTION.md): Docker (`docker compose up -d --build`, HTTPS by Caddy), a Linux service (`deploy/esign.service`), or Windows Server. Ready-made files are in `deploy/`.

## Desktop and installable app

Both are windows onto the **same server and database**. Nothing about agreements is stored on the PC.

### Installable web app (no installer needed)

1. Open the eSign address over **HTTPS** in Chrome or Edge (e.g. the ngrok or company address). Installing does not work over plain `http://` IP addresses.
2. Click the **Install** icon (⊕) in the address bar, or menu ⋮ → *Apps* → *Install Method 365*.
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
lib/finalize.js    Builds the signed PDF, signature pages and audit report
lib/pdfsign.js, pki.js, verifysig.js   Digital signatures and their verification
lib/audit.js       Hash-chained audit trail and system log
lib/reports.js     Audit trail / system log PDFs and print copies
lib/mailer.js      SMTP email
public/            Dashboard (index.html, admin.js), signer page (sign.html, sign.js), verify page
public/manifest.webmanifest, sw.js, offline.html, icons/   Installable web app
desktop/           Windows desktop app (Electron)
Dockerfile, docker-compose.yml, deploy/   Production setup (see PRODUCTION.md)
```
