const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const mailer = require('./lib/mailer');
const { finalize } = require('./lib/finalize');
const { PDFDocument } = require('pdf-lib');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const COMPANY = mailer.COMPANY;
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
const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
const FIELD_TYPES = ['signature', 'initials', 'date', 'name', 'text', 'checkbox'];

function log(doc, text, req) {
  doc.events.push({ at: now(), text, ip: req ? clientIp(req) : undefined });
}

// ---------- Admin auth (in-memory sessions) ----------
const sessions = new Map();
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
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https') });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  sessions.delete(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.get('/api/me', requireAdmin, (req, res) => res.json({ company: COMPANY, mail: mailer.enabled() }));

// ---------- Admin: documents ----------
function adminView(doc) {
  return {
    ...doc,
    signers: doc.signers.map((s) => ({ ...s, link: s.token ? signLink(s) : null })),
    fields: doc.fields.map((f) => ({ ...f, value: f.type === 'signature' || f.type === 'initials' ? (f.value ? '[signed]' : null) : f.value })),
  };
}

app.get('/api/documents', requireAdmin, (req, res) => {
  res.json(
    store.all().map((d) => ({
      id: d.id, title: d.title, status: d.status, createdAt: d.createdAt, completedAt: d.completedAt,
      signers: d.signers.map((s) => ({ name: s.name, email: s.email, status: s.status })),
    }))
  );
});

app.post('/api/documents', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file || req.file.buffer.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'Please upload a PDF file' });
  const doc = {
    id: id(9),
    title: (req.body.title || req.file.originalname.replace(/\.pdf$/i, '')).slice(0, 200),
    message: '',
    status: 'draft',
    signingOrder: 'parallel',
    createdAt: now(),
    originalFile: `${id(9)}.pdf`,
    originalHash: sha256(req.file.buffer),
    signers: [],
    fields: [],
    events: [],
  };
  fs.writeFileSync(filePath(doc.originalFile), req.file.buffer);
  log(doc, `Document "${doc.title}" uploaded (SHA-256 ${doc.originalHash.slice(0, 16)}...)`, req);
  store.insert(doc);
  res.json(adminView(doc));
});

app.get('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(adminView(doc));
});

app.put('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be edited' });
  const { title, message, signingOrder, signers, fields } = req.body;
  if (typeof title === 'string' && title.trim()) doc.title = title.trim().slice(0, 200);
  if (typeof message === 'string') doc.message = message.slice(0, 2000);
  if (signingOrder === 'parallel' || signingOrder === 'sequential') doc.signingOrder = signingOrder;
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
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    doc.fields = fields
      .filter((f) => ids.has(f.signerId) && FIELD_TYPES.includes(f.type))
      .slice(0, 500)
      .map((f) => ({
        id: typeof f.id === 'string' && f.id ? f.id : id(6),
        signerId: f.signerId, type: f.type, page: Math.max(0, Math.floor(Number(f.page) || 0)),
        x: clamp(f.x), y: clamp(f.y), w: clamp(f.w), h: clamp(f.h),
        required: f.type === 'checkbox' ? !!f.required : f.required !== false,
        label: String(f.label || '').slice(0, 80),
        value: null,
      }));
  }
  store.save();
  res.json(adminView(doc));
});

app.delete('/api/documents/:id', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  for (const f of [doc.originalFile, doc.finalFile]) if (f && fs.existsSync(filePath(f))) fs.unlinkSync(filePath(f));
  store.remove(doc.id);
  res.json({ ok: true });
});

function activeSigners(doc) {
  const pending = doc.signers.filter((s) => s.status !== 'signed');
  if (doc.signingOrder === 'parallel') return pending;
  return pending.length ? [pending.sort((a, b) => a.order - b.order)[0]] : [];
}

