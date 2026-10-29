// env: LOGIN_CODE=off
// Test: with sign-in codes turned off (testing only), the password alone signs in, no code is emailed,
// lockout still works, the system log says so, and administrators are warned.
const fs = require('fs');
const B = process.env.B;
const LOG = process.argv[2];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

(async () => {
  ok((await client()('/api/auth/status')).data.loginCode === false, 'the sign-in page is told codes are off');
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  const r = await admin('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok(r.status === 200 && r.data.signedIn === true && !r.data.challenge, 'the right password signs in straight away');
  const me = await admin('/api/me');
  ok(me.status === 200 && me.data.loginCode === false, 'the session works, and the dashboard can show the warning');
  await sleep(150);
  ok(!/sign-in code is/.test(fs.readFileSync(LOG, 'utf8')), 'no sign-in code is emailed');
  const log = JSON.stringify((await admin('/api/system-log')).data.entries);
  ok(log.includes('signed in (password only - sign-in codes are turned off)'), 'the system log records password-only sign-ins');

  await admin('/api/users', { name: 'Divya Gadhiya', email: 'divya@test.local', role: 'sender', password: 'River-stone-2026' });
  const bad = client();
  for (let i = 0; i < 5; i++) await bad('/api/login', { email: 'divya@test.local', password: `wrong-${i}` });
  ok((await bad('/api/login', { email: 'divya@test.local', password: 'River-stone-2026' })).status === 423, 'five wrong passwords still lock the account');
})().catch((e) => { console.error(e); process.exit(1); });
