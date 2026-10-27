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
const Formula = require('./public/formula.js');
const audit = require('./lib/audit');
const authLib = require('./lib/auth');
const { inspectSignatures } = require('./lib/verifysig');

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
const FIELD_TYPES = ['signature', 'initials', 'date', 'name', 'email', 'company', 'title', 'text', 'number', 'datefield', 'checkbox', 'radio', 'dropdown', 'formula', 'attachment', 'note', 'stamp'];
// Files a signer may attach in an Attachment field.
const ATTACHMENT_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', csv: 'text/csv' };
const FONTS = ['Helvetica', 'Times', 'Courier'];
const REMINDERS = { none: 0, daily: 864e5, every2days: 2 * 864e5, weekly: 7 * 864e5 };
const REASONS = ['I approve this document', 'I have reviewed this document', 'I am the author of this document', 'I agree to the terms of this document', 'I certify the information is true and correct'];

// Audit events. `type` picks the icon in the audit report; `detail` replaces the default "time - IP" line.
// Each event records who acted and is hash-chained to the one before (see lib/audit.js), so the
// trail is append-only: any later edit or deletion is detected.
function log(doc, text, req, type = 'info', detail) {
  const entry = { at: now(), actor: req?.actor || 'System', text, ip: req ? clientIp(req) : undefined, type, ...(detail ? { detail } : {}) };
  doc.events.push(audit.seal(doc.events, entry));
}
const syslog = audit.systemLog(store.DATA_DIR);
const sysLog = (req, type, text, detail) => syslog.add({ actor: req?.actor || 'System', type, text, ip: req ? clientIp(req) : undefined, ...(detail ? { detail } : {}) });

// Short device description for the audit trail, e.g. "Chrome 141 on Windows".
function deviceOf(ua = '') {
  const browser = (/Edg\/(\d+)/.exec(ua) && `Edge ${RegExp.$1}`) || (/OPR\/(\d+)/.exec(ua) && `Opera ${RegExp.$1}`)
    || (/Chrome\/(\d+)/.exec(ua) && `Chrome ${RegExp.$1}`) || (/Firefox\/(\d+)/.exec(ua) && `Firefox ${RegExp.$1}`)
    || (/Version\/(\d+).*Safari/.exec(ua) && `Safari ${RegExp.$1}`) || 'Unknown browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  return `${browser} on ${os}`;
}

// ---------- User accounts and sign-in ----------
// Every person signs in with their own email address and password, then a one-time code emailed to
// them (two-step sign-in). Roles: "admin" (also manages users) and "sender" (prepares and sends).
const SESSION_HOURS = 12;
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 30);
const LOCK_AFTER = 5; // wrong passwords in a row
const LOCK_MINUTES = 15;
const OTP_MINUTES = 10;
const ROLES = ['admin', 'sender'];

const SESSIONS_FILE = path.join(store.DATA_DIR, 'sessions.json');
const sessions = new Map(fs.existsSync(SESSIONS_FILE) ? Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) : []);
const saveSessions = () => {
  for (const [k, s] of sessions) if (s.expires < Date.now() || !s.userId) sessions.delete(k);
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
};
const challenges = new Map(); // pending two-step sign-ins: id -> { userId, codeHash, expires, attempts, sentAt }
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, lockedUntil: u.lockedUntil });
const actorOf = (u) => `${u.name} (${u.email})`;

function requireUser(req, res, next) {
  const s = sessions.get(req.cookies.sid);
  const user = s && store.getUser(s.userId);
  const idle = s && Date.now() - (s.lastSeen || 0) > IDLE_MINUTES * 60000;
  if (!s || !user || s.expires < Date.now() || idle || user.status !== 'active') {
    if (s && idle && user) {
      req.actor = actorOf(user);
      sysLog(req, 'logout', `${user.name} signed out automatically after ${IDLE_MINUTES} minutes without activity`);
    }
    if (s) sessions.delete(req.cookies.sid);
    return res.status(401).json({ error: idle ? 'Signed out after inactivity. Please sign in again.' : 'Not logged in' });
  }
  if (Date.now() - (s.lastSeen || 0) > Math.min(60000, (IDLE_MINUTES * 60000) / 4)) {
    s.lastSeen = Date.now();
    saveSessions();
  }
  req.user = user;
  req.actor = actorOf(user);
  next();
}
const requireAdminRole = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Only administrators can do this.' }));

// Simple per-IP brake on sign-in attempts (20 per 15 minutes).
const attemptsByIp = new Map();
function tooManyAttempts(req) {
  const ip = clientIp(req);
  const recent = (attemptsByIp.get(ip) || []).filter((t) => Date.now() - t < 15 * 60000);
  recent.push(Date.now());
  attemptsByIp.set(ip, recent);
  return recent.length > 20;
}

