# Going live: JRS eSign in production

Today the app runs on one PC and reaches the internet through ngrok. That works for testing, but it
stops whenever the PC sleeps, restarts or the session ends. For real agreements, run it on a server
that is always on, with its own HTTPS address and company email.

## 1. What you need

| Item | Example | Notes |
|---|---|---|
| A server, always on | Linux VM with 1 vCPU, 2 GB RAM, 20 GB disk (Azure, AWS, DigitalOcean, or your own) | Windows Server also works (section 5) |
| A web address | `esign.method365sign.com` | A DNS **A record** pointing at the server's public IP |
| Open ports | 80 and 443 | For HTTPS and its automatic certificate |
| A sending mailbox | `esign-jrsllc@method365sign.com` | SMTP details from your email provider (section 6) |
| Email DNS records | SPF, DKIM, DMARC for `method365sign.com` | So emails land in the inbox, not spam |

## 2. Settings (`.env`)

Copy `.env.example` to `.env` on the server and fill it in. Required in production:

- `BASE_URL`: the public `https://` address (signing links use it)
- `ESIGN_DOMAIN`: the same host without `https://` (Docker setup only)
- `ADMIN_PASSWORD`: long and random; needed once to create the first administrator
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`

With `NODE_ENV=production` the server **refuses to start** if any of these are missing or weak, and
says which. `.env` holds passwords: keep it readable only by the server account, and never put it in Git.

## 3. Option A: Docker (recommended)

On a Linux server with Docker installed:

```bash
git clone https://github.com/jrsinc/eSign.git /opt/esign
cd /opt/esign
cp .env.example .env
nano .env
docker compose up -d --build
```

- Caddy gets the HTTPS certificate automatically on first start (DNS must already point at the server).
- Check it: `docker compose ps` (both "healthy"/"running") and open `https://esign.method365sign.com/healthz`.
- Logs: `docker compose logs -f esign`
- Data lives in the Docker volumes `esign-data` and `esign-backups`, and survives updates and restarts.

**Update to a new version:**

```bash
cd /opt/esign && git pull && docker compose up -d --build
```

## 4. Option B: Linux without Docker

```bash
# Node.js 24 LTS, then:
sudo useradd --system --home /opt/esign esign
sudo git clone https://github.com/jrsinc/eSign.git /opt/esign
cd /opt/esign && sudo npm ci --omit=dev
sudo cp .env.example .env && sudo nano .env
sudo mkdir -p data backups && sudo chown -R esign:esign /opt/esign && sudo chmod 600 .env
sudo cp deploy/esign.service /etc/systemd/system/ && sudo systemctl enable --now esign
```

For HTTPS use **Caddy** (`deploy/Caddyfile`, change `esign:3000` to `127.0.0.1:3000`) or **Nginx**
(`deploy/nginx-esign.conf` + `certbot --nginx`). Logs: `journalctl -u esign -f`.

## 5. Option C: Windows Server

1. Install Node.js 24 LTS and copy the project to e.g. `C:\esign`, then `npm ci --omit=dev`.
2. Create `C:\esign\.env` from `.env.example`.
3. Run it as a Windows service with [NSSM](https://nssm.cc): `nssm install JRS-eSign "C:\Program Files\nodejs\node.exe" server.js`,
   set *Startup directory* to `C:\esign`, then `nssm start JRS-eSign`.
4. HTTPS: install Caddy as a service too, with `deploy/Caddyfile` (use `127.0.0.1:3000`), or use IIS with
   URL Rewrite + ARR as a reverse proxy and your company certificate.

## 6. Email from esign-jrsllc@method365sign.com

**Microsoft 365**
- `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, `SMTP_USER` and `MAIL_FROM` = the mailbox.
- In the Microsoft 365 admin center → the mailbox → *Mail* → *Manage email apps* → enable **Authenticated SMTP**.
- Microsoft is retiring password-based SMTP sign-in. If it's blocked for your tenant, either use a
  sending service (Amazon SES, SendGrid, Postmark: they give SMTP settings that work here unchanged),
  or ask for OAuth2 sign-in support to be added to the app.

**Google Workspace**
- `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, and an **App Password** for the mailbox (needs 2-Step Verification).

**DNS for method365sign.com** (your DNS or email admin sets these once):
- **SPF**: a TXT record allowing your provider to send, e.g. `v=spf1 include:spf.protection.outlook.com -all`
- **DKIM**: turn it on in the provider's admin console and add the records it gives you
- **DMARC**: e.g. `v=DMARC1; p=none; rua=mailto:dmarc@method365sign.com` (tighten to `quarantine` later)

Then sign in, add a test user with your own email and check the welcome email arrives in the **inbox**.

## 7. Moving your current data from this PC

1. On the current system: **Admin ▾ → Backup and restore → Download backup**.
2. Start the new server and create a temporary first administrator (the setup page appears on first visit).
3. On the new server: **Admin ▾ → Backup and restore → Restore** with that file. Everything comes across:
   agreements, PDFs, users with their passwords, companies, the system log and the signing certificate keys.
4. Sign in again with your usual account. The temporary administrator from step 2 is replaced by the backup's users.
5. **Signing links already emailed point to the old ngrok address.** For agreements still waiting, open each
   one and click **Send reminder**: the reminder carries a link with the new address.
6. Point the desktop app at the new address: edit `desktop/config.json` before building the installer,
   use **File → Settings** on installed PCs, or set `ESIGN_SERVER_URL` company-wide.

Keep the backup file private: it contains every document and the keys that sign them.

## 8. Backups

- `AUTO_BACKUP_HOURS=24` writes a backup every day to the backups folder, keeping the newest `BACKUP_KEEP` (14).
- **Copy backups off the server** too (another site or cloud storage), for example daily:
  - Docker: `docker run --rm -v esign_esign-backups:/b -v /srv/offsite:/out alpine sh -c "cp /b/*.esbackup /out/"`
  - Linux: `rsync -a /opt/esign/backups/ backup-host:/esign-backups/`
- Test a restore every few months on a spare server.
- A manual backup is always available under **Admin ▾ → Backup and restore**.

## 9. Security checklist

- [ ] HTTPS only, with `BASE_URL` set to the `https://` address
- [ ] Strong `ADMIN_PASSWORD`; `.env` readable only by the server account
- [ ] Only ports 80 and 443 open to the internet (not 3000)
- [ ] Server OS updates switched on
- [ ] Automatic backups on, and copied off the server
- [ ] SPF, DKIM and DMARC records for the sending domain
- [ ] An uptime monitor on `https://<your address>/healthz` (e.g. UptimeRobot)
- [ ] ngrok stopped once the new address is live

Built in: security headers (Content-Security-Policy, HSTS, no framing, no referrer leaks of signing
links), audit IP addresses taken only from trusted proxies, sessions over HTTPS-only cookies, and the
production start-up checks above.

## 10. Day-to-day

| Task | Docker | Linux service |
|---|---|---|
| Status | `docker compose ps` | `systemctl status esign` |
| Logs | `docker compose logs -f esign` | `journalctl -u esign -f` |
| Restart (after editing `.env`) | `docker compose up -d` | `sudo systemctl restart esign` |
| Update | `git pull && docker compose up -d --build` | `git pull && npm ci --omit=dev && sudo systemctl restart esign` |
