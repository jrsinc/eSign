// Test: "Fill & sign myself" (the uploader is the only signer and signs at once, nothing emailed) and
// passing signing to someone else (Sachin hands his signature over to Pratik).
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
async function pdfForm(title, extra = {}) {
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText(title, { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([Buffer.from(await src.save())]), `${title}.pdf`);
  return fd;
}

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Admin Person', email: 'admin@test.local', password: 'Strong-pass-2026' });
  ok((await signIn(admin, 'admin@test.local', 'Strong-pass-2026')).status === 200, 'administrator signed in');

  // ---------- Fill & sign myself ----------
  const self = (await admin('/api/documents', await pdfForm('My own form', { selfSign: '1' }))).data;
  ok(self.selfSign === true && self.signers.length === 1 && self.signers[0].email === 'admin@test.local', 'self-sign: the uploader is the only signer');
  const me = self.signers[0];
  // Trying to add other recipients is ignored.
  await admin(`/api/documents/${self.id}`, { signers: [me, { id: 'x', name: 'Other', email: 'other@test.local' }], fields: [] }, false, 'PUT');
  ok((await admin(`/api/documents/${self.id}`)).data.signers.length === 1, 'self-sign: other recipients can\'t be added');
  ok((await admin(`/api/documents/${self.id}/self-sign`, {})).status === 400, 'self-sign: refused without a signature field');
  await admin(`/api/documents/${self.id}`, { fields: [{ id: 'sf', signerId: me.id, type: 'signature', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.07 }] }, false, 'PUT');
  const mailsBefore = logText().split('[mail disabled]').length;
  const started = await admin(`/api/documents/${self.id}/self-sign`, {});
  ok(started.status === 200 && /^\/sign\.html\?t=/.test(started.data.link), 'self-sign: started, returns the signing page link');
  ok(logText().split('[mail disabled]').length === mailsBefore, 'self-sign: no invitation email is sent');
  const selfToken = started.data.link.split('t=')[1];
  const sv = await admin(`/api/sign/${selfToken}`);
  ok(sv.status === 200 && sv.data.selfSign === true && sv.data.auth.flow === 'account', 'self-sign: the owner opens their own signing page');
  ok((await admin(`/api/sign/${selfToken}/reassign`, { name: 'X', email: 'x@test.local', reason: 'r', password: 'Strong-pass-2026' })).status === 400, 'self-sign: can\'t be passed to someone else');
  const signed = await admin(`/api/sign/${selfToken}`, { consent: true, values: { sf: PNG }, reason: 'I am the author', tz: 'UTC', password: 'Strong-pass-2026' });
  ok(signed.status === 200 && signed.data.completed === true, 'self-sign: signed with own password, agreement completed');
  const done = (await admin(`/api/documents/${self.id}`)).data;
  ok(done.status === 'completed' && /^AGR-/.test(done.agreementId || ''), 'self-sign: completed with an agreement ID');
  ok((await admin(`/api/documents/${self.id}/signed`, undefined, true)).status === 200, 'self-sign: signed PDF can be downloaded');

  // ---------- Pass signing to someone else ----------
  await admin('/api/users', { name: 'Sachin Patel', email: 'sachin@test.local', role: 'sender', password: 'River-stone-2026' });
  const draft = (await admin('/api/documents', await pdfForm('Purchase order'))).data;
  await admin(`/api/documents/${draft.id}`, {
    signers: [{ id: 's', name: 'Sachin Patel', email: 'sachin@test.local' }, { id: 'o', name: 'Olga Outside', email: 'olga@outside.test' }], signingOrder: 'sequential',
    fields: [{ id: 'f0', signerId: 's', type: 'signature', page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.07 }, { id: 'f1', signerId: 'o', type: 'signature', page: 0, x: 0.1, y: 0.4, w: 0.3, h: 0.07 }],
  }, false, 'PUT');
  const sent = (await admin(`/api/documents/${draft.id}/send`, {})).data;
  const sachinToken = sent.signers.find((s) => s.email === 'sachin@test.local').link.split('t=')[1];
  const sachin = client();
  await signIn(sachin, 'sachin@test.local', 'River-stone-2026');
  ok((await sachin(`/api/sign/${sachinToken}`)).status === 200, 'reassign: Sachin opens his signing link');
  const body = { name: 'Pratik Shah', email: 'pratik@outside.test', reason: 'Pratik approves this project', password: 'River-stone-2026' };
  ok((await admin(`/api/sign/${sachinToken}/reassign`, { ...body, password: 'Strong-pass-2026' })).status === 403, 'reassign: someone else (the sender) can\'t pass it on for Sachin');
  ok((await sachin(`/api/sign/${sachinToken}/reassign`, { ...body, password: 'wrong-password' })).status === 401, 'reassign: wrong password refused');
  ok((await sachin(`/api/sign/${sachinToken}/reassign`, { ...body, reason: '' })).status === 400, 'reassign: a reason is required');
  ok((await sachin(`/api/sign/${sachinToken}/reassign`, { ...body, email: 'olga@outside.test' })).status === 400, 'reassign: can\'t pass to someone already on the agreement');
  ok((await sachin(`/api/sign/${sachinToken}/reassign`, { ...body, email: 'SACHIN@test.local' })).status === 400, 'reassign: can\'t pass to yourself');
  const ra = await sachin(`/api/sign/${sachinToken}/reassign`, body);
  ok(ra.status === 200 && ra.data.to.email === 'pratik@outside.test', 'reassign: Sachin passes signing to Pratik');
  ok((await sachin(`/api/sign/${sachinToken}`)).status === 404, 'reassign: Sachin\'s old link no longer works');
  const after = (await admin(`/api/documents/${draft.id}`)).data;
  const slot = after.signers.find((s) => s.id === 's');
  ok(slot.name === 'Pratik Shah' && slot.email === 'pratik@outside.test' && slot.order === 1 && slot.status === 'pending', 'reassign: Pratik takes Sachin\'s place (same order and fields)');
  ok(slot.reassignedFrom?.[0]?.email === 'sachin@test.local' && slot.reassignedFrom[0].reason === 'Pratik approves this project', 'reassign: who passed it on, and why, is kept');
  ok(after.events.some((e) => /Signing reassigned by Sachin Patel \(sachin@test\.local\) to Pratik Shah \(pratik@outside\.test\)\. Reason: Pratik approves this project/.test(e.text)), 'reassign: recorded in the audit trail');
  ok(mails('pratik@outside.test').some((m) => m.includes('REVIEW DOCUMENT') || m.includes('/sign.html?t=')), 'reassign: Pratik is emailed his own signing link');
  ok(!after.signers.find((s) => s.id === 'o').link, 'reassign: the next signer still waits (sequential order kept)');
  ok((await sachin(`/api/documents/${draft.id}`)).status === 404, 'reassign: Sachin is no longer a recipient of the agreement');

  // Pratik (no account) signs with his temporary password.
  const pratikToken = slot.link.split('t=')[1];
  const pratik = client();
  const pv = await pratik(`/api/sign/${pratikToken}`);
  ok(pv.status === 200 && pv.data.signer.name === 'Pratik Shah' && pv.data.fields.some((f) => f.id === 'f0'), 'reassign: Pratik opens the document and sees Sachin\'s fields');
  await sleep(150);
  const ps = await pratik(`/api/sign/${pratikToken}`, { consent: true, values: { f0: PNG }, reason: 'I approve this document', tz: 'UTC', password: tempFor('pratik@outside.test') });
  ok(ps.status === 200 && ps.data.confirmation.email === 'pratik@outside.test', 'reassign: Pratik signs');
  const next = (await admin(`/api/documents/${draft.id}`)).data.signers.find((s) => s.id === 'o');
  ok(!!next.link, 'reassign: after Pratik signs, the next signer gets their link');
})();