async function sendOtp(user, challengeId, req) {
  const code = authLib.newOtp();
  challenges.set(challengeId, { userId: user.id, codeHash: authLib.hashSecret(code, challengeId), expires: Date.now() + OTP_MINUTES * 60000, attempts: 0, sentAt: Date.now() });
  await mailer.send({
    to: user.email,
    subject: `${COMPANY} eSign sign-in code`,
    heading: 'Your sign-in code',
    text: `Hello ${user.name},\n\nYour one-time sign-in code is:\n\n${code}\n\nIt expires in ${OTP_MINUTES} minutes and can be used once.\nIf you did not try to sign in, someone may know your password: change it and tell your administrator.`,
  });
  sysLog(req, 'otp', `Sign-in code emailed to ${user.email}`);
}

app.get('/api/auth/status', (req, res) => res.json({ company: COMPANY, setupRequired: store.users().length === 0, mail: mailer.enabled() }));

// First-time setup: the .env ADMIN_PASSWORD proves ownership once, to create the first administrator.
app.post('/api/auth/setup', (req, res) => {
  if (store.users().length) return res.status(400).json({ error: 'Setup is already done. Please sign in.' });
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  if (typeof req.body.adminPassword !== 'string' || !crypto.timingSafeEqual(digest(req.body.adminPassword), digest(ADMIN_PASSWORD))) {
    sysLog(req, 'login_failed', 'First-time setup attempted with a wrong setup password');
    return res.status(401).json({ error: 'The setup password (ADMIN_PASSWORD in .env) is wrong.' });
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const problem = authLib.passwordProblem(req.body.password, { email, name });
  if (problem) return res.status(400).json({ error: problem });
  const user = { id: id(8), email, name, role: 'admin', status: 'active', passwordHash: authLib.hashPassword(req.body.password), createdAt: now(), failed: 0 };
  store.addUser(user);
  req.actor = actorOf(user);
  sysLog(req, 'user', `First administrator account created: ${actorOf(user)}`);
  res.json({ ok: true });
});

// Step 1: email + password. The same answer is given whether the email or the password is wrong.
app.post('/api/login', async (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = store.getUserByEmail(email);
  const wrong = () => res.status(401).json({ error: 'Email or password is incorrect.' });
  if (!user || user.status === 'invited' || !user.passwordHash) {
    sysLog(req, 'login_failed', `Failed sign-in for ${email || '(no email)'}: unknown or not activated account`);
    return wrong();
  }
  if (user.status === 'disabled') {
    sysLog(req, 'login_failed', `Sign-in refused for disabled account ${email}`);
    return wrong();
  }
  if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    sysLog(req, 'login_failed', `Sign-in refused for locked account ${email}`);
    return res.status(423).json({ error: `This account is locked after too many wrong passwords. Try again after ${new Date(user.lockedUntil).toLocaleTimeString()}, or ask an administrator.` });
  }
  if (!authLib.verifyPassword(req.body.password, user.passwordHash)) {
    user.failed = (user.failed || 0) + 1;
    if (user.failed >= LOCK_AFTER) {
      user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      user.failed = 0;
      sysLog(req, 'lockout', `Account ${email} locked for ${LOCK_MINUTES} minutes after ${LOCK_AFTER} wrong passwords`);
    } else {
      sysLog(req, 'login_failed', `Wrong password for ${email} (${user.failed} of ${LOCK_AFTER})`, `Device: ${deviceOf(req.headers['user-agent'])}`);
    }
    store.save();
    return wrong();
  }
  user.failed = 0;
  user.lockedUntil = undefined;
  store.save();
  const challenge = id(18);
  req.actor = actorOf(user);
  try {
    await sendOtp(user, challenge, req);
  } catch (e) {
    console.error('Mail error:', e.message);
    return res.status(503).json({ error: 'Your sign-in code could not be emailed. Please try again shortly.' });
  }
  res.json({ challenge, sentTo: authLib.maskEmail(user.email), minutes: OTP_MINUTES });
});

// Step 2: the emailed code.
app.post('/api/login/verify', (req, res) => {
  const c = challenges.get(String(req.body.challenge || ''));
  if (!c || c.expires < Date.now()) return res.status(400).json({ error: 'This code has expired. Please sign in again.', restart: true });
  const user = store.getUser(c.userId);
  req.actor = user ? actorOf(user) : 'System';
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!user || user.status !== 'active') return res.status(400).json({ error: 'Please sign in again.', restart: true });
  if (!authLib.sameHash(authLib.hashSecret(code, req.body.challenge), c.codeHash)) {
    c.attempts++;
    sysLog(req, 'login_failed', `Wrong sign-in code for ${user.email} (${c.attempts} of 5)`);
    if (c.attempts >= 5) {
      challenges.delete(req.body.challenge);
      return res.status(400).json({ error: 'Too many wrong codes. Please sign in again.', restart: true });
    }
    return res.status(400).json({ error: 'That code is not correct.' });
  }
  challenges.delete(req.body.challenge);
  const sid = id(24);
  sessions.set(sid, { userId: user.id, expires: Date.now() + SESSION_HOURS * 3600000, lastSeen: Date.now() });
  saveSessions();
  user.lastLoginAt = now();
  store.save();
  sysLog(req, 'login', `${user.name} signed in (password + emailed code)`, `Device: ${deviceOf(req.headers['user-agent'])}`);
  // HTTPS-only when the visitor came in over HTTPS (e.g. through ngrok), so local http:// access still works.
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure });
  res.json({ ok: true });
});

