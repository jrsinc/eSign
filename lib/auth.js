// Password hashing, password rules, one-time codes and single-use tokens for user accounts.
const crypto = require('crypto');

// scrypt with a per-user salt; stored as "scrypt$<salt>$<hash>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const check = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === check.length && crypto.timingSafeEqual(expected, check);
}

// Returns a message describing what is wrong, or '' when the password is acceptable.
function passwordProblem(password, { email = '', name = '' } = {}) {
  const p = String(password || '');
  if (p.length < 10) return 'Use at least 10 characters.';
  if (p.length > 200) return 'Use at most 200 characters.';
  if (!/[a-z]/i.test(p) || !/\d/.test(p)) return 'Use both letters and numbers.';
  const lower = p.toLowerCase();
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't use your email address in the password.";
  if (name && name.split(/\s+/).some((w) => w.length >= 4 && lower.includes(w.toLowerCase()))) return "Don't use your name in the password.";
  if (/^(password|qwerty|letmein|welcome|admin)/i.test(p)) return 'That password is too easy to guess.';
  return '';
}

// 6-digit code for two-step sign-in. Only its hash is kept on the server.
const newOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashSecret = (value, salt = '') => crypto.createHash('sha256').update(`${salt}:${value}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Long random token for invitation and password-reset links; only its hash is stored.
const newToken = () => crypto.randomBytes(32).toString('base64url');

// "pratiks@jrsllc.com" -> "pr*****@jrsllc.com"
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, newOtp, hashSecret, sameHash, newToken, maskEmail };