async function invite(doc, signer, reminder = false) {
  const subject = `${reminder ? 'Reminder: ' : ''}Please sign "${doc.title}"`;
  const text = `Hello ${signer.name},\n\n${COMPANY} has sent you "${doc.title}" to review and sign electronically.${doc.message ? `\n\nMessage: ${doc.message}` : ''}`;
  try {
    const sent = await mailer.send({ to: signer.email, subject, text, link: signLink(signer), linkLabel: 'Review & Sign' });
    if (sent) log(doc, `${reminder ? 'Reminder' : 'Invitation'} emailed to ${signer.name} <${signer.email}>`);
  } catch (e) {
    console.error('Mail error:', e.message);
    log(doc, `Email to ${signer.email} failed: ${e.message}`);
  }
}

app.post('/api/documents/:id/send', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Already sent' });
  if (!doc.signers.length) return res.status(400).json({ error: 'Add at least one signer' });
  for (const s of doc.signers) {
    const who = `Signer ${s.order}${s.name ? ` (${s.name})` : ''}`;
    if (!s.name) return res.status(400).json({ error: `${who}: please enter their full name.` });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) return res.status(400).json({ error: `${who}: please enter a valid email address.` });
    if (!doc.fields.some((f) => f.signerId === s.id && f.type === 'signature')) return res.status(400).json({ error: `${s.name} has no signature field` });
  }
  doc.signers.forEach((s) => (s.token = id(24)));
  doc.status = 'sent';
  doc.sentAt = now();
  log(doc, `Sent for signature to ${doc.signers.map((s) => `${s.name} <${s.email}>`).join(', ')}`, req);
  store.save();
  for (const s of activeSigners(doc)) await invite(doc, s);
  store.save();
  res.json(adminView(doc));
});

app.post('/api/documents/:id/remind/:signerId', requireAdmin, async (req, res) => {
  const doc = store.get(req.params.id);
  const signer = doc && doc.signers.find((s) => s.id === req.params.signerId);
  if (!signer || doc.status !== 'sent' || signer.status === 'signed') return res.status(400).json({ error: 'Cannot remind this signer' });
  if (!mailer.enabled()) return res.status(400).json({ error: 'Email is not configured. Copy the signing link instead.' });
  await invite(doc, signer, true);
  store.save();
  res.json({ ok: true });
});

app.post('/api/documents/:id/void', requireAdmin, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || doc.status !== 'sent') return res.status(400).json({ error: 'Only documents out for signature can be voided' });
  doc.status = 'voided';
  log(doc, `Voided by sender${req.body.reason ? `: ${String(req.body.reason).slice(0, 300)}` : ''}`, req);
  store.save();
  res.json(adminView(doc));
});

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

// ---------- Signer ----------
function signerCtx(req, res) {
  const found = store.bySignerToken(req.params.token);
  if (!found) {
    res.status(404).json({ error: 'This signing link is invalid.' });
    return null;
  }
  return found;
}

app.get('/api/sign/:token', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  const waitingOn = doc.status === 'sent' && !activeSigners(doc).includes(signer) && signer.status !== 'signed'
    ? activeSigners(doc).map((s) => s.name) : [];
  if (doc.status === 'sent' && signer.status === 'pending' && !waitingOn.length) {
    signer.status = 'viewed';
    signer.viewedAt = now();
    log(doc, `Viewed by ${signer.name} <${signer.email}>`, req);
    store.save();
  }
  res.json({
    company: COMPANY,
    title: doc.title,
    message: doc.message,
    status: doc.status,
    signer: { name: signer.name, email: signer.email, status: signer.status, color: signer.color },
    waitingOn,
    fields: doc.fields
      .filter((f) => f.signerId === signer.id)
      .map(({ id, type, page, x, y, w, h, required, label }) => ({ id, type, page, x, y, w, h, required, label })),
    hasFinal: !!doc.finalFile,
  });
});

app.get('/api/sign/:token/file', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  sendPdf(res, ctx.doc.originalFile, `${ctx.doc.title}.pdf`, true);
});

app.get('/api/sign/:token/signed', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  if (!ctx.doc.finalFile) return res.status(404).json({ error: 'Not completed yet' });
  sendPdf(res, ctx.doc.finalFile, `${ctx.doc.title} - signed.pdf`, false);
});

const isPng = (v) => typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 700000;