app.post('/api/login/resend', async (req, res) => {
  const c = challenges.get(String(req.body.challenge || ''));
  const user = c && store.getUser(c.userId);
  if (!c || !user || c.expires < Date.now()) return res.status(400).json({ error: 'Please sign in again.', restart: true });
  if (Date.now() - c.sentAt < 30000) return res.status(429).json({ error: 'Please wait 30 seconds before asking for another code.' });
  req.actor = actorOf(user);
  await sendOtp(user, req.body.challenge, req);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const s = sessions.get(req.cookies.sid);
  const user = s && store.getUser(s.userId);
  if (user) {
    req.actor = actorOf(user);
    sysLog(req, 'logout', `${user.name} signed out`);
  }
  sessions.delete(req.cookies.sid);
  saveSessions();
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) =>
  res.json({ company: COMPANY, mail: mailer.enabled(), notify: process.env.NOTIFY_EMAIL || '', dateFormats: DATE_FORMATS, reasons: REASONS, user: publicUser(req.user), idleMinutes: IDLE_MINUTES }));

// ---------- Passwords: invitation, reset, change ----------
async function emailAccountLink(user, kind, req) {
  const token = authLib.newToken();
  const hours = kind === 'invite' ? 7 * 24 : 1;
  user[kind === 'invite' ? 'invite' : 'reset'] = { hash: authLib.hashSecret(token), expires: new Date(Date.now() + hours * 3600000).toISOString() };
  store.save();
  const link = `${BASE_URL}/account.html?t=${token}`;
  const sent = await mailer.send({
    to: user.email,
    subject: kind === 'invite' ? `You're invited to ${COMPANY} eSign` : `Reset your ${COMPANY} eSign password`,
    heading: kind === 'invite' ? `Welcome to ${COMPANY} eSign` : 'Reset your password',
    text: kind === 'invite'
      ? `Hello ${user.name},\n\n${req.user ? req.user.name : 'An administrator'} has created an account for you. Set your password to start sending documents for signature.\nThis link is valid for 7 days.`
      : `Hello ${user.name},\n\nUse the button below to choose a new password. The link is valid for 1 hour and works once.\nIf you didn't ask for this, you can ignore this email.`,
    link, linkLabel: kind === 'invite' ? 'SET MY PASSWORD' : 'RESET PASSWORD',
  }).catch((e) => { console.error('Mail error:', e.message); return false; });
  return { sent, link };
}

// Set a password from an invitation or reset link (single use).
app.post('/api/password/set', (req, res) => {
  const hash = authLib.hashSecret(String(req.body.token || ''));
  const user = store.users().find((u) => ['invite', 'reset'].some((k) => u[k]?.hash === hash && Date.parse(u[k].expires) > Date.now()));
  if (!user || user.status === 'disabled') return res.status(400).json({ error: 'This link has expired or was already used. Ask for a new one.' });
  const problem = authLib.passwordProblem(req.body.password, user);
  if (problem) return res.status(400).json({ error: problem });
  const wasInvite = user.invite?.hash === hash;
  user.passwordHash = authLib.hashPassword(req.body.password);
  user.status = 'active';
  user.failed = 0;
  user.lockedUntil = undefined;
  delete user.invite;
  delete user.reset;
  // A new password signs the person out everywhere else.
  for (const [k, s] of sessions) if (s.userId === user.id) sessions.delete(k);
  saveSessions();
  store.save();
  req.actor = actorOf(user);
  sysLog(req, 'password', wasInvite ? `${user.name} activated their account and set a password` : `${user.name} reset their password`);
  res.json({ ok: true, email: user.email });
});

app.get('/api/password/link-info', (req, res) => {
  const hash = authLib.hashSecret(String(req.query.t || ''));
  const user = store.users().find((u) => ['invite', 'reset'].some((k) => u[k]?.hash === hash && Date.parse(u[k].expires) > Date.now()));
  if (!user || user.status === 'disabled') return res.status(400).json({ error: 'This link has expired or was already used.' });
  res.json({ company: COMPANY, name: user.name, email: user.email, kind: user.invite?.hash === hash ? 'invite' : 'reset' });
});

