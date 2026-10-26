// Tamper-evident audit records.
// Each entry stores the SHA-256 hash of the previous entry plus its own content, forming a chain:
// editing, deleting or reordering any entry breaks every hash after it, and verify() reports where.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GENESIS = '0'.repeat(64);
const entryHash = (prevHash, e) => crypto.createHash('sha256')
  .update(prevHash + JSON.stringify([e.at, e.actor || '', e.type || '', e.text, e.detail || '', e.ip || '']))
  .digest('hex');

// Adds `prevHash` and `hash` to a new entry, chained to the last hashed entry in `list`.
function seal(list, entry) {
  const prev = [...list].reverse().find((e) => e.hash);
  entry.prevHash = prev ? prev.hash : GENESIS;
  entry.hash = entryHash(entry.prevHash, entry);
  return entry;
}

// Checks the chain. Entries recorded before chaining existed (no hash) are counted separately.
function verify(list) {
  let prev = null;
  let checked = 0;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e.hash) {
      if (prev) return { ok: false, checked, brokenAt: i, reason: 'An entry without a seal was found after sealing started' };
      continue;
    }
    const expectedPrev = prev ? prev.hash : GENESIS;
    if (e.prevHash !== expectedPrev) return { ok: false, checked, brokenAt: i, reason: 'An entry was removed or reordered' };
    if (entryHash(e.prevHash, e) !== e.hash) return { ok: false, checked, brokenAt: i, reason: 'An entry was changed' };
    prev = e;
    checked++;
  }
  return { ok: true, checked, unsealed: list.filter((e) => !e.hash).length };
}

// Append-only system log (sign-ins, discarded drafts, settings) as one JSON line per entry.
function systemLog(dataDir) {
  const file = path.join(dataDir, 'system-audit.log');
  const read = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  let last = read().slice(-1);
  return {
    add(entry) {
      const e = seal(last, { at: new Date().toISOString(), ...entry });
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
      last = [e];
      return e;
    },
    read,
  };
}

module.exports = { seal, verify, systemLog };
