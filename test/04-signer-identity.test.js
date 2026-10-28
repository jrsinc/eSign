// Test: only the invited recipient can sign. Flow A (account + password), flow B (temporary password),
// lockout, segregation of duties, document version check, decline needs a password, account request.
const fs = require('fs');
const path = require('path');
const root = process.argv[3];
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const B = process.env.B;
const LOG = process.argv[2];
const DATA = process.env.DATA_DIR;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = () => fs.readFileSync(LOG, 'utf8');
const mails = (to) => logText().split('[mail disabled] To: ').filter((b) => b.startsWith(to));
const codeFor = (to) => (/sign-in code is:\s+(\d{6})/.exec(mails(to).pop() || '') || [])[1];
const tempFor = (to) => (/Temporary password: (\S+)/.exec(mails(to).filter((m) => m.includes('Temporary password:')).pop() || '') || [])[1];
function client() {
  let cookie = '';
  return async (p, body, raw, method) => {
    const r = await fetch(B + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return r;
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
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let admin;
async function sendDoc(title, signers) {
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText(title, { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), `${title}.pdf`);
  const doc = (await admin('/api/documents', fd)).data;
  await admin(`/api/documents/${doc.id}`, {
    signers, signingOrder: 'parallel', requireReason: true,
    fields: signers.map((s, i) => ({ id: `f${i}`, signerId: s.id, type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.1, w: 0.3, h: 0.07 })),
  }, false, 'PUT');
  const sent = (await admin(`/api/documents/${doc.id}/send`, {})).data;
  return { id: doc.id, tokens: sent.signers.map((s) => s.link.split('t=')[1]) };
}
const signBody = (i, password) => ({ consent: true, values: { [`f${i}`]: PNG }, reason: 'I approve this document', tz: 'UTC', password });

(async () => {
  admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok((await signIn(admin, 'pratik@test.local', 'Strong-pass-2026')).status === 200, 'administrator signed in');
  await admin('/api/users', { name: 'Anil Mehta', email: 'anil@test.local', role: 'sender', password: 'River-stone-2026' });

  // Recipient emails differ only in case/spaces from the account
  const d1 = await sendDoc('Main agreement', [{ id: 'a', name: 'Anil Mehta', email: '  ANIL@Test.local ' }, { id: 'o', name: 'Olga Outside', email: 'olga@outside.test' }]);
  const [tA, tO] = d1.tokens;

  // ---- Flow A: existing account ----
  const anon = client();
  const g0 = await anon(`/api/sign/${tA}`);
  ok(g0.status === 403 && g0.data.identity?.reason === 'login' && !g0.data.fields, 'A: not signed in -> blocked, asked to sign in, no document data sent');
  ok((await anon(`/api/sign/${tA}/file`, undefined, true)).status === 403, 'A: the PDF itself is refused when not signed in');
  ok((await anon(`/api/sign/${tA}`, signBody(0, 'River-stone-2026'))).status === 403, 'A: final sign request refused when not signed in, even with the right password');

  const g1 = await admin(`/api/sign/${tA}`);
  ok(g1.status === 403 && g1.data.identity?.reason === 'mismatch' && g1.data.error === 'You are logged in as pratik@test.local, but this document was sent to anil@test.local. Please log out and log in with anil@test.local, or contact the sender.', 'A: signed in as someone else -> blocked with the exact message');
  ok((await admin(`/api/sign/${tA}`, signBody(0, 'Strong-pass-2026'))).status === 403, 'A: someone else cannot sign with their own password');

  const anil = client();
  await signIn(anil, 'anil@test.local', 'River-stone-2026');
  const g2 = await anil(`/api/sign/${tA}`);
  ok(g2.status === 200 && g2.data.auth.flow === 'account' && g2.data.auth.signedInAs === 'anil@test.local', 'A: signed in as the invited email (case-insensitive) -> can view');
  ok((await anil(`/api/sign/${tA}`, signBody(0))).data?.error === 'Password incorrect. Please try again.', 'A: no password -> "Password incorrect"');
  ok((await anil(`/api/sign/${tA}`, signBody(0, 'Strong-pass-2026'))).status === 401, 'A: another person\'s password is refused');
  const s1 = await anil(`/api/sign/${tA}`, signBody(0, 'River-stone-2026'));
  ok(s1.status === 200 && s1.data.confirmation?.reason === 'I approve this document' && !s1.data.canRequestAccount, 'A: own account password -> signed, confirmation returned');

  // ---- Flow B: no account, temporary password ----
  const outsider = client();
  const g3 = await outsider(`/api/sign/${tO}`);
  await sleep(200);
  const temp1 = tempFor('olga@outside.test');
  ok(g3.status === 200 && g3.data.auth.flow === 'temp' && g3.data.auth.tempSent && temp1, 'B: first open emails a temporary password to the invited email automatically');
  ok(!mails('pratik@test.local').some((m) => m.includes(temp1)), 'B: the sender is never emailed the temporary password');
  const adminView = JSON.stringify((await admin(`/api/documents/${d1.id}`)).data);
  ok(!adminView.includes('tempPw') && !adminView.includes(temp1) && adminView.includes('"tempPasswordSent":true'), 'B: the sender\'s view shows only that it was sent, never the password or its hash');
  ok((await outsider(`/api/sign/${tO}/temp-password`, {})).status === 429, 'B: asking again within a minute is refused');
  ok((await outsider(`/api/sign/${tO}`, signBody(1, 'wrong-temp-pass'))).data?.error === 'Password incorrect. Please try again.', 'B: wrong temporary password refused');
  ok((await outsider(`/api/sign/${tO}`, signBody(1, 'River-stone-2026'))).status === 401, 'B: an account password does not work in place of the temporary one');
  const s2 = await outsider(`/api/sign/${tO}`, signBody(1, temp1));
  ok(s2.status === 200 && s2.data.completed && s2.data.canRequestAccount, 'B: correct temporary password -> signed, agreement completed, account offer');
  const db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
  const olga = db.documents.find((d) => d.id === d1.id).signers.find((s) => s.email === 'olga@outside.test');
  ok(!olga.tempPw && olga.tempPwUsedAt, 'B: the temporary password is invalidated immediately after use');
  const events = (await admin(`/api/documents/${d1.id}`)).data.events.map((e) => `${e.text} | ${e.detail || ''}`).join('\n');
  ok(events.includes('password re-entered at signing') && events.includes('one-time temporary password emailed to olga@outside.test') && events.includes('Identity: signer email matches invited email'), 'audit trail records how each signer was verified');
  ok(events.includes('Access refused: signing link for Anil Mehta') && events.includes('Wrong password at signing'), 'audit trail records the refused access and wrong passwords');
  const ra = await outsider(`/api/sign/${tO}/request-account`, {});
  await sleep(200);
  ok(ra.status === 200 && mails('pratik@test.local').some((m) => m.includes('Account request')), 'B: optional account request after signing reaches the administrators');
  const sig = Buffer.from(await (await admin(`/api/documents/${d1.id}/signed`, undefined, true)).arrayBuffer());
  const vf = new FormData();
  vf.append('file', new Blob([sig]), 'x.pdf');
  ok((await (await fetch(B + '/api/verify', { method: 'POST', body: vf })).json()).valid, 'the completed agreement verifies');

  // ---- Lockout after 5 wrong passwords ----
  const d2 = await sendDoc('Lockout test', [{ id: 'o', name: 'Lena Lock', email: 'lena@outside.test' }]);
  const lena = client();
  await lena(`/api/sign/${d2.tokens[0]}`);
  await sleep(200);
  const temp2 = tempFor('lena@outside.test');
  let last;
  for (let i = 0; i < 5; i++) last = await lena(`/api/sign/${d2.tokens[0]}`, signBody(0, `wrong-${i}`));
  ok(last.status === 423, '5 wrong passwords -> signing locked');
  ok((await lena(`/api/sign/${d2.tokens[0]}`, signBody(0, temp2))).status === 423, 'while locked, even the right password is refused');
  await sleep(200);
  ok(mails('pratik@test.local').some((m) => m.includes('Signing locked: Lena Lock')), 'the sender is notified of the lock');

  // ---- Segregation of duties: one person, one signature per agreement ----
  const d3 = await sendDoc('Duties test', [{ id: 'x', name: 'Sam Same', email: 'sam@outside.test' }, { id: 'y', name: 'Sam Same', email: 'sam@outside.test' }]);
  const sam = client();
  await sam(`/api/sign/${d3.tokens[0]}`);
  await sleep(200);
  ok((await sam(`/api/sign/${d3.tokens[0]}`, signBody(0, tempFor('sam@outside.test')))).status === 200, 'SoD: first signature by sam accepted');
  await sam(`/api/sign/${d3.tokens[1]}`);
  await sleep(200);
  const sod = await sam(`/api/sign/${d3.tokens[1]}`, signBody(1, tempFor('sam@outside.test')));
  ok(sod.status === 403 && /only once/.test(sod.data.error), 'SoD: the same person cannot sign a second time as another recipient');

  // ---- Document version unchanged ----
  const d4 = await sendDoc('Version test', [{ id: 'v', name: 'Vic Version', email: 'vic@outside.test' }]);
  const vic = client();
  await vic(`/api/sign/${d4.tokens[0]}`);
  await sleep(200);
  const orig = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8')).documents.find((d) => d.id === d4.id).originalFile;
  fs.appendFileSync(path.join(DATA, 'files', orig), '\n% changed');
  const ver = await vic(`/api/sign/${d4.tokens[0]}`, signBody(0, tempFor('vic@outside.test')));
  ok(ver.status === 409, 'a document changed after sending cannot be signed');

  // ---- Decline needs the password too ----
  const d5 = await sendDoc('Decline test', [{ id: 'z', name: 'Dee Decline', email: 'dee@outside.test' }]);
  const dee = client();
  await dee(`/api/sign/${d5.tokens[0]}`);
  await sleep(200);
  ok((await anon(`/api/sign/${d5.tokens[0]}/decline`, { reason: 'x' })).status === 401, 'declining without the temporary password is refused');
  ok((await dee(`/api/sign/${d5.tokens[0]}/decline`, { reason: 'Not mine', password: tempFor('dee@outside.test') })).status === 200, 'declining with the temporary password works');

  // ---- Deactivated account ----
  const users = (await admin('/api/users')).data;
  const anilId = users.find((u) => u.email === 'anil@test.local').id;
  const d6 = await sendDoc('Inactive test', [{ id: 'a', name: 'Anil Mehta', email: 'anil@test.local' }]);
  await admin(`/api/users/${anilId}/disable`, {});
  ok((await client()(`/api/sign/${d6.tokens[0]}`)).data?.identity?.reason === 'inactive', 'a deactivated account\'s recipient cannot sign (no fallback to a temporary password)');
})().catch((e) => { console.error(e); process.exit(1); });
