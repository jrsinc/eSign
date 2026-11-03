// env: LOGIN_CODE=off PASSWORD_MAX_AGE_DAYS=0.0001 PASSWORD_HISTORY=3
// Test: passwords expire (here after about 8.6 seconds), the last 3 passwords can't be reused, a user with
// an expired password can't sign in until an administrator sets a new one, and an administrator renews
// their own expired password at sign-in.
const B = process.env.B;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXPIRY_MS = 0.0001 * 864e5;
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
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026a' });
  const first = await admin('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026a' });
  ok(first.status === 200, 'administrator signs in while the password is fresh' + (first.status === 200 ? '' : JSON.stringify(first.data)));
  const me = (await admin('/api/me')).data;
  ok(me.passwordPolicy.history === 3 && me.passwordPolicy.maxAgeDays > 0 && me.user.passwordExpiresAt, 'the policy and the expiry date are shown to the dashboard');

  const created = await admin('/api/users', { name: 'Sara Sender', email: 'sara@test.local', role: 'sender', password: 'River-stone-2026a', permissions: {} });
  const saraId = created.data.user.id;
  ok(Date.parse(created.data.user.passwordExpiresAt) > Date.now(), 'a new user gets a password expiry date');
  await sleep(EXPIRY_MS + 800);

  const sara = client();
  const expired = await sara('/api/login', { email: 'sara@test.local', password: 'River-stone-2026a' });
  ok(expired.status === 403 && expired.data.passwordExpired && !expired.data.canChange && /expired/.test(expired.data.error), 'an expired password is refused at sign-in; the user is told to ask an administrator');
  ok((await sara('/api/login', { email: 'sara@test.local', password: 'wrong-password-1' })).status === 401, 'a wrong password still gets the usual answer (expiry is only revealed with the right password)');
  const log = (await admin('/api/system-log')).data.entries.map((e) => e.text);
  ok(log.some((t) => /Sign-in refused for sara@test.local: password expired/.test(t)), 'the refusal is in the system log');
  ok((await admin('/api/users')).data.find((u) => u.id === saraId).passwordExpiresAt <= new Date().toISOString(), 'the Users page shows the password as expired');

  // History: the current and previous passwords can't be reused.
  ok((await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026a' })).status === 400, 'the administrator can\'t set the current password again');
  ok((await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026b' })).status === 200, 'the administrator sets a new password');
  ok((await sara('/api/login', { email: 'sara@test.local', password: 'River-stone-2026b' })).status === 200, 'the user signs in with the new password');
  await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026c' });
  ok((await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026a' })).status === 400, 'a password from 2 changes ago is refused (history of 3)');
  await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026d' });
  ok((await admin(`/api/users/${saraId}/set-password`, { password: 'River-stone-2026a' })).status === 200, 'a password older than the history can be used again');

  // The administrator's own password has expired too: renewed at sign-in.
  const admin2 = client();
  await sleep(EXPIRY_MS + 800);
  const aexp = await admin2('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026a' });
  ok(aexp.status === 403 && aexp.data.canChange, 'an administrator with an expired password is offered to choose a new one');
  ok((await admin2('/api/password/expired', { email: 'pratik@test.local', current: 'Strong-pass-2026a', next: 'Strong-pass-2026a' })).status === 400, 'the new password can\'t be the expired one');
  ok((await admin2('/api/password/expired', { email: 'pratik@test.local', current: 'wrong-pass-2026', next: 'Strong-pass-2026b' })).status === 400, 'renewal needs the current password');
  ok((await admin2('/api/password/expired', { email: 'sara@test.local', current: 'River-stone-2026a', next: 'River-stone-2026z' })).status === 400, 'a non-administrator can\'t renew their own password');
  ok((await admin2('/api/password/expired', { email: 'pratik@test.local', current: 'Strong-pass-2026a', next: 'Strong-pass-2026b' })).status === 200, 'the administrator saves a new password');
  ok((await admin2('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026b' })).status === 200, 'and signs in with it');
})().catch((e) => { console.error(e); process.exitCode = 1; });
