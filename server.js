// Settings (SMTP, password, company name) live in .env next to this file.
// ENV_FILE=none skips it (used for test servers so they never send real email).
if (process.env.ENV_FILE !== 'none') {
  try {
    process.loadEnvFile(process.env.ENV_FILE || require('path').join(__dirname, '.env'));
  } catch {}
}

const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const mailer = require('./lib/mailer');
const { finalize, pageFrame } = require('./lib/finalize');
const { DATE_FORMATS, validTz, formatDate, formatIsoDay, auditStamp } = require('./lib/dates');
const { PDFDocument, degrees } = require('pdf-lib');
const { loadOrCreateCA, issueSignerCertificate } = require('./lib/pki');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const COMPANY = mailer.COMPANY;
const SENDER_EMAIL = process.env.NOTIFY_EMAIL || process.env.MAIL_FROM || '';
// The app's own certificate authority for digital signatures (created on first run in data/pki).
const CA = loadOrCreateCA(path.join(store.DATA_DIR, 'pki'), COMPANY);
const AGREEMENT_PREFIX = String(process.env.AGREEMENT_PREFIX || 'AGR').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'AGR';
if (!process.env.ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD not set, using "admin". Set it before real use.');

const app = express();
// Express 4 does not catch rejected promises from async handlers; route them to the error handler.
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (route, ...handlers) =>
    orig(route, ...handlers.map((h) => (typeof h === 'function' && h.length < 4 ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next) : h)));
}
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const id = (n = 12) => crypto.randomBytes(n).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();
const clientIp = (req) => (req.ip || '').replace(/^::ffff:/, '');
const filePath = (name) => path.join(store.FILES_DIR, name);
const signLink = (s) => `${BASE_URL}/sign.html?t=${s.token}`;
const who = (s) => `${s.name} (${s.email})`;
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
const FIELD_TYPES = ['signature', 'initials', 'date', 'name', 'email', 'company', 'title', 'text', 'number', 'datefield', 'checkbox', 'radio', 'dropdown'];
const FONTS = ['Helvetica', 'Times', 'Courier'];
const REMINDERS = { none: 0, daily: 864e5, every2days: 2 * 864e5, weekly: 7 * 864e5 };
const REASONS = ['I approve this document', 'I have reviewed this document', 'I am the author of this document', 'I agree to the terms of this document', 'I certify the information is true and correct'];

// Audit events. `type` picks the icon in the audit report; `detail` replaces the default "time - IP" line.
function log(doc, text, req, type = 'info', detail) {
  doc.events.push({ at: now(), text, ip: req ? clientIp(req) : undefined, type, ...(detail ? { detail } : {}) });
}

