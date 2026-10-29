// Tiny JSON-file datastore. Writes are atomic (write temp file, then rename).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

fs.mkdirSync(FILES_DIR, { recursive: true });

let db = { documents: [] };
// Reads db.json again (after restoring a backup).
function reload() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { documents: [] };
}
reload();

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = {
  DATA_DIR,
  FILES_DIR,
  save,
  reload,
  all: () => db.documents,
  // Company names offered in a dropdown when signing (managed by administrators).
  companies: () => (db.companies ||= []),
  // Support tickets raised from the sign-in page, newest first; case numbers like "CASE-2026-00001".
  tickets: () => (db.tickets ||= []),
  nextCaseNo: () => {
    db.meta = db.meta || { agreementSeq: 0 };
    db.meta.caseSeq = (db.meta.caseSeq || 0) + 1;
    save();
    return `CASE-${new Date().getFullYear()}-${String(db.meta.caseSeq).padStart(5, '0')}`;
  },
  get: (id) => db.documents.find((d) => d.id === id),
  bySignerToken: (token) => {
    for (const doc of db.documents) {
      const signer = doc.signers.find((s) => s.token && s.token === token);
      if (signer) return { doc, signer };
    }
    return null;
  },
  // Staff accounts (people who sign in to the dashboard). Signers don't need one.
  users: () => (db.users ||= []),
  getUser: (id) => (db.users || []).find((u) => u.id === id),
  getUserByEmail: (email) => (db.users || []).find((u) => u.email === String(email).trim().toLowerCase()),
  addUser: (user) => {
    (db.users ||= []).push(user);
    save();
  },
  // Details a signer entered before (title, company, adopted signature/initials), keyed by email,
  // so next time they only verify them instead of typing everything again.
  getProfile: (email) => (db.profiles || {})[String(email).toLowerCase()] || null,
  saveProfile: (email, data) => {
    db.profiles = db.profiles || {};
    const key = String(email).toLowerCase();
    db.profiles[key] = { ...(db.profiles[key] || {}), ...data, updatedAt: new Date().toISOString() };
    save();
  },
  // Agreement numbers like "JRS-2026-00001", counting up forever (never reused).
  nextAgreementId: (prefix) => {
    db.meta = db.meta || { agreementSeq: 0 };
    db.meta.agreementSeq += 1;
    save();
    return `${prefix}-${new Date().getFullYear()}-${String(db.meta.agreementSeq).padStart(5, '0')}`;
  },
  insert: (doc) => {
    db.documents.unshift(doc);
    save();
  },
  remove: (id) => {
    db.documents = db.documents.filter((d) => d.id !== id);
    save();
  },
};
