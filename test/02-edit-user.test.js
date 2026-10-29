// Test: administrators edit a user's name and email; the new email becomes the sign-in ID.
const fs = require('fs');
const B = process.env.B;
const LOG = process.argv[2];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mails = (to) => fs.readFileSync(LOG, 'utf8').split('[mail disabled] To: ').filter((b) => b.startsWith(to));
const codeFor = (to) => (/sign-in code is:\s+(\d{6})/.exec(mails(to).pop() || '') || [])[1];
function client() {
  let cookie = '';
  return async (p, body) => {
    const r = await fetch(B + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
}
async function signIn(c, email, password) {
  const r1 = await c('/api/login', { email, password });
  if (r1.status !== 200) return r1;
  await sleep(150);
  return c('/api/login/verify', { challenge: r1.data.challenge, code: codeFor(email) });
}
(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok((await signIn(admin, 'pratik@test.local', 'Strong-pass-2026')).status === 200, 'administrator signed in');
  const a = await admin('/api/users', { name: 'Divya G', email: 'divya@test.local', role: 'sender', password: 'River-stone-2026' });
  await admin('/api/users', { name: 'Anil Mehta', email: 'anil@test.local', role: 'sender', generate: true });
  const uid = a.data.user.id;
  const divya = client();
  await signIn(divya, 'divya@test.local', 'River-stone-2026');

  ok((await divya(`/api/users/${uid}/details`, { name: 'X', email: 'x@test.local' })).status === 403, 'non-admins cannot edit users');
  ok((await admin(`/api/users/${uid}/details`, { name: 'Divya', email: 'anil@test.local' })).status === 400, 'email already used by another user is refused');
  ok((await admin(`/api/users/${uid}/details`, { name: '', email: 'divya@test.local' })).status === 400, 'empty name refused');
  ok((await admin(`/api/users/${uid}/details`, { name: 'Divya', email: 'not-an-email' })).status === 400, 'invalid email refused');

  const r = await admin(`/api/users/${uid}/details`, { name: 'Divya Gadhiya', email: 'Divya.Gadhiya@Test.local ' });
  ok(r.status === 200 && r.data.user.name === 'Divya Gadhiya' && r.data.user.email === 'divya.gadhiya@test.local', 'administrator changed name and email (email trimmed and lower-cased)');
  await sleep(200);
  ok(mails('divya@test.local').some((m) => m.includes('sign-in ID has changed')) && mails('divya.gadhiya@test.local').some((m) => m.includes('sign-in ID has changed')), 'both old and new addresses are told about the change');
  ok((await divya('/api/me')).data?.user?.email === 'divya.gadhiya@test.local', 'the signed-in user sees the new details at once');
  ok((await client()('/api/login', { email: 'divya@test.local', password: 'River-stone-2026' })).status === 401, 'old email no longer signs in');
  ok((await signIn(client(), 'divya.gadhiya@test.local', 'River-stone-2026')).status === 200, 'new email signs in with the same password, code sent to the new address');
  const log = (await admin('/api/system-log')).data;
  ok(JSON.stringify(log).includes('Details of Divya G (divya@test.local) changed'), 'the change is recorded in the system log');

  // Administrator sets a new password: the user is emailed it, and it works
  const set = await admin(`/api/users/${uid}/set-password`, { generate: true });
  await sleep(200);
  const pwMail = mails('divya.gadhiya@test.local').find((m) => m.includes('password has been changed')) || '';
  ok(set.status === 200 && pwMail.includes('Sign-in ID: divya.gadhiya@test.local') && pwMail.includes(`New password: ${set.data.password}`), 'a new password set by the administrator is emailed to the user with their sign-in ID');
  ok((await signIn(client(), 'divya.gadhiya@test.local', set.data.password)).status === 200, 'the emailed password works');
})().catch((e) => { console.error(e); process.exit(1); });