// ---------- Admin auth (sessions survive restarts) ----------
const SESSIONS_FILE = path.join(store.DATA_DIR, 'sessions.json');
const sessions = new Map(fs.existsSync(SESSIONS_FILE) ? Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) : []);
const saveSessions = () => {
  for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
};
function requireAdmin(req, res, next) {
  const s = sessions.get(req.cookies.sid);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.post('/api/login', (req, res) => {
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const ok = typeof req.body.password === 'string' && crypto.timingSafeEqual(digest(req.body.password), digest(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Wrong password' });
  const sid = id(24);
  sessions.set(sid, { expires: Date.now() + 12 * 3600 * 1000 });
  saveSessions();
  // HTTPS-only when the visitor came in over HTTPS (e.g. through ngrok), so local http:// access still works.
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  sessions.delete(req.cookies.sid);
  saveSessions();
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.get('/api/me', requireAdmin, (req, res) =>
  res.json({ company: COMPANY, mail: mailer.enabled(), notify: process.env.NOTIFY_EMAIL || '', dateFormats: DATE_FORMATS, reasons: REASONS }));

app.post('/api/test-email', requireAdmin, async (req, res) => {
  if (!mailer.enabled()) return res.status(400).json({ error: 'Email is off. Add your SMTP settings to the .env file and restart.' });
  const to = String(req.body.to || '').trim();
  if (!isEmail(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    await mailer.send({ to, subject: `${COMPANY} eSign test email`, heading: 'Email is working', text: 'Your e-signature system can send email. Signers will now receive their signing links automatically.' });
    res.json({ ok: true });
  } catch (e) {
    const loginRejected = e.responseCode === 535 || e.code === 'EAUTH';
    res.status(400).json({
      error: loginRejected
        ? 'The mail server rejected the login. For Gmail, SMTP_PASS must be a Google App Password (not your normal password), and 2-Step Verification must be on.'
        : `Sending failed: ${e.message}`,
    });
  }
});

// Status emails to the sender, like DocuSign's "X has signed" notices.
async function notifySender(subject, text, attachments) {
  if (!process.env.NOTIFY_EMAIL) return;
  await mailer.send({ to: process.env.NOTIFY_EMAIL, subject, heading: subject, text, attachments }).catch((e) => console.error('Mail error:', e.message));
}

// ---------- PDF helpers ----------
async function loadPdf(buf) {
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw Object.assign(new Error('Please upload PDF files only.'), { status: 400 });
  try {
    return await PDFDocument.load(buf);
  } catch {
    throw Object.assign(new Error('One of the PDFs could not be opened. It may be password-protected or damaged.'), { status: 400 });
  }
}

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const b of buffers) {
    const src = await loadPdf(b);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

// ---------- Admin: documents ----------
function adminView(doc) {
  const { sources, ...rest } = doc;
  return {
    ...rest,
    // A signer only has a link once it is their turn (see issueLinks).
    signers: doc.signers.map(({ token, ...s }) => ({ ...s, link: token && doc.status === 'sent' ? signLink({ token }) : null })),
    fields: doc.fields.map((f) => ({ ...f, value: f.type === 'signature' || f.type === 'initials' ? (f.value ? '[signed]' : null) : f.value })),
  };
}

app.get('/api/documents', requireAdmin, (req, res) => {
  res.json(
    store.all().map((d) => ({
      id: d.id, agreementId: d.agreementId, title: d.title, status: d.status, createdAt: d.createdAt, completedAt: d.completedAt,
      signers: d.signers.map((s) => ({ name: s.name, email: s.email, status: s.status })),
    }))
  );
});

app.post('/api/documents', requireAdmin, upload.array('file', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Please upload a PDF file' });
  const bytes = req.files.length === 1 ? (await loadPdf(req.files[0].buffer), req.files[0].buffer) : await mergePdfs(req.files.map((f) => f.buffer));
  const doc = {
    id: id(9),
    transactionId: `CB${id(30)}`,
    title: (req.body.title || req.files[0].originalname.replace(/\.pdf$/i, '')).slice(0, 200),
    emailSubject: '',
    message: '',
    reminder: 'none',
    requireReason: true,
    stampPage: true,
    digitalSign: true,
    status: 'draft',
    signingOrder: 'sequential',
    senderName: COMPANY,
    senderEmail: SENDER_EMAIL,
    createdAt: now(),
    originalFile: `${id(9)}.pdf`,
    originalHash: sha256(bytes),
    signers: [],
    fields: [],
    events: [],
  };
  fs.writeFileSync(filePath(doc.originalFile), bytes);
  log(doc, `Document created by ${COMPANY}${SENDER_EMAIL ? ` (${SENDER_EMAIL})` : ''}`, req, 'created');
  if (req.files.length > 1) log(doc, `${req.files.length} files merged: ${req.files.map((f) => f.originalname).join(', ')}`, req, 'pages');
  store.insert(doc);
  res.json(adminView(doc));
});

app.get('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(adminView(doc));
});

function cleanField(f) {
  const st = f.style || {};
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  return {
    id: typeof f.id === 'string' && f.id ? f.id.slice(0, 40) : id(6),
    signerId: f.signerId,
    type: f.type,
    page: Math.max(0, Math.floor(Number(f.page) || 0)),
    x: clamp(f.x), y: clamp(f.y), w: clamp(f.w), h: clamp(f.h),
    required: f.type === 'checkbox' || f.type === 'radio' ? !!f.required : f.required !== false,
    label: String(f.label || '').slice(0, 80),
    dateFormat: DATE_FORMATS.includes(f.dateFormat) ? f.dateFormat : 'MM/DD/YYYY',
    options: Array.isArray(f.options) ? f.options.map((o) => String(o).trim().slice(0, 100)).filter(Boolean).slice(0, 50) : [],
    group: String(f.group || '').slice(0, 60),
    appearance: f.type === 'signature' && f.appearance === 'digital' ? 'digital' : 'standard',
    style: {
      font: FONTS.includes(st.font) ? st.font : 'Helvetica',
      size: st.size === 'auto' || !st.size ? 'auto' : Math.min(36, Math.max(6, Number(st.size) || 10)),
      color: /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#000000',
      align: ['left', 'center', 'right'].includes(st.align) ? st.align : 'left',
    },
    value: null,
  };
}

app.put('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be edited' });
  const { title, message, emailSubject, signingOrder, reminder, requireReason, stampPage, signers, fields } = req.body;
  if (typeof stampPage === 'boolean') doc.stampPage = stampPage;
  if (typeof req.body.digitalSign === 'boolean') doc.digitalSign = req.body.digitalSign;
  if (typeof title === 'string' && title.trim()) doc.title = title.trim().slice(0, 200);
  if (typeof message === 'string') doc.message = message.slice(0, 2000);
  if (typeof emailSubject === 'string') doc.emailSubject = emailSubject.slice(0, 200);
  if (signingOrder === 'parallel' || signingOrder === 'sequential') doc.signingOrder = signingOrder;
  if (reminder in REMINDERS) doc.reminder = reminder;
  if (typeof requireReason === 'boolean') doc.requireReason = requireReason;
  if (Array.isArray(signers)) {
    doc.signers = signers.slice(0, 20).map((s, i) => ({
      id: typeof s.id === 'string' && s.id ? s.id : id(6),
      name: String(s.name || '').trim().slice(0, 120),
      email: String(s.email || '').trim().toLowerCase().slice(0, 200),
      order: i + 1,
      color: COLORS[i % COLORS.length],
      status: 'pending',
    }));
  }
  if (Array.isArray(fields)) {
    const ids = new Set(doc.signers.map((s) => s.id));
    doc.fields = fields.filter((f) => ids.has(f.signerId) && FIELD_TYPES.includes(f.type)).slice(0, 1000).map(cleanField);
  }
  store.save();
  res.json(adminView(doc));
});

function removeFiles(doc) {
  const files = [doc.originalFile, doc.finalFile, ...Object.values(doc.sources || {}).map((s) => s.file)];
  for (const f of files) if (f && fs.existsSync(filePath(f))) fs.unlinkSync(filePath(f));
}

// Only unsent drafts can be discarded. Once sent, a document is an agreement: it can be cancelled, never deleted.
app.delete('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(403).json({ error: 'Agreements cannot be deleted. Cancel it instead.' });
  removeFiles(doc);
  store.remove(doc.id);
  res.json({ ok: true });
});

// ---------- Admin: merge files & organize pages ----------
app.post('/api/documents/:id/sources', requireAdmin, upload.array('file', 20), async (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || doc.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be changed' });
  if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one PDF' });
  const added = [];
  for (const f of req.files) {
    const pdf = await loadPdf(f.buffer);
    const sid = id(6);
    const file = `${id(9)}-src.pdf`;
    fs.writeFileSync(filePath(file), f.buffer);
    doc.sources = { ...(doc.sources || {}), [sid]: { file, name: f.originalname, pages: pdf.getPageCount() } };
    added.push({ id: sid, name: f.originalname, pages: pdf.getPageCount() });
  }
  store.save();
  res.json(added);
});

app.get('/api/documents/:id/sources/:sid', requireAdmin, (req, res) => {
  const src = store.get(req.params.id)?.sources?.[req.params.sid];
  if (!src) return res.status(404).end();
  sendPdf(res, src.file, src.name, true);
});

// Rotating a page turns the field layout with it; field sizes stay the same in points.
function turnField(f, quarterTurns, before, after) {
  let cx = (f.x + f.w / 2) * before.width;
  let cy = (f.y + f.h / 2) * before.height;
  let W = before.width, H = before.height;
  for (let i = 0; i < quarterTurns; i++) {
    [cx, cy] = [H - cy, cx];
    [W, H] = [H, W];
  }
  const w = Math.min(1, (f.w * before.width) / after.width);
  const h = Math.min(1, (f.h * before.height) / after.height);
  const clamp = (v, size) => Math.min(1 - size, Math.max(0, v));
  return { ...f, x: clamp(cx / after.width - w / 2, w), y: clamp(cy / after.height - h / 2, h), w, h };
}

app.post('/api/documents/:id/pages', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || doc.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be changed' });
  const plan = req.body.pages;
  if (!Array.isArray(plan) || !plan.length || plan.length > 1000) return res.status(400).json({ error: 'The document needs at least one page.' });

  const srcPdfs = { doc: await PDFDocument.load(fs.readFileSync(filePath(doc.originalFile))) };
  for (const [sid, s] of Object.entries(doc.sources || {})) srcPdfs[sid] = await PDFDocument.load(fs.readFileSync(filePath(s.file)));

  const out = await PDFDocument.create();
  const fields = [];
  const usedIds = new Set();
  for (const [newIndex, item] of plan.entries()) {
    const src = srcPdfs[item.src];
    const index = Number(item.index);
    if (!src || !Number.isInteger(index) || index < 0 || index >= src.getPageCount()) return res.status(400).json({ error: 'Invalid page selection.' });
    const turn = ((Math.round((Number(item.rotate) || 0) / 90) % 4) + 4) % 4;
    const [page] = await out.copyPages(src, [index]);
    const before = pageFrame(page);
    page.setRotation(degrees((page.getRotation().angle + turn * 90) % 360));
    out.addPage(page);
    const after = pageFrame(page);
    if (item.src !== 'doc') continue;
    for (const f of doc.fields.filter((x) => x.page === index)) {
      const moved = { ...turnField(f, turn, before, after), page: newIndex };
      if (usedIds.has(moved.id)) moved.id = id(6);
      usedIds.add(moved.id);
      fields.push(moved);
    }
  }

  const bytes = Buffer.from(await out.save());
  removeFiles({ originalFile: doc.originalFile, sources: doc.sources });
  delete doc.sources;
  doc.originalFile = `${id(9)}.pdf`;
  doc.originalHash = sha256(bytes);
  doc.fields = fields;
  fs.writeFileSync(filePath(doc.originalFile), bytes);
  log(doc, `Pages organized: document now has ${plan.length} page${plan.length > 1 ? 's' : ''}`, req, 'pages');
  store.save();
  res.json(adminView(doc));
});