app.post('/api/sign/:token', async (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (doc.status !== 'sent') return res.status(400).json({ error: `This document is ${doc.status}.` });
  if (signer.status === 'signed' || signer.status === 'declined') return res.status(400).json({ error: `You have already ${signer.status}.` });
  if (!activeSigners(doc).includes(signer)) return res.status(400).json({ error: 'It is not your turn to sign yet.' });
  if (req.body.consent !== true) return res.status(400).json({ error: 'You must agree to sign electronically.' });

  const values = req.body.values || {};
  const mine = doc.fields.filter((f) => f.signerId === signer.id);
  const today = new Date().toISOString().slice(0, 10);
  const staged = {};
  for (const f of mine) {
    let v = values[f.id];
    if (f.type === 'signature' || f.type === 'initials') {
      if (!isPng(v)) return res.status(400).json({ error: `Please complete every ${f.type} field.` });
    } else if (f.type === 'date') v = today;
    else if (f.type === 'name') v = signer.name;
    else if (f.type === 'checkbox') {
      v = v === true || v === 'true' ? 'true' : 'false';
      if (f.required && v !== 'true') return res.status(400).json({ error: 'Please tick every required checkbox.' });
    } else {
      v = String(v ?? '').trim().slice(0, 500);
      if (f.required && !v) return res.status(400).json({ error: `Please fill in "${f.label || 'text'}".` });
    }
    staged[f.id] = v;
  }
  // Reject images pdf-lib can't embed now, rather than failing at finalization.
  try {
    const probe = await PDFDocument.create();
    for (const f of mine) if (f.type === 'signature' || f.type === 'initials') await probe.embedPng(Buffer.from(staged[f.id].split(',')[1], 'base64'));
  } catch {
    return res.status(400).json({ error: 'Your signature image could not be read. Please redraw it.' });
  }

  for (const f of mine) f.value = staged[f.id];
  signer.status = 'signed';
  signer.signedAt = now();
  signer.consentAt = signer.signedAt;
  signer.ip = clientIp(req);
  signer.userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  log(doc, `Signed by ${signer.name} <${signer.email}>`, req);

  if (doc.signers.every((s) => s.status === 'signed')) {
    doc.completedAt = now();
    log(doc, 'All parties signed. Document completed.');
    const bytes = await finalize(doc, fs.readFileSync(filePath(doc.originalFile)), COMPANY);
    doc.status = 'completed';
    doc.finalFile = `${id(9)}-signed.pdf`;
    doc.finalHash = sha256(bytes);
    fs.writeFileSync(filePath(doc.finalFile), bytes);
    store.save();
    for (const s of doc.signers) {
      await mailer
        .send({ to: s.email, subject: `Completed: "${doc.title}"`, text: `All parties have signed "${doc.title}". Download your copy below.`, link: `${BASE_URL}/sign.html?t=${s.token}`, linkLabel: 'Download signed copy' })
        .catch((e) => console.error('Mail error:', e.message));
    }
  } else {
    store.save();
    if (doc.signingOrder === 'sequential') for (const s of activeSigners(doc)) await invite(doc, s);
  }
  store.save();
  res.json({ ok: true, completed: doc.status === 'completed' });
});

app.post('/api/sign/:token/decline', (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  if (doc.status !== 'sent' || signer.status === 'signed') return res.status(400).json({ error: 'Cannot decline now.' });
  signer.status = 'declined';
  doc.status = 'declined';
  log(doc, `Declined by ${signer.name} <${signer.email}>${req.body.reason ? `: ${String(req.body.reason).slice(0, 300)}` : ''}`, req);
  store.save();
  res.json({ ok: true });
});

// ---------- Public verification ----------
app.post('/api/verify', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PDF' });
  const hash = sha256(req.file.buffer);
  const doc = store.all().find((d) => d.finalHash === hash);
  if (!doc) return res.json({ valid: false, hash });
  res.json({
    valid: true, hash, title: doc.title, id: doc.id, completedAt: doc.completedAt,
    signers: doc.signers.map((s) => ({ name: s.name, email: s.email, signedAt: s.signedAt })),
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : 'Server error' });
});

app.listen(PORT, () => console.log(`${COMPANY} eSign running at ${BASE_URL}  (email ${mailer.enabled() ? 'ON' : 'OFF - links print here'})`));
