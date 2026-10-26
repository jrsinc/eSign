// Tiny JSON-file datastore. Writes are atomic (write temp file, then rename).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const FILES_DIR = path.join(DATA_DIR, 'files');

fs.mkdirSync(FILES_DIR, { recursive: true });

let db = { documents: [] };
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = {
  DATA_DIR,
  FILES_DIR,
  save,
  all: () => db.documents,
  get: (id) => db.documents.find((d) => d.id === id),
  bySignerToken: (token) => {
    for (const doc of db.documents) {
      const signer = doc.signers.find((s) => s.token && s.token === token);
      if (signer) return { doc, signer };
    }
    return null;
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