// ---------- Sending ----------
function activeSigners(doc) {
  const pending = doc.signers.filter((s) => s.status !== 'signed');
  if (doc.signingOrder === 'parallel') return pending;
  return pending.length ? [pending.sort((a, b) => a.order - b.order)[0]] : [];
}

// Creates signing links only for the people whose turn it is. In sequential order that is one
// person at a time, so the 2nd signer has no link until the 1st has signed.
function issueLinks(doc) {
  const fresh = [];
  for (const s of activeSigners(doc)) {
    if (s.token) continue;
    s.token = id(24);
    fresh.push(s);
    log(doc, `Signing link issued to ${who(s)} (signer ${s.order} of ${doc.signers.length})`, null, 'info');
  }
  return fresh;
}

async function invite(doc, signer, reminder = false) {
  const base = doc.emailSubject?.trim() || `Please sign "${doc.title}"`;
  const subject = `${reminder ? 'Reminder: ' : ''}${base} [${doc.agreementId}]`;
  const text = `Hello ${signer.name},\n\n${COMPANY} has sent you "${doc.title}" to review and sign electronically.\nAgreement ID: ${doc.agreementId}${doc.message ? `\n\n${doc.message}` : ''}`;
  try {
    const sent = await mailer.send({
      to: signer.email, subject, heading: `${COMPANY} sent you a document to review and sign`, text,
      link: signLink(signer), linkLabel: 'REVIEW DOCUMENT', pixel: `${BASE_URL}/t/${signer.token}.gif`,
    });
    if (sent) {
      signer.lastEmailAt = now();
      log(doc, reminder ? `Reminder emailed to ${who(signer)}` : `Document emailed to ${who(signer)} for signature`, null, reminder ? 'reminder' : 'emailed');
    }
  } catch (e) {
    console.error('Mail error:', e.message);
    log(doc, `Email to ${who(signer)} failed: ${e.message}`, null, 'failed');
  }
}

