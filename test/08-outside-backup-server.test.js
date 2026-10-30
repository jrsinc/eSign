// Test: outside signers (system log, account request as a support ticket, list), Generate password,
// backup schedule and server backups, and that only the system administrator may restart the server.
const fs = require('fs');
const path = require('path');
const root = process.argv[3];
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const B = process.env.B;
const LOG = process.argv[2];
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

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok((await signIn(admin, 'pratik@test.local', 'Strong-pass-2026')).status === 200, 'first administrator signed in');

  // ---- Generate password ----
  const gen = await admin('/api/password/generate');
  ok(gen.status === 200 && gen.data.password.length >= 10 && /\d/.test(gen.data.password) && /[a-z]/i.test(gen.data.password), 'Generate returns a strong password to show in the box');
  ok((await admin('/api/users', { name: 'Ravi Kumar', email: 'ravi@test.local', role: 'admin', password: gen.data.password, permissions: {} })).status === 200, 'a generated password is accepted when adding a user');
  await admin('/api/users', { name: 'Sara Sender', email: 'sara@test.local', role: 'sender', password: 'River-stone-2026' });
  const ravi = client();
  ok((await signIn(ravi, 'ravi@test.local', gen.data.password)).status === 200, 'second administrator (full access) signs in with the generated password');
  const sara = client();
  await signIn(sara, 'sara@test.local', 'River-stone-2026');
  ok((await sara('/api/password/generate')).status === 403, 'a sender can\'t generate passwords');

  // ---- System administrator ----
  ok((await admin('/api/me')).data.user.systemAdmin === true && (await ravi('/api/me')).data.user.systemAdmin === false, 'the first administrator is the system administrator; other administrators are not');
  ok((await ravi('/api/server')).status === 403, 'another administrator can\'t open the server page');
  ok((await ravi('/api/server/restart', { mode: 'update', password: gen.data.password })).status === 403, 'another administrator can\'t restart the server, even with full access');
  ok((await ravi('/api/server/restart', { mode: 'erase', password: gen.data.password, confirm: 'ERASE' })).status === 403, 'another administrator can\'t erase data');
  const srv = await admin('/api/server');
  ok(srv.status === 200 && srv.data.eraseAllowed === true, 'the system administrator sees the server page; erasing is allowed on a test server');
  ok((await admin('/api/server/restart', { mode: 'update', password: 'wrong-password-1' })).status === 403, 'restart needs the system administrator\'s password');
  ok((await admin('/api/server/restart', { mode: 'erase', password: 'Strong-pass-2026', confirm: 'erase' })).status === 400, 'erasing needs ERASE typed exactly');
  const users = (await ravi('/api/users')).data;
  const pratikId = users.find((u) => u.email === 'pratik@test.local').id;
  ok(users.find((u) => u.id === pratikId).systemAdmin, 'the Users page marks the system administrator');
  ok((await ravi(`/api/users/${pratikId}/role`, { role: 'sender' })).status === 400, 'the system administrator can\'t be made a sender');
  ok((await ravi(`/api/users/${pratikId}/disable`, {})).status === 400, 'the system administrator can\'t be deactivated');

  // ---- Outside signer: system log, account request ticket, list ----
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText('Outside test', { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), 'Outside test.pdf');
  const doc = (await admin('/api/documents', fd)).data;
  await admin(`/api/documents/${doc.id}`, {
    // Asking for no reason is ignored: every signature states its meaning.
    signers: [{ id: 'o', name: 'Olga Outside', email: 'olga@outside.test' }], signingOrder: 'parallel', requireReason: false,
    fields: [0, 1, 2].map((i) => ({ id: `f${i}`, signerId: 'o', type: 'signature', page: 0, x: 0.1, y: 0.2 + i * 0.2, w: 0.3, h: 0.07 })),
  }, false, 'PUT');
  const sent = (await admin(`/api/documents/${doc.id}/send`, {})).data;
  const token = sent.signers[0].link.split('t=')[1];
  const olga = client();
  ok((await olga(`/api/sign/${token}`)).data.requireReason === true, 'the signing page always asks for a reason, even if the sender tried to turn it off');
  await sleep(200);
  ok((await olga(`/api/sign/${token}`, { consent: true, values: { f0: PNG, f1: PNG, f2: PNG }, tz: 'UTC', password: tempFor('olga@outside.test') })).status === 400, 'signing without a reason is refused');
  ok((await olga(`/api/sign/${token}`, { consent: true, values: { f0: PNG, f1: PNG }, reason: 'I approve this document', tz: 'UTC', password: tempFor('olga@outside.test') })).status === 400, 'every signature place must be signed (one left empty is refused)');
  ok((await olga(`/api/sign/${token}`, { consent: true, values: { f0: PNG, f1: PNG, f2: PNG }, reason: 'I approve this document', tz: 'UTC', password: 'wrong-temp-1' })).status === 401, 'wrong temporary password refused');
  const signed = await olga(`/api/sign/${token}`, { consent: true, values: { f0: PNG, f1: PNG, f2: PNG }, reason: 'I approve this document', tz: 'UTC', password: tempFor('olga@outside.test') });
  ok(signed.status === 200 && signed.data.canRequestAccount, 'outside signer signs all three places with the temporary password');
  const sys = (await admin('/api/system-log')).data.entries.filter((e) => e.actor === 'Olga Outside (olga@outside.test) - outside signer');
  const texts = sys.map((e) => e.text).join('\n');
  ok(texts.includes('Agreement opened for signing') && texts.includes('Temporary signing password emailed') && texts.includes('Wrong temporary password at signing') && texts.includes('Agreement signed with a temporary password'), 'the system log shows the outside signer\'s activity');
  const docEvents = (await admin(`/api/documents/${doc.id}`)).data.events;
  ok(docEvents.some((e) => e.text.startsWith('Document e-signed by Olga') && e.actor === 'Olga Outside (olga@outside.test)'), 'the agreement\'s audit trail still names the signer as before');

  const ra = await olga(`/api/sign/${token}/request-account`, {});
  ok(ra.status === 200 && /^CASE-\d{4}-\d{5}$/.test(ra.data.caseNo), 'account request returns a case number');
  ok((await olga(`/api/sign/${token}/request-account`, {})).data.caseNo === ra.data.caseNo, 'asking again returns the same case');
  const tickets = (await admin('/api/tickets')).data;
  const tk = tickets.find((t) => t.caseNo === ra.data.caseNo);
  ok(tk && tk.kind === 'account' && tk.status === 'open' && tk.email === 'olga@outside.test' && !tk.account, 'the request is an open support ticket for administrators');
  ok((await admin('/api/system-log')).data.entries.some((e) => e.text.includes(`support ticket ${ra.data.caseNo} opened`)), 'the request is in the system log');
  let outside = (await admin('/api/outside-signers')).data;
  const o = outside.find((p) => p.email === 'olga@outside.test');
  ok(o && o.signed === 1 && o.request === ra.data.caseNo && o.agreements[0].agreementId === sent.agreementId, 'Outside signers lists her with the agreement and the open request');
  ok(!outside.some((p) => p.email === 'pratik@test.local'), 'account holders are not outside signers');
  ok((await sara('/api/outside-signers')).status === 403, 'a sender can\'t see the outside signers list');
  await admin('/api/users', { name: 'Olga Outside', email: 'olga@outside.test', role: 'sender', generate: true, permissions: {} });
  ok((await admin('/api/tickets')).data.find((t) => t.caseNo === ra.data.caseNo).status === 'resolved', 'creating her account resolves the request');
  outside = (await admin('/api/outside-signers')).data;
  ok(!outside.some((p) => p.email === 'olga@outside.test'), 'with an account she leaves the outside signers list');

  // ---- After signing: "a copy is saved to your account, log in to view it" ----
  ok(signed.data.view === null, 'without an account, no "log in to view" offer after signing');
  const again = (await olga(`/api/sign/${token}`)).data;
  ok(again.expired && again.view && again.view.email === 'olga@outside.test' && again.view.path === `/#/doc/${doc.id}` && again.view.signedIn === false, 'with an account, the signing link offers "log in to view" this agreement');
  await sleep(200);
  const olgaPw = (/Password: (\S+)/.exec(mails('olga@outside.test').filter((m) => m.includes('Sign-in ID')).pop() || '') || [])[1];
  ok((await signIn(olga, 'olga@outside.test', olgaPw)).status === 200, 'she logs in with the account details emailed to her');
  ok((await olga(`/api/sign/${token}`)).data.view.signedIn === true, 'once logged in, the offer goes straight to the agreement');
  const viewed = await olga(`/api/documents/${doc.id}`);
  ok(viewed.status === 200 && viewed.data.access === 'recipient' && viewed.data.status === 'completed', 'she can view her signed agreement after logging in');
  ok((await olga(`/api/documents/${doc.id}/signed`, undefined, true)).status === 200, 'and download the signed copy');

  // ---- Backups ----
  let bk = (await admin('/api/backups')).data;
  ok(bk.schedule.frequency === 'off' && bk.nextAt === null && bk.timeZone, 'outside production, automatic backups start off');
  ok((await admin('/api/backups/schedule', { frequency: 'daily', time: '25:00', keep: 5 }, false, 'PUT')).status === 400, 'an invalid time is refused');
  ok((await sara('/api/backups/schedule', { frequency: 'daily', time: '03:30', keep: 5 }, false, 'PUT')).status === 403, 'a sender can\'t set the backup schedule');
  const setSch = await admin('/api/backups/schedule', { frequency: 'weekly', day: 1, time: '03:30', keep: 5 }, false, 'PUT');
  const next = new Date(setSch.data.nextAt);
  ok(setSch.status === 200 && next > new Date() && next.getDay() === 1 && next.getHours() === 3 && next.getMinutes() === 30, 'weekly schedule: next backup is the coming Monday 03:30 server time');
  const run = await admin('/api/backups/run', {});
  bk = (await admin('/api/backups')).data;
  const file = bk.files.find((f) => f.name === run.data.name);
  ok(run.status === 200 && file && file.kind === 'Saved on server' && file.size > 0, 'Save on the server now: the backup is listed');
  ok(bk.schedule.frequency === 'weekly' && bk.schedule.updatedBy.startsWith('Pratik Shah'), 'the saved schedule is shown with who set it');
  ok(bk.log.some((e) => e.text.includes('schedule set to every Monday at 03:30')) && bk.log.some((e) => e.text.includes('Backup saved on the server')), 'the backup log shows the schedule change and the backup');
  const dl = await admin(`/api/backups/file/${encodeURIComponent(run.data.name)}`, undefined, true);
  ok(dl.status === 200 && (await dl.arrayBuffer()).byteLength === file.size, 'a server backup downloads');
  ok((await admin('/api/backups/file/..%2Fdata%2Fdb.json', undefined, true)).status === 404, 'only backup files can be downloaded');
  ok((await ravi('/api/backups')).status === 200 && (await sara('/api/backups')).status === 403, 'every administrator can manage backups; senders can\'t');
})().catch((e) => { console.error(e); process.exitCode = 1; });
