# Method 365 on a Windows server PC

Move Method 365 from the development PC to its own Windows PC, running as a service at
**https://esign.method365sign.com** through a Cloudflare tunnel. No router changes or open ports are needed.

Time: about 1 hour, plus waiting for Cloudflare to activate the domain.

| Part | Where | What |
|---|---|---|
| A | Server PC | Prepare Windows |
| B | Old PC | Make a backup, stop Method 365, copy `.env` and `data` |
| C | Server PC | Run the setup script |
| D | Cloudflare + server PC | Domain and tunnel for esign.method365sign.com |
| E | Browser | Check everything, resend pending links |
| F | Server PC | Turn on production settings |
| G | — | Day-to-day: status, logs, updates, backups |

---

## A. Prepare the server PC

1. Windows 10 or 11 (Pro recommended), fully updated, signed in with an **administrator** account.
2. **Never sleep:** Settings → System → Power → *Screen and sleep*: Sleep = **Never**.
3. **Start after a power cut:** in the BIOS, set *Restore on AC power loss* = **On**. A small UPS is strongly recommended.
4. **Encrypt the disk:** Settings → Privacy & security → Device encryption (or BitLocker) = **On**. The PC will hold every signed agreement and the signing keys.
5. Keep Windows Update on. The Method 365 and Cloudflare services start again by themselves after an update restart.

## B. On the old PC

1. Sign in to Method 365 → **Admin → Backup and restore → Download backup**. Keep this file somewhere safe: it is your safety copy.
2. **Stop Method 365 and ngrok** on the old PC, so nothing changes after you copy the data.
3. Copy these two from `C:\Users\mayur\Desktop\company-esign` to a USB stick:
   - the file **`.env`** (settings and the mailbox password)
   - the folder **`data`** (agreements, PDFs, users, signing keys, logs)

   Keep the USB stick private and wipe it after part E.

## C. Install Method 365 on the server PC

1. Open **PowerShell as administrator** (Start → type PowerShell → right-click → *Run as administrator*).
2. Download and run the setup script:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   irm https://raw.githubusercontent.com/jrsinc/eSign/main/deploy/windows/setup.ps1 -OutFile $env:TEMP\m365-setup.ps1
   & $env:TEMP\m365-setup.ps1
   ```
   It installs Node.js, Git, NSSM, cloudflared and LibreOffice (for Word uploads), downloads the code to **`C:\Method365`**, then stops and asks for `.env` and `data`.
3. Copy **`.env`** and the **`data`** folder from the USB stick into **`C:\Method365`**.
4. Open `C:\Method365\.env` in Notepad and change one line:
   ```
   BASE_URL=https://esign.method365sign.com
   ```
5. Run the script again:
   ```powershell
   & $env:TEMP\m365-setup.ps1
   ```
   This time it installs the **Method365** Windows service, starts it, and checks it is healthy.
6. On the server PC, open **http://localhost:3000** and sign in with your usual account. Your agreements and users are all there.

## D. Cloudflare: domain and tunnel

1. **dash.cloudflare.com** → *Add a domain* → `method365sign.com` → **Free** plan.
2. Check these DNS records exist (add any missing):

   | Type | Name | Value | Proxy |
   |---|---|---|---|
   | A | `mail` | `66.116.209.229` | **DNS only** (grey cloud) |
   | MX | `@` | `mail.method365sign.com`, priority 10 | — |
   | TXT | `@` | `v=spf1 +mx +a +ip4:66.116.209.229 ~all` | — |
   | TXT | `default._domainkey` | the DKIM value from cPanel → Email Deliverability | — |
   | TXT | `_dmarc` | `v=DMARC1; p=none;` | — |

3. At **whois.com** → method365sign.com → **Name Servers**: replace the `ns*.whois.com` entries with the two Cloudflare name servers.
4. Wait for Cloudflare's "method365sign.com is now active" email.
5. Cloudflare → **Zero Trust → Networks → Tunnels → Create a tunnel** → *Cloudflared* → name `method365`.
6. Choose **Windows** and copy the `cloudflared.exe service install <token>` command. Run it in the **administrator PowerShell on the server PC**. (If "cloudflared.exe is not recognized", put `& "C:\Program Files (x86)\cloudflared\cloudflared.exe"` in front of `service install`.)
7. **Public hostname**: subdomain `esign`, domain `method365sign.com`, type **HTTP**, URL `localhost:3000` → Save.

## E. Check and switch over

1. Open **https://esign.method365sign.com/healthz**: it should show `{"ok":true,...}`. Then open **https://esign.method365sign.com** and sign in.
2. Add a test user with your own outside email (Gmail) and one jrsllc.com address: both welcome emails should arrive. Their links now point to esign.method365sign.com, which Microsoft 365 does not treat as phishing.
3. On every agreement still **Out for signature**, click **Send reminder**: old emails link to the ngrok address, which no longer works.
4. Desktop app: **File → Settings** → `https://esign.method365sign.com` on each PC. People who installed the web app reinstall it from the new address.
5. Old PC: uninstall ngrok, and delete its copies of `.env` and `data` once you are sure the server has everything. Wipe the USB stick.

## F. Production settings (after emails work)

Edit `C:\Method365\.env`:

```
NODE_ENV=production
BACKUP_DIR=D:\Method365-backups
```

- **Delete the line `LOGIN_CODE=off`** so sign-in needs the emailed code again.
- `BACKUP_DIR`: another disk, or a OneDrive / Google Drive folder so a copy leaves the PC.
- Automatic backups run **daily at 02:00** in production. Change the schedule (every few hours, daily, weekly, how many to keep) under **Admin → Backup and restore**; every backup is listed there to download, with a backup log.
- `ADMIN_PASSWORD` must be at least 12 characters in production.

Then restart: `nssm restart Method365`. Production mode refuses to start if anything is unsafe and writes the reason to `C:\Method365\logs\method365.log`.

## G. Day to day

| Task | How (PowerShell as administrator) |
|---|---|
| Is it running? | `nssm status Method365` · or open https://esign.method365sign.com/healthz |
| Restart (after editing `.env`) | `nssm restart Method365` |
| Logs | `C:\Method365\logs\method365.log` |
| Update to the latest version | In the app: **Admin → Server restart → Back up, update and restart** (system administrator only). Or on the PC: `C:\Method365\deploy\windows\update.ps1`, which also rolls back on its own if the new version is not healthy |
| Start again with no data | **Admin → Server restart → Back up, erase all data and restart** (system administrator only; a backup is saved first, then the first-time setup page appears) |
| Backups | automatic, daily at 02:00 unless changed; schedule, list, downloads and log: **Admin → Backup and restore** |
| Tunnel status | Cloudflare → Zero Trust → Networks → Tunnels (should say *Healthy*) |
| Uptime alerts | add https://esign.method365sign.com/healthz to a free monitor such as UptimeRobot |

**If the PC, internet or power is down, nobody can sign until it is back.** When Method 365 becomes business-critical, move to a cloud server: the Docker setup in PRODUCTION.md is ready, and a backup file moves everything.