app.post('/api/documents/:id/send', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Already sent' });
  if (!doc.signers.length) return res.status(400).json({ error: 'Add at least one signer' });
  for (const s of doc.signers) {
    const label = `Signer ${s.order}${s.name ? ` (${s.name})` : ''}`;
    if (!s.name) return res.status(400).json({ error: `${label}: please enter their full name.` });
    if (!isEmail(s.email)) return res.status(400).json({ error: `${label}: please enter a valid email address.` });
    if (!doc.fields.some((f) => f.signerId === s.id && f.type === 'signature')) return res.status(400).json({ error: `${s.name} has no signature field` });
  }
  for (const f of doc.fields) {
    if (f.type === 'dropdown' && !f.options.length) return res.status(400).json({ error: `Dropdown "${f.label || 'field'}" has no options yet.` });
  }
  doc.agreementId = store.nextAgreementId(AGREEMENT_PREFIX);
  doc.status = 'sent';
  doc.sentAt = now();
  log(doc, `Agreement ${doc.agreementId} created and sent for signature (${doc.signingOrder === 'sequential' ? 'in order' : 'all at once'}) to ${[...doc.signers].sort((a, b) => a.order - b.order).map((s) => `${s.order}. ${who(s)}`).join(', ')}`, req, 'created');
  const first = issueLinks(doc);
  store.save();
  for (const s of first) await invite(doc, s);
  store.save();
  res.json(adminView(doc));
});