// "Forgot password?" Always answers the same, so it can't be used to find out which emails have accounts.
app.post('/api/password/forgot', async (req, res) => {
  if (tooManyAttempts(req)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  const user = store.getUserByEmail(String(req.body.email || ''));
  if (user && user.status === 'active') {
    req.actor = actorOf(user);
    await emailAccountLink(user, 'reset', req);
    sysLog(req, 'password', `Password reset link emailed to ${user.email}`);
  }
  res.json({ ok: true });
});

app.post('/api/password/change', requireUser, (req, res) => {
  if (!authLib.verifyPassword(req.body.current, req.user.passwordHash)) {
    sysLog(req, 'login_failed', `Password change refused for ${req.user.email}: current password wrong`);
    return res.status(400).json({ error: 'Your current password is not correct.' });
  }
  const problem = authLib.passwordProblem(req.body.next, req.user);
  if (problem) return res.status(400).json({ error: problem });
  if (authLib.verifyPassword(req.body.next, req.user.passwordHash)) return res.status(400).json({ error: 'Choose a password different from your current one.' });
  req.user.passwordHash = authLib.hashPassword(req.body.next);
  for (const [k, s] of sessions) if (s.userId === req.user.id && k !== req.cookies.sid) sessions.delete(k);
  saveSessions();
  store.save();
  sysLog(req, 'password', `${req.user.name} changed their password`);
  res.json({ ok: true });
});

// ---------- User management (administrators) ----------
app.get('/api/users', requireUser, requireAdminRole, (req, res) => res.json(store.users().map(publicUser)));

app.post('/api/users', requireUser, requireAdminRole, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = ROLES.includes(req.body.role) ? req.body.role : 'sender';
  if (!name) return res.status(400).json({ error: 'Please enter the person\'s name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (store.getUserByEmail(email)) return res.status(400).json({ error: 'A user with this email already exists. Each person has one account.' });
  const user = { id: id(8), email, name, role, status: 'invited', createdAt: now(), createdBy: req.user.id, failed: 0 };
  store.addUser(user);
  const { sent, link } = await emailAccountLink(user, 'invite', req);
  sysLog(req, 'user', `User invited: ${actorOf(user)} as ${role}`);
  // The link is shown only when email is off; otherwise only the invited person receives it.
  res.json({ user: publicUser(user), emailed: sent, link: sent ? undefined : link });
});

app.post('/api/users/:id/:action', requireUser, requireAdminRole, async (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const self = user.id === req.user.id;
  const admins = store.users().filter((u) => u.role === 'admin' && u.status === 'active');
  switch (req.params.action) {
    case 'disable':
      if (self) return res.status(400).json({ error: "You can't disable your own account." });
      user.status = 'disabled';
      for (const [k, s] of sessions) if (s.userId === user.id) sessions.delete(k);
      saveSessions();
      sysLog(req, 'user', `User disabled: ${actorOf(user)}`);
      break;
    case 'enable':
      user.status = user.passwordHash ? 'active' : 'invited';
      sysLog(req, 'user', `User re-enabled: ${actorOf(user)}`);
      break;
    case 'unlock':
      user.lockedUntil = undefined;
      user.failed = 0;
      sysLog(req, 'user', `User unlocked: ${actorOf(user)}`);
      break;
    case 'role': {
      const role = req.body.role;
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role' });
      if (user.role === 'admin' && role !== 'admin' && admins.length <= 1 && user.status === 'active') return res.status(400).json({ error: 'Keep at least one active administrator.' });
      sysLog(req, 'user', `Role of ${actorOf(user)} changed from ${user.role} to ${role}`);
      user.role = role;
      break;
    }
    case 'resend-invite': {
      if (user.status !== 'invited') return res.status(400).json({ error: 'This user has already activated their account.' });
      const r = await emailAccountLink(user, 'invite', req);
      sysLog(req, 'user', `Invitation re-sent to ${user.email}`);
      store.save();
      return res.json({ user: publicUser(user), emailed: r.sent, link: r.sent ? undefined : r.link });
    }
    case 'reset-password': {
      if (user.status !== 'active') return res.status(400).json({ error: 'Only active users can reset their password.' });
      const r = await emailAccountLink(user, 'reset', req);
      sysLog(req, 'user', `Password reset link sent to ${user.email} by ${req.user.name}`);
      store.save();
      return res.json({ user: publicUser(user), emailed: r.sent, link: r.sent ? undefined : r.link });
    }
    default:
      return res.status(404).json({ error: 'Unknown action' });
  }
  store.save();
  res.json({ user: publicUser(user) });
});

app.post('/api/test-email', requireUser, async (req, res) => {
  if (!mailer.enabled()) return res.status(400).json({ error: 'Email is off. Add your SMTP settings to the .env file and restart.' });
  const to = String(req.body.to || '').trim();
  if (!isEmail(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    await mailer.send({ to, subject: `${COMPANY} eSign test email`, heading: 'Email is working', text: 'Your e-signature system can send email. Signers will now receive their signing links automatically.' });
    sysLog(req, 'email', `Test email sent to ${to}`);
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
// Goes to the person who sent the agreement, plus NOTIFY_EMAIL (e.g. a shared QA mailbox) if set.
async function notifySender(subject, text, attachments, doc) {
  const to = [...new Set([doc?.senderEmail, process.env.NOTIFY_EMAIL].filter(Boolean).map((e) => e.toLowerCase()))];
  for (const addr of to) await mailer.send({ to: addr, subject, heading: subject, text, attachments }).catch((e) => console.error('Mail error:', e.message));
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
    comments: doc.comments || [],
    auditIntegrity: audit.verify(doc.events),
  };
}

app.get('/api/documents', requireUser, (req, res) => {
  res.json(
    store.all().map((d) => ({
      id: d.id, agreementId: d.agreementId, title: d.title, status: d.status, createdAt: d.createdAt, completedAt: d.completedAt,
      signers: d.signers.map((s) => ({ name: s.name, email: s.email, status: s.status })),
    }))
  );
});

app.post('/api/documents', requireUser, upload.array('file', 20), async (req, res) => {
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
    senderName: req.user.name,
    senderEmail: req.user.email,
    createdBy: req.user.id,
    createdAt: now(),
    originalFile: `${id(9)}.pdf`,
    originalHash: sha256(bytes),
    signers: [],
    fields: [],
    events: [],
  };
  fs.writeFileSync(filePath(doc.originalFile), bytes);
  log(doc, `Document created by ${req.user.name} (${req.user.email})`, req, 'created');
  if (req.files.length > 1) log(doc, `${req.files.length} files merged: ${req.files.map((f) => f.originalname).join(', ')}`, req, 'pages');
  store.insert(doc);
  res.json(adminView(doc));
});

app.get('/api/documents/:id', requireUser, (req, res) => {
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
    required: f.type === 'note' || f.type === 'formula' ? false : f.type === 'checkbox' || f.type === 'radio' ? !!f.required : f.required !== false,
    formula: f.type === 'formula' ? String(f.formula || '').slice(0, 300) : '',
    decimals: Math.min(6, Math.max(0, Math.floor(Number(f.decimals ?? 2)) || 0)),
    note: f.type === 'note' ? String(f.note || '').slice(0, 1000) : '',
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

app.put('/api/documents/:id', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Only drafts can be edited' });
  const { title, message, emailSubject, signingOrder, reminder, requireReason, stampPage, signers, fields } = req.body;
  const before = JSON.parse(JSON.stringify({ ...doc, events: undefined, comments: undefined }));
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
  const changes = describeDraftChanges(before, doc);
  const last = doc.events[doc.events.length - 1];
  const text = `Draft edited: ${changes.join('; ')}`;
  // Typing in a box saves repeatedly; identical summaries within 2 minutes are recorded once.
  if (changes.length && !(last?.type === 'edit' && last.text === text && Date.now() - Date.parse(last.at) < 120000)) log(doc, text, req, 'edit');
  store.save();
  res.json(adminView(doc));
});

// Human-readable list of what changed in a draft, for the audit trail.
function describeDraftChanges(a, b) {
  const out = [];
  const settings = [
    ['title', (v) => `agreement name set to "${v}"`], ['emailSubject', () => 'email subject changed'], ['message', () => 'email message changed'],
    ['signingOrder', (v) => `signing order set to ${v === 'sequential' ? 'one after another' : 'everyone at once'}`],
    ['reminder', (v) => `reminders set to ${v}`], ['requireReason', (v) => `reason for signing ${v === false ? 'not required' : 'required'}`],
    ['stampPage', (v) => `signature page ${v === false ? 'off' : 'on'}`], ['digitalSign', (v) => `digital signing ${v === false ? 'off' : 'on'}`],
  ];
  for (const [k, msg] of settings) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(msg(b[k]));
  const label = (s) => s.name || s.email || 'unnamed recipient';
  const oldS = new Map(a.signers.map((s) => [s.id, s]));
  const newS = new Map(b.signers.map((s) => [s.id, s]));
  for (const s of b.signers) if (!oldS.has(s.id)) out.push(`recipient added (${s.order})`);
  for (const s of a.signers) if (!newS.has(s.id)) out.push(`recipient removed: ${label(s)}`);
  for (const s of b.signers) {
    const o = oldS.get(s.id);
    if (o && (o.name !== s.name || o.email !== s.email)) out.push(`recipient ${s.order} details: ${label(s)}${s.email ? ` <${s.email}>` : ''}`);
  }
  const keptOrder = (list, other) => list.filter((s) => other.has(s.id)).map((s) => s.id).join();
  if (keptOrder(a.signers, newS) !== keptOrder(b.signers, oldS)) out.push(`signing order changed: ${b.signers.map((s) => `${s.order}. ${label(s)}`).join(', ')}`);
  const oldF = new Map(a.fields.map((f) => [f.id, f]));
  const newF = new Map(b.fields.map((f) => [f.id, f]));
  const added = b.fields.filter((f) => !oldF.has(f.id));
  const removed = a.fields.filter((f) => !newF.has(f.id));
  let moved = 0;
  let edited = 0;
  for (const f of b.fields) {
    const o = oldF.get(f.id);
    if (!o) continue;
    if (o.x !== f.x || o.y !== f.y || o.w !== f.w || o.h !== f.h || o.page !== f.page) moved++;
    const { x, y, w, h, page, ...rest } = f;
    const { x: ox, y: oy, w: ow, h: oh, page: op, ...orest } = o;
    if (JSON.stringify(rest) !== JSON.stringify(orest)) edited++;
  }
  if (added.length) out.push(`${added.length} field${added.length > 1 ? 's' : ''} added (${[...new Set(added.map((f) => f.type))].join(', ')})`);
  if (removed.length) out.push(`${removed.length} field${removed.length > 1 ? 's' : ''} removed`);
  if (moved) out.push(`${moved} field${moved > 1 ? 's' : ''} moved or resized`);
  if (edited) out.push(`${edited} field${edited > 1 ? 's' : ''} settings changed`);
  return out;
}

function removeFiles(doc) {
  const files = [doc.originalFile, doc.finalFile, ...Object.values(doc.sources || {}).map((s) => s.file)];
  for (const f of files) if (f && fs.existsSync(filePath(f))) fs.unlinkSync(filePath(f));
}

// Only unsent drafts can be discarded. Once sent, a document is an agreement: it can be cancelled, never deleted.
app.delete('/api/documents/:id', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(403).json({ error: 'Agreements cannot be deleted. Cancel it instead.' });
  sysLog(req, 'discard', `Unsent draft discarded: "${doc.title}"`, `Draft created ${auditStamp(doc.createdAt)} - ${doc.signers.length} recipient(s), ${doc.fields.length} field(s), ${(doc.comments || []).length} comment(s)`);
  removeFiles(doc);
  store.remove(doc.id);
  res.json({ ok: true });
});

// ---------- Comments on drafts (before sending) ----------
// Team discussion while preparing an agreement. Comments can be pinned to a spot on a page and
// resolved, but never edited or deleted; each one is recorded in the audit trail.
app.post('/api/documents/:id/comments', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Comments can only be added before sending.' });
  // The author is the signed-in person; it can't be typed in.
  const author = req.user.name;
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'Please write a comment.' });
  const pinned = Number.isInteger(req.body.page) && req.body.x >= 0 && req.body.x <= 1 && req.body.y >= 0 && req.body.y <= 1;
  const c = { id: id(6), author, authorEmail: req.user.email, text, at: now(), resolved: false, ...(pinned ? { page: req.body.page, x: Number(req.body.x), y: Number(req.body.y) } : {}) };
  doc.comments = [...(doc.comments || []), c];
  log(doc, `Comment added by ${author}${pinned ? ` on page ${c.page + 1}` : ''}: "${text}"`, req, 'comment');
  store.save();
  res.json(c);
});

app.post('/api/documents/:id/comments/:cid/resolve', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  const c = doc?.comments?.find((x) => x.id === req.params.cid);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (doc.status !== 'draft') return res.status(400).json({ error: 'Comments are read-only after sending.' });
  const author = req.user.name;
  c.resolved = req.body.resolved !== false;
  c.resolvedBy = c.resolved ? author : undefined;
  c.resolvedAt = c.resolved ? now() : undefined;
  log(doc, `Comment by ${c.author} ${c.resolved ? 'resolved' : 'reopened'} by ${author}: "${c.text.slice(0, 80)}"`, req, 'comment');
  store.save();
  res.json(c);
});

