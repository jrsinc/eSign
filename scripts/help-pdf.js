// Prints the Help Center page (public/help.html) to public/help/Method365-User-Manual.pdf, the PDF the
// Help Center offers for download. Run it after changing the manual, with Method 365 running:
//   node scripts/help-pdf.js [http://localhost:3000/help.html]
// Uses Google Chrome or Microsoft Edge in headless mode.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.argv[2] || 'http://localhost:3000/help.html';
const out = path.join(__dirname, '..', 'public', 'help', 'Method365-User-Manual.pdf');
const browsers = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = browsers.find((p) => fs.existsSync(p));
if (!exe) { console.error('Chrome or Edge not found; set CHROME_PATH.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-help-pdf-'));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) await sleep(250);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++n; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable');
  await send('Page.navigate', { url });
  // Wait until every screenshot has loaded.
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: "document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth > 0)", returnByValue: true });
    if (r.result.value) break;
    await sleep(250);
  }
  const footer = '<div style="font:8px Segoe UI,Arial,sans-serif;color:#6b7280;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>Method 365 User Manual v2.0 &middot; Jupiter Research Services</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
  const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: footer, marginBottom: 0.6 });
  fs.writeFileSync(out, Buffer.from(pdf.data, 'base64'));
  console.log(`Saved ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  ws.close();
  browser.kill();
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 1000);
})().catch((e) => { console.error(e); browser.kill(); process.exit(1); });