app.post('/api/documents/:id/remind/:signerId', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  const signer = doc && doc.signers.find((s) => s.id === req.params.signerId);
  if (!signer || doc.status !== 'sent' || signer.status === 'signed') return res.status(400).json({ error: 'Cannot remind this signer' });
  if (!signer.token) return res.status(400).json({ error: `It is not ${signer.name}'s turn yet. They get their link after the previous signer signs.` });
  if (!mailer.enabled()) return res.status(400).json({ error: 'Email is not configured. Copy the signing link instead.' });
  await invite(doc, signer, true);
  store.save();
  res.json({ ok: true });
});

// Cancelling stops the agreement for good and tells every signer, including those who already signed.
app.post('/api/documents/:id/void', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || doc.status !== 'sent') return res.status(400).json({ error: 'Only agreements out for signature can be cancelled' });
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'Please give a reason for cancelling.' });
  doc.status = 'voided';
  doc.cancelledAt = now();
  doc.cancelReason = reason;
  log(doc, `Agreement ${doc.agreementId} cancelled by ${COMPANY}. Reason: ${reason}`, req, 'voided');
  store.save();

  const notified = [];
  for (const s of [...doc.signers].sort((a, b) => a.order - b.order)) {
    try {
      const sent = await mailer.send({
        to: s.email,
        subject: `Cancelled: "${doc.title}" [${doc.agreementId}]`,
        heading: 'This agreement has been cancelled',
        text: `Hello ${s.name},\n\n${COMPANY} has cancelled the agreement "${doc.title}" (Agreement ID: ${doc.agreementId}).\n\nReason: ${reason}\n\n${s.status === 'signed' ? 'Your signature on this agreement is no longer needed.' : 'You no longer need to sign it.'} No further action is required.`,
      });
      if (sent) notified.push(who(s));
    } catch (e) {
      console.error('Mail error:', e.message);
      log(doc, `Cancellation email to ${who(s)} failed: ${e.message}`, null, 'failed');
    }
  }
  if (notified.length) log(doc, `Cancellation notice emailed to ${notified.join(', ')}`, null, 'emailed');
  await notifySender(`Cancelled: "${doc.title}" [${doc.agreementId}]`, `You cancelled agreement ${doc.agreementId} "${doc.title}".\nReason: ${reason}\n${notified.length ? `Notified: ${notified.join(', ')}` : 'Email is off, so signers were not notified by email.'}`);
  store.save();
  res.json({ ...adminView(doc), notified: notified.length });
});

// Automatic reminders (Adobe's "Send reminder: Every day").
async function sendDueReminders() {
  if (!mailer.enabled()) return;
  for (const doc of store.all()) {
    const period = REMINDERS[doc.reminder] || 0;
    if (doc.status !== 'sent' || !period) continue;
    for (const s of activeSigners(doc)) {
      const last = Date.parse(s.lastEmailAt || doc.sentAt);
      if (Date.now() - last >= period) await invite(doc, s, true);
    }
    store.save();
  }
}
setInterval(() => sendDueReminders().catch((e) => console.error('Reminder error:', e)), 15 * 60 * 1000);

function sendPdf(res, file, name, inline) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\w.\- ]/g, '_')}"`);
  res.send(fs.readFileSync(filePath(file)));
}

app.get('/api/documents/:id/original', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).end();
  sendPdf(res, doc.originalFile, `${doc.title}.pdf`, true);
});
app.get('/api/documents/:id/signed', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || !doc.finalFile) return res.status(404).end();
  sendPdf(res, doc.finalFile, `${doc.title} - signed.pdf`, false);
});

// Public root certificate: import it into Adobe / Windows so these digital signatures show as trusted.
app.get('/ca.cer', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', `attachment; filename="${COMPANY.replace(/[^\w-]/g, '_')}-eSign-Root-CA.cer"`);
  res.send(fs.readFileSync(CA.certFile));
});

