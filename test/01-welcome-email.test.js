// Test: the welcome email for a new user carries the sign-in ID and password, and that password works.
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
  for (const [label, body] of [['typed', { password: 'River-stone-2026' }], ['generated', { generate: true }]]) {
    const email = `${label}@test.local`;
    const r = await admin('/api/users', { name: `User ${label}`, email, role: 'sender', ...body });
    await sleep(200);
    const welcome = mails(email).find((m) => m.includes('Welcome') || m.includes('has created an account')) || '';
    ok(r.status === 200 && welcome.includes(`Sign-in ID: ${email}`) && welcome.includes(`Password: ${r.data.password}`), `${label} password: welcome email contains the sign-in ID and password`);
    const emailed = (/Password: (\S+)/.exec(welcome) || [])[1];
    ok((await signIn(client(), email, emailed)).status === 200, `${label} password: user signs in with the emailed ID, password and code`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