// System log (sign-ins, discarded drafts, test emails) with its integrity check.
app.get('/api/system-log', requireUser, requireAdminRole, (req, res) => {
  const entries = syslog.read();
  res.json({ integrity: audit.verify(entries), entries: entries.slice(-500).reverse() });
});

// ---------- Admin: merge files & organize pages ----------
app.post('/api/documents/:id/sources', requireUser, upload.array('file', 20), async (req, res) => {
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

app.get('/api/documents/:id/sources/:sid', requireUser, (req, res) => {
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

app.post('/api/documents/:id/pages', requireUser, async (req, res) => {
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

app.post('/api/documents/:id/send', requireUser, async (req, res) => {
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

app.post('/api/documents/:id/remind/:signerId', requireUser, async (req, res) => {
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
app.post('/api/documents/:id/void', requireUser, async (req, res) => {
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
  await notifySender(`Cancelled: "${doc.title}" [${doc.agreementId}]`, `You cancelled agreement ${doc.agreementId} "${doc.title}".\nReason: ${reason}\n${notified.length ? `Notified: ${notified.join(', ')}` : 'Email is off, so signers were not notified by email.'}`, undefined, doc);
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

app.get('/api/documents/:id/original', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc) return res.status(404).end();
  sendPdf(res, doc.originalFile, `${doc.title}.pdf`, true);
});
app.get('/api/documents/:id/signed', requireUser, (req, res) => {
  const doc = store.get(req.params.id);
  if (!doc || !doc.finalFile) return res.status(404).end();
  log(doc, `Signed document downloaded by ${req.actor}`, req, 'download', `${auditStamp(now())} - IP address: ${clientIp(req)} - Device: ${deviceOf(req.headers['user-agent'])}`);
  store.save();
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
  req.actor = `${found.signer.name} (${found.signer.email})`;
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
    attached: Object.fromEntries(Object.entries(signer.pendingAttachments || {}).map(([fid, a]) => [fid, a.name])),
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
  const attachments = doc.fields.filter((f) => f.type === 'attachment' && f.attachment).map((f) => {
    const s = doc.signers.find((x) => x.id === f.signerId);
    return { name: f.attachment.name, bytes: fs.readFileSync(filePath(f.attachment.file)), mime: f.attachment.mime, at: f.attachment.at,
      description: `${f.label || 'Attachment'} - attached by ${s ? who(s) : 'signer'} - SHA-256 ${f.attachment.sha256}` };
  });
  let certs = null;
  if (doc.digitalSign !== false) {
    certs = {};
    for (const s of [...doc.signers].sort((a, b) => a.order - b.order)) {
      const cert = issueSignerCertificate(CA, { name: s.name, email: s.email, title: s.title, company: s.company });
      certs[s.id] = cert;
      s.certificate = { serial: cert.serial, dn: cert.dn, pem: cert.certPem };
      log(doc, `Digital certificate issued to ${who(s)}`, null, 'signed', `Certificate serial: ${cert.serial} - Subject: ${cert.dn} - Issuer: ${COMPANY} eSign Root CA - Algorithm: RSA 2048 / SHA-256`);
    }
    // Company seal that certifies and locks the finished agreement.
    const sealEmail = SENDER_EMAIL || 'esign@localhost';
    certs.seal = { ...issueSignerCertificate(CA, { name: `${COMPANY} eSign`, email: sealEmail, company: COMPANY, title: 'Document certification' }), name: `${COMPANY} eSign`, email: sealEmail };
    log(doc, `Document certified and locked by ${COMPANY} eSign`, null, 'signed',
      `No changes allowed except signing (DocMDP level 2). Any other change invalidates the certification. Certificate serial: ${certs.seal.serial}`);
  }
  log(doc, 'Agreement completed.', null, 'completed');
  try {
    const bytes = await finalize({ ...doc, status: 'completed' }, original, COMPANY, { certs, attachments });
    doc.locked = !!certs;
    return bytes;
  } catch (e) {
    if (!certs) throw e;
    doc.locked = false;
    console.error('Digital signing failed:', e);
    log(doc, `Digital signatures could not be applied (${e.message}). The document was completed with electronic signatures only.`, null, 'failed');
    return finalize({ ...doc, status: 'completed' }, original, COMPANY, { attachments });
  }
}

const isPng = (v) => typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 700000;
const fieldName = (f) => f.label || { company: 'Company', title: 'Title', number: 'Number', datefield: 'Date', dropdown: 'Dropdown', text: 'Text', attachment: 'Attachment', stamp: 'Stamp' }[f.type] || f.type;

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
      case 'stamp':
        if (v && !isPng(v)) return { error: 'The stamp image could not be read. Please upload it again.' };
        if (f.required && !v) return { error: `Please add your stamp${f.label ? ` ("${f.label}")` : ''}.` };
        v = v || null;
        break;
      case 'attachment': {
        const file = signer.pendingAttachments?.[f.id];
        if (f.required && !file) return { error: `Please attach a file for "${f.label || 'Attachment'}".` };
        v = file ? file.name : '';
        break;
      }
      case 'note':
        v = null; // instructions for the signer; nothing to fill in
        break;
      case 'formula':
        v = ''; // calculated below, once every other value is known
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
  // Formulas are always recalculated on the server; anything the browser sent is ignored.
  // Fields are referenced by name, e.g. {Qty} * {Price}; two passes let formulas use other formulas.
  const valueOf = (name) => {
    const f = doc.fields.find((x) => (x.label || '').trim().toLowerCase() === name.toLowerCase());
    return f ? (f.id in staged ? staged[f.id] : f.value) : '';
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const f of mine.filter((x) => x.type === 'formula')) staged[f.id] = Formula.calculate(f.formula, valueOf, f.decimals);
  }
  return { values: staged };
}

// A signer uploads a file for an Attachment field before finishing. It is kept with the agreement
// and embedded in the signed PDF.
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/sign/:token/attachment/:fieldId', attachmentUpload.single('file'), (req, res) => {
  const ctx = signerCtx(req, res);
  if (!ctx) return;
  const { doc, signer } = ctx;
  const field = doc.fields.find((f) => f.id === req.params.fieldId && f.signerId === signer.id && f.type === 'attachment');
  if (!field || doc.status !== 'sent' || signer.status === 'signed' || !activeSigners(doc).includes(signer)) return res.status(400).json({ error: 'You cannot attach a file now.' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file.' });
  const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
  if (!ATTACHMENT_TYPES[ext]) return res.status(400).json({ error: `Allowed files: ${Object.keys(ATTACHMENT_TYPES).join(', ').toUpperCase()}` });
  const old = signer.pendingAttachments?.[field.id];
  if (old && fs.existsSync(filePath(old.file))) fs.unlinkSync(filePath(old.file));
  const file = `${id(9)}-att.${ext}`;
  fs.writeFileSync(filePath(file), req.file.buffer);
  const name = req.file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const info = { file, name, size: req.file.size, mime: ATTACHMENT_TYPES[ext], sha256: sha256(req.file.buffer), at: now() };
  signer.pendingAttachments = { ...(signer.pendingAttachments || {}), [field.id]: info };
  log(doc, `File attached by ${who(signer)}: ${name}`, req, 'info', `${auditStamp(info.at)} - IP address: ${clientIp(req)} - Size: ${info.size} bytes - SHA-256: ${info.sha256}`);
  store.save();
  res.json({ name, size: info.size });
});

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

  for (const f of doc.fields) {
    if (!(f.id in values) || f.signerId !== signer.id) continue;
    f.value = values[f.id];
    if (f.type === 'attachment' && signer.pendingAttachments?.[f.id]) f.attachment = signer.pendingAttachments[f.id];
  }
  delete signer.pendingAttachments;
  const appearance = ['TYPE', 'UPLOAD'].includes(req.body.appearance) ? req.body.appearance : 'DRAW';
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
    `Signature Date: ${auditStamp(signer.signedAt)} - Time Source: server- IP address: ${signer.ip} - Device: ${deviceOf(signer.userAgent)} - Authentication: personal one-time email link - Signature Appearance Selected: ${appearance}${reason ? ` - Reason: ${reason}` : ''}`);

  if (doc.signers.every((s) => s.status === 'signed')) {
    doc.completedAt = now();
    const bytes = await buildFinalPdf(doc);
    doc.status = 'completed';
    doc.finalFile = `${id(9)}-signed.pdf`;
    doc.finalHash = sha256(bytes);
    fs.writeFileSync(filePath(doc.finalFile), bytes);
    fs.chmodSync(filePath(doc.finalFile), 0o444); // the signed original is never modified again
    store.save();
    const attachments = [{ filename: `${doc.title.replace(/[^\w.\- ]/g, '_')} - signed.pdf`, content: bytes }];
    for (const s of doc.signers) {
      await mailer
        .send({ to: s.email, subject: `Completed: "${doc.title}" [${doc.agreementId}]`, heading: 'Your agreement has been completed', text: `All parties have signed "${doc.title}".\nAgreement ID: ${doc.agreementId}\n\nThe signed copy is attached to this email. Please keep it for your records.`, attachments })
        .catch((e) => console.error('Mail error:', e.message));
    }
    await notifySender(`Completed: "${doc.title}" [${doc.agreementId}]`, `All parties have signed agreement ${doc.agreementId} "${doc.title}". The signed copy with its audit report is attached.`, attachments, doc);
  } else {
    store.save();
    const next = activeSigners(doc);
    await notifySender(`${signer.name} signed "${doc.title}" [${doc.agreementId}]`, `${who(signer)} signed "${doc.title}" (signer ${signer.order} of ${doc.signers.length}).${reason ? `\nReason: ${reason}` : ''}\n${doc.signingOrder === 'sequential' && next.length ? `Signing link sent to next signer: ${next.map((s) => `${s.order}. ${who(s)}`).join(', ')}` : `Still waiting on: ${next.map((s) => s.name).join(', ')}`}.`, undefined, doc);
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
  await notifySender(`${signer.name} declined "${doc.title}" [${doc.agreementId}]`, `${who(signer)} declined to sign agreement ${doc.agreementId} "${doc.title}".${reason ? `\nReason: ${reason}` : ''}`, undefined, doc);
  res.json({ ok: true });
});

// ---------- Public verification ----------
app.post('/api/verify', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a PDF' });
  const hash = sha256(req.file.buffer);
  // Embedded digital signatures are checked even when the file isn't in our records (e.g. edited).
  let embedded = { signatures: [], certified: false };
  try {
    embedded = inspectSignatures(req.file.buffer, fs.readFileSync(CA.certFile, 'utf8'));
  } catch (e) {
    console.error('Signature inspection failed:', e.message);
  }
  const doc = store.all().find((d) => d.finalHash === hash);
  if (!doc) return res.json({ valid: false, hash, embedded });
  res.json({
    valid: true, hash, embedded, title: doc.title, agreementId: doc.agreementId, id: doc.transactionId || doc.id, completedAt: doc.completedAt,
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
