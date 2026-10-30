// Test: company list, full admin access, backup download and restore.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const root = process.argv[3];
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const B = process.env.B;
const LOG = process.argv[2];
const DATA = process.env.DATA_DIR;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mails = (to) => fs.readFileSync(LOG, 'utf8').split('[mail disabled] To: ').filter((b) => b.startsWith(to));
const codeFor = (to) => (/sign-in code is:\s+(\d{6})/.exec(mails(to).pop() || '') || [])[1];
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
const fileForm = (buf, extra = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'b.esbackup');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok((await signIn(admin, 'pratik@test.local', 'Strong-pass-2026')).status === 200, 'administrator signed in');
  const d = await admin('/api/users', { name: 'Divya Gadhiya', email: 'divya@test.local', role: 'sender', password: 'River-stone-2026' });
  const divya = client();
  await signIn(divya, 'divya@test.local', 'River-stone-2026');

  // Company list
  ok((await divya('/api/companies', { name: 'X Corp' })).status === 403, 'only administrators add companies');
  const a = await admin('/api/companies', { name: 'Jupiter Research Services Inc' });
  await admin('/api/companies', { name: 'Method 365' });
  ok(a.status === 200 && (await admin('/api/companies', { name: '  jupiter research   services inc ' })).status === 400, 'company added; the same name again is refused');
  ok((await admin(`/api/companies/${a.data.id}`, { name: 'Jupiter Research Services' }, false, 'PUT')).data.name === 'Jupiter Research Services', 'company renamed');
  const tmp = await admin('/api/companies', { name: 'Temp Co' });
  ok((await admin(`/api/companies/${tmp.data.id}`, undefined, false, 'DELETE')).status === 200 && !(await divya('/api/companies')).data.some((c) => c.name === 'Temp Co'), 'company removed; signed-in users see the list');

  // Agreement with a Company field; the sign page gets the list; "Other" typed name is accepted
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText('Company test', { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), 'Company Test.pdf');
  const doc = (await admin('/api/documents', fd)).data;
  await admin(`/api/documents/${doc.id}`, { signers: [{ id: 's', name: 'Signer One', email: 'signer@test.local' }], fields: [
    { id: 'f', signerId: 's', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.07 },
    { id: 'c', signerId: 's', type: 'company', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.04, required: true },
  ] }, false, 'PUT');
  const sent = (await admin(`/api/documents/${doc.id}/send`, {})).data;
  const token = sent.signers[0].link.split('t=')[1];
  const info = (await client()(`/api/sign/${token}`)).data;
  ok(JSON.stringify(info.companies) === JSON.stringify(['Jupiter Research Services', 'Method 365']), 'sign page receives the company list, sorted');
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await sleep(200);
  const temp = (/Temporary password: (\S+)/.exec(mails('signer@test.local').filter((m) => m.includes('Temporary password:')).pop() || '') || [])[1];
  const sg = await client()(`/api/sign/${token}`, { consent: true, values: { f: PNG, c: 'Acme Labs (typed)' }, reason: 'I approve this document', tz: 'UTC', password: temp });
  const signedDoc = (await admin(`/api/documents/${doc.id}`)).data;
  ok(sg.status === 200 && signedDoc.signers[0].company === 'Acme Labs (typed)', 'a company typed with "Other" is saved with the signature');

  // Full admin access
  ok((await divya('/api/users')).status === 403, 'sender has no admin pages');
  await admin(`/api/users/${d.data.user.id}/role`, { role: 'admin' });
  ok((await divya('/api/users')).status === 200 && (await divya('/api/system-log')).status === 200 && (await divya('/api/backup', undefined, true)).status === 200, 'after "Administrator (full access)" the user can manage users, see the system log and download backups');
  await admin(`/api/users/${d.data.user.id}/role`, { role: 'sender' });
  ok((await divya('/api/backup', undefined, true)).status === 403, 'sender cannot download a backup');

  // Backup
  const br = await admin('/api/backup', undefined, true);
  const backup = Buffer.from(await br.arrayBuffer());
  const body = JSON.parse(zlib.gunzipSync(backup));
  ok(br.status === 200 && /\.esbackup"$/.test(br.headers.get('content-disposition')) && body.files['db.json'] && body.files['pki/ca-key.pem'] && body.files['system-audit.log'] && Object.keys(body.files).some((k) => k.startsWith('files/')) && !body.files['sessions.json'], 'backup has the database, PDFs, certificate keys and system log, but no sign-in sessions');
  const check = await admin('/api/restore/check', fileForm(backup));
  ok(check.status === 200 && check.data.counts.agreements === 1 && check.data.counts.companies === 2, 'backup check shows what it contains');

  // Changes after the backup, which the restore should undo
  await admin('/api/companies', { name: 'Added After Backup' });
  await admin('/api/users', { name: 'Later User', email: 'later@test.local', role: 'sender', generate: true });

  // Bad restores
  ok((await admin('/api/restore/check', fileForm(Buffer.from('hello')))).status === 400, 'a file that is not a backup is refused');
  const tampered = JSON.parse(JSON.stringify(body));
  tampered.files['db.json'] = Buffer.from(JSON.stringify({ documents: [], users: [] })).toString('base64');
  ok((await admin('/api/restore/check', fileForm(zlib.gzipSync(JSON.stringify(tampered))))).data?.error?.includes('damaged'), 'a changed backup is refused (checksum)');
  const evil = JSON.parse(JSON.stringify(body));
  evil.files['../evil.txt'] = Buffer.from('x').toString('base64');
  ok((await admin('/api/restore/check', fileForm(zlib.gzipSync(JSON.stringify(evil))))).status === 400, 'a backup with an unsafe file path is refused');
  ok((await admin('/api/restore', fileForm(backup, { password: 'wrong-password-1' }))).status === 403, 'restore needs the administrator\'s password');
  ok((await divya('/api/restore', fileForm(backup, { password: 'River-stone-2026' }))).status === 403, 'senders cannot restore');

  // Real restore
  const rs = await admin('/api/restore', fileForm(backup, { password: 'Strong-pass-2026' }));
  ok(rs.status === 200 && fs.existsSync(path.join(path.dirname(DATA), 'backups', rs.data.restorePoint)), `restored; previous data saved as a restore point (${rs.data.restorePoint})`);
  ok((await admin('/api/me')).status === 401 && (await divya('/api/me')).status === 401, 'everyone is signed out after a restore');
  const admin2 = client();
  ok((await signIn(admin2, 'pratik@test.local', 'Strong-pass-2026')).status === 200, 'administrator signs in again');
  const names = (await admin2('/api/companies')).data.map((c) => c.name);
  ok(!names.includes('Added After Backup') && names.length === 2, 'company added after the backup is gone');
  ok(!(await admin2('/api/users')).data.some((u) => u.email === 'later@test.local'), 'user added after the backup is gone');
  const sig = Buffer.from(await (await admin2(`/api/documents/${doc.id}/signed`, undefined, true)).arrayBuffer());
  const vf = new FormData();
  vf.append('file', new Blob([sig]), 'x.pdf');
  ok((await (await fetch(B + '/api/verify', { method: 'POST', body: vf })).json()).valid, 'the restored signed PDF downloads and still verifies');
  const log = JSON.stringify((await admin2('/api/system-log')).data);
  ok(log.includes('Data restored from a backup') && log.includes('Backup downloaded'), 'backup and restore are recorded in the system log');
  ok((await admin2('/api/system-log')).data.integrity?.ok !== false, 'system log chain still verifies after the restore');
})().catch((e) => { console.error(e); process.exit(1); });