// ---------- Email-open tracking ("Email viewed by ...") ----------
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/t/:file', (req, res) => {
  const found = store.bySignerToken(req.params.file.replace(/\.gif$/, ''));
  if (found && !found.signer.emailViewedAt && found.doc.status === 'sent') {
    found.signer.emailViewedAt = now();
    log(found.doc, `Email viewed by ${who(found.signer)}`, req, 'email_viewed');
    store.save();
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }).send(PIXEL);
});

// ---------- Signer ----------
function signerCtx(req, res) {
  const found = store.bySignerToken(req.params.token);
  if (!found) {
    res.status(404).json({ error: 'This signing link is invalid.' });
    return null;
  }
  return found;
}

// A signing link works only until its owner signs. After that it just says "already signed";
// the signed copy reaches them as an email attachment instead.
app.get('/api/sign/:token', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (signer.status === 'signed') {
    return res.json({
      company: COMPANY, title: doc.title, agreementId: doc.agreementId, status: doc.status, expired: true,
      signer: { name: signer.name, status: 'signed', signedAt: signer.signedAt },
    });
  }
  const waitingOn = doc.status === 'sent' && !activeSigners(doc).includes(signer) && signer.status !== 'signed'
    ? activeSigners(doc).map((s) => s.name) : [];
  if (doc.status === 'sent' && signer.status === 'pending' && !waitingOn.length) {
    signer.status = 'viewed';
    signer.viewedAt = now();
    log(doc, `Document viewed by ${who(signer)}`, req, 'viewed');
    store.save();
  }
  res.json({
    company: COMPANY,
    title: doc.title,
    agreementId: doc.agreementId,
    cancelReason: doc.cancelReason,
    message: doc.message,
    status: doc.status,
    requireReason: doc.requireReason !== false,
    reasons: REASONS,
    signer: { name: signer.name, email: signer.email, status: signer.status, color: signer.color },
    waitingOn,
    fields: doc.fields
      .filter((f) => f.signerId === signer.id)
      .map(({ value, signerId, ...f }) => f),
    // Only while it is their turn, so a saved signature is never shown before they may sign.
    profile: waitingOn.length || doc.status !== 'sent' ? null : publicProfile(store.getProfile(signer.email)),
  });
});

function publicProfile(p) {
  if (!p) return null;
  const { title, company, signature, initials, appearance, updatedAt } = p;
  return { title, company, signature, initials, appearance, updatedAt };
}

// The document itself is only shown while it is this signer's turn.
app.get('/api/sign/:token/file', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (signer.status === 'signed') return res.status(410).json({ error: 'You have already signed. This link is no longer valid.' });
  if (doc.status !== 'sent' || !activeSigners(doc).includes(signer)) return res.status(403).json({ error: 'This document is not available.' });
  sendPdf(res, doc.originalFile, `${doc.title}.pdf`, true);
});

// Issues each signer's certificate (logged first, so the audit report lists it), then builds the
// final PDF with embedded digital signatures. If digital signing fails, the agreement still
// completes with visual signatures and the failure is recorded.
async function buildFinalPdf(doc) {
  const original = fs.readFileSync(filePath(doc.originalFile));
  let certs = null;
  if (doc.digitalSign !== false) {
    certs = {};
    for (const s of [...doc.signers].sort((a, b) => a.order - b.order)) {
      const cert = issueSignerCertificate(CA, { name: s.name, email: s.email, title: s.title, company: s.company });
      certs[s.id] = cert;
      s.certificate = { serial: cert.serial, dn: cert.dn, pem: cert.certPem };
      log(doc, `Digital certificate issued to ${who(s)}`, null, 'signed', `Certificate serial: ${cert.serial} - Subject: ${cert.dn} - Issuer: ${COMPANY} eSign Root CA - Algorithm: RSA 2048 / SHA-256`);
    }
  }
  log(doc, 'Agreement completed.', null, 'completed');
  try {
    return await finalize({ ...doc, status: 'completed' }, original, COMPANY, { certs });
  } catch (e) {
    if (!certs) throw e;
    console.error('Digital signing failed:', e);
    log(doc, `Digital signatures could not be applied (${e.message}). The document was completed with electronic signatures only.`, null, 'failed');
    return finalize({ ...doc, status: 'completed' }, original, COMPANY);
  }
}

const isPng = (v) => typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 700000;
const fieldName = (f) => f.label || { company: 'Company', title: 'Title', number: 'Number', datefield: 'Date', dropdown: 'Dropdown', text: 'Text' }[f.type] || f.type;

// Validates and formats one signer's submitted values. Returns { values } or { error }.
function stageValues(doc, signer, input, signedAt, tz) {
  const mine = doc.fields.filter((f) => f.signerId === signer.id);
  const staged = {};
  for (const f of mine) {
    let v = input[f.id];
    const text = String(v ?? '').trim().slice(0, 500);
    switch (f.type) {
      case 'signature':
      case 'initials':
        if (!isPng(v)) return { error: `Please complete every ${f.type} field.` };
        break;
      case 'date': v = formatDate(signedAt, f.dateFormat, tz); break;
      case 'name': v = signer.name; break;
      case 'email': v = signer.email; break;
      case 'datefield':
        if (text && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return { error: `"${fieldName(f)}" is not a valid date.` };
        if (f.required && !text) return { error: `Please fill in "${fieldName(f)}".` };
        v = text ? formatIsoDay(text, f.dateFormat) : '';
        break;
      case 'number':
        if (text && !Number.isFinite(Number(text))) return { error: `"${fieldName(f)}" must be a number.` };
        if (f.required && !text) return { error: `Please fill in "${fieldName(f)}".` };
        v = text;
        break;
      case 'dropdown':
        if (text && !f.options.includes(text)) return { error: `Please pick an option for "${fieldName(f)}".` };
        if (f.required && !text) return { error: `Please pick an option for "${fieldName(f)}".` };
        v = text;
        break;
      case 'checkbox':
        v = v === true || v === 'true' ? 'true' : 'false';
        if (f.required && v !== 'true') return { error: 'Please tick every required checkbox.' };
        break;
      case 'radio':
        v = v === true || v === 'true' ? 'true' : 'false';
        break;
      default:
        if (f.required && !text) return { error: `Please fill in "${fieldName(f)}".` };
        v = text;
    }
    staged[f.id] = v;
  }
  // Radio buttons sharing a group: at most one choice, and one is needed if any button is required.
  const groups = {};
  for (const f of mine.filter((x) => x.type === 'radio')) (groups[f.group || f.id] ||= []).push(f);
  for (const [name, list] of Object.entries(groups)) {
    const picked = list.filter((f) => staged[f.id] === 'true').length;
    if (picked > 1) return { error: `Choose only one option for "${name}".` };
    if (!picked && list.some((f) => f.required)) return { error: `Please choose an option for "${name}".` };
  }
  return { values: staged };
}

app.post('/api/sign/:token', async (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (doc.status !== 'sent') return res.status(400).json({ error: `This document is ${doc.status}.` });
  if (signer.status === 'signed' || signer.status === 'declined') return res.status(400).json({ error: `You have already ${signer.status}.` });
  if (!activeSigners(doc).includes(signer)) return res.status(400).json({ error: 'It is not your turn to sign yet.' });
  if (req.body.consent !== true) return res.status(400).json({ error: 'You must agree to sign electronically.' });
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (doc.requireReason !== false && !reason) return res.status(400).json({ error: 'Please give a reason for signing.' });

  const signedAt = new Date();
  const tz = validTz(String(req.body.tz || 'UTC'));
  const { values, error } = stageValues(doc, signer, req.body.values || {}, signedAt, tz);
  if (error) return res.status(400).json({ error });

  // Reject images pdf-lib can't embed now, rather than failing at finalization.
  try {
    const probe = await PDFDocument.create();
    for (const v of Object.values(values)) if (isPng(v)) await probe.embedPng(Buffer.from(v.split(',')[1], 'base64'));
  } catch {
    return res.status(400).json({ error: 'Your signature image could not be read. Please redraw it.' });
  }

  for (const f of doc.fields) if (f.id in values && f.signerId === signer.id) f.value = values[f.id];
  const appearance = req.body.appearance === 'TYPE' ? 'TYPE' : 'DRAW';
  // Title and company for the signature stamp page; a Title/Company field on the document wins.
  const fieldValue = (type) => doc.fields.find((f) => f.signerId === signer.id && f.type === type && f.value)?.value;
  const title = String(fieldValue('title') || req.body.title || '').trim().slice(0, 120);
  const companyName = String(fieldValue('company') || req.body.company || '').trim().slice(0, 120);
  Object.assign(signer, {
    title, company: companyName,
    status: 'signed', signedAt: signedAt.toISOString(), consentAt: signedAt.toISOString(), tz, reason, appearance,
    ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  });
  const sigValue = (type) => doc.fields.find((f) => f.signerId === signer.id && f.type === type && f.value)?.value;
  store.saveProfile(signer.email, {
    name: signer.name, appearance,
    ...(title ? { title } : {}), ...(companyName ? { company: companyName } : {}),
    ...(sigValue('signature') ? { signature: sigValue('signature') } : {}), ...(sigValue('initials') ? { initials: sigValue('initials') } : {}),
  });
  log(doc, `Document e-signed by ${who(signer)}`, req, 'signed',
    `Signature Date: ${auditStamp(signer.signedAt)} - Time Source: server- IP address: ${signer.ip} - Signature Appearance Selected: ${appearance}${reason ? ` - Reason: ${reason}` : ''}`);

  if (doc.signers.every((s) => s.status === 'signed')) {
    doc.completedAt = now();
    const bytes = await buildFinalPdf(doc);
    doc.status = 'completed';
    doc.finalFile = `${id(9)}-signed.pdf`;
    doc.finalHash = sha256(bytes);
    fs.writeFileSync(filePath(doc.finalFile), bytes);
    store.save();
    const attachments = [{ filename: `${doc.title.replace(/[^\w.\- ]/g, '_')} - signed.pdf`, content: bytes }];
    for (const s of doc.signers) {
      await mailer
        .send({ to: s.email, subject: `Completed: "${doc.title}" [${doc.agreementId}]`, heading: 'Your agreement has been completed', text: `All parties have signed "${doc.title}".\nAgreement ID: ${doc.agreementId}\n\nThe signed copy is attached to this email. Please keep it for your records.`, attachments })
        .catch((e) => console.error('Mail error:', e.message));
    }
    await notifySender(`Completed: "${doc.title}" [${doc.agreementId}]`, `All parties have signed agreement ${doc.agreementId} "${doc.title}". The signed copy with its audit report is attached.`, attachments);
  } else {
    store.save();
    const next = activeSigners(doc);
    await notifySender(`${signer.name} signed "${doc.title}" [${doc.agreementId}]`, `${who(signer)} signed "${doc.title}" (signer ${signer.order} of ${doc.signers.length}).${reason ? `\nReason: ${reason}` : ''}\n${doc.signingOrder === 'sequential' && next.length ? `Signing link sent to next signer: ${next.map((s) => `${s.order}. ${who(s)}`).join(', ')}` : `Still waiting on: ${next.map((s) => s.name).join(', ')}`}.`);
    for (const s of issueLinks(doc)) await invite(doc, s);
  }
  store.save();
  res.json({ ok: true, completed: doc.status === 'completed' });
});

app.post('/api/sign/:token/decline', async (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (doc.status !== 'sent' || signer.status === 'signed') return res.status(400).json({ error: 'Cannot decline now.' });
  signer.status = 'declined';
  doc.status = 'declined';
  const reason = req.body.reason ? String(req.body.reason).slice(0, 300) : '';
  log(doc, `Document declined by ${who(signer)}${reason ? `. Reason: ${reason}` : ''}`, req, 'declined');
  store.save();
  await notifySender(`${signer.name} declined "${doc.title}" [${doc.agreementId}]`, `${who(signer)} declined to sign agreement ${doc.agreementId} "${doc.title}".${reason ? `\nReason: ${reason}` : ''}`);
  res.json({ ok: true });
});

// ---------- Public verification ----------
app.post('/api/verify', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PDF' });
  const hash = sha256(req.file.buffer);
  const doc = store.all().find((d) => d.finalHash === hash);
  if (!doc) return res.json({ valid: false, hash });
  res.json({
    valid: true, hash, title: doc.title, agreementId: doc.agreementId, id: doc.transactionId || doc.id, completedAt: doc.completedAt,
    signers: doc.signers.map((s) => ({ name: s.name, email: s.email, signedAt: s.signedAt, reason: s.reason })),
  });
});

app.use((err, req, res, next) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : 'Server error' });
});

// Agreements sent before numbering existed get their number now, oldest first.
for (const d of [...store.all()].filter((d) => d.status !== 'draft' && !d.agreementId).sort((a, b) => (a.sentAt || a.createdAt).localeCompare(b.sentAt || b.createdAt))) {
  d.agreementId = store.nextAgreementId(AGREEMENT_PREFIX);
}
store.save();

app.listen(PORT, () => {
  console.log(`${COMPANY} eSign running at ${BASE_URL}  (email ${mailer.enabled() ? 'ON' : 'OFF - links print here'})`);
  setTimeout(() => sendDueReminders().catch((e) => console.error('Reminder error:', e)), 60 * 1000);
});
