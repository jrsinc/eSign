// Test: document visibility (admin all; users their own + sent to them) and the locked, copy-protected PDF.
const fs = require('fs');
const path = require('path');
const root = process.argv[3];
const pdfjs = require(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const B = process.env.B;
const LOG = process.argv[2];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mails = (to) => fs.readFileSync(LOG, 'utf8').split('[mail disabled] To: ').filter((b) => b.startsWith(to));
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
async function upload(c, title) {
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText(`${title} body text`, { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), `${title}.pdf`);
  return (await c('/api/documents', fd)).data;
}
const ids = (list) => list.map((d) => d.id);
const pdfInfo = async (buf) => {
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= d.numPages; i++) text += (await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + ' ';
  return { permissions: await d.getPermissions(), text, pages: d.numPages };
};

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  await signIn(admin, 'pratik@test.local', 'Strong-pass-2026');
  for (const [name, email] of [['Anil Mehta', 'anil@test.local'], ['Divya Gadhiya', 'divya@test.local'], ['Raj Patel', 'raj@test.local']]) {
    await admin('/api/users', { name, email, role: 'sender', password: 'River-stone-2026' });
  }
  const anil = client(); const divya = client(); const raj = client();
  await signIn(anil, 'anil@test.local', 'River-stone-2026');
  await signIn(divya, 'divya@test.local', 'River-stone-2026');
  await signIn(raj, 'raj@test.local', 'River-stone-2026');

  // Anil prepares a draft for Divya and an outside signer
  const a = await upload(anil, 'Access test');
  await anil(`/api/documents/${a.id}`, { signers: [{ id: 'd', name: 'Divya Gadhiya', email: 'divya@test.local' }, { id: 'o', name: 'Olga Outside', email: 'olga@outside.test' }], signingOrder: 'parallel', requireReason: true,
    fields: [{ id: 'f1', signerId: 'd', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.07 }, { id: 'f2', signerId: 'o', type: 'signature', page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.07 }] }, false, 'PUT');
  ok(!ids((await divya('/api/documents')).data).includes(a.id) && (await divya(`/api/documents/${a.id}`)).status === 404, 'a draft is not visible to its future recipient');
  const sent = (await anil(`/api/documents/${a.id}/send`, {})).data;

  // Divya's own agreement
  const b = await upload(divya, 'Divya private');

  const listOf = async (c) => ids((await c('/api/documents')).data);
  ok((await listOf(admin)).includes(a.id) && (await listOf(admin)).includes(b.id), 'administrator sees every agreement');
  ok((await listOf(anil)).includes(a.id) && !(await listOf(anil)).includes(b.id), 'sender sees the agreements they sent, not other people\'s');
  ok((await listOf(divya)).includes(a.id) && (await listOf(divya)).includes(b.id), 'recipient sees agreements sent to them, plus their own');
  ok((await listOf(raj)).length === 0, 'an unrelated user sees nothing');
  ok((await raj(`/api/documents/${a.id}`)).status === 404 && (await raj(`/api/documents/${a.id}/original`, undefined, true)).status === 404, 'an unrelated user gets "Not found" for the agreement and its PDF');
  ok((await anil(`/api/documents/${b.id}`)).status === 404, 'one sender cannot open another sender\'s agreement');

  const dv = (await divya(`/api/documents/${a.id}`)).data;
  ok(dv.access === 'recipient' && dv.signers.every((s) => !s.link), 'recipient view: access "recipient", no signing links of others');
  ok((await divya(`/api/documents/${a.id}/void`, { reason: 'x' })).status === 403 && (await divya(`/api/documents/${a.id}/remind/o`, {})).status === 403, 'recipient cannot cancel or send reminders');
  ok((await anil(`/api/documents/${a.id}`)).data.signers.some((s) => s.link), 'the sender still sees the signing links');

  // Both sign
  const tD = sent.signers.find((s) => s.email === 'divya@test.local').link.split('t=')[1];
  const tO = sent.signers.find((s) => s.email === 'olga@outside.test').link.split('t=')[1];
  ok((await divya(`/api/sign/${tD}`, { consent: true, values: { f1: PNG }, reason: 'I approve this document', tz: 'UTC', password: 'River-stone-2026' })).status === 200, 'Divya signed');
  const olga = client();
  await olga(`/api/sign/${tO}`);
  await sleep(200);
  const done = await olga(`/api/sign/${tO}`, { consent: true, values: { f2: PNG }, reason: 'I approve this document', tz: 'UTC', password: tempFor('olga@outside.test') });
  ok(done.status === 200 && done.data.completed, 'Olga signed; agreement completed');

  // The signed PDF
  const signed = Buffer.from(await (await divya(`/api/documents/${a.id}/signed`, undefined, true)).arrayBuffer());
  ok(signed.length > 1000, 'recipient can download the completed agreement');
  ok((await raj(`/api/documents/${a.id}/signed`, undefined, true)).status === 404, 'an unrelated user cannot download it');
  const text = signed.toString('latin1');
  ok(/\/Encrypt \d+ 0 R/.test(text) && /\/CFM \/AESV2/.test(text) && !text.includes('Access test body text'), 'signed PDF is encrypted (AES-128); its text is not readable in the file');
  let pdfLibRefused = false;
  try { await PDFDocument.load(signed); } catch (e) { pdfLibRefused = /encrypt/i.test(e.message); }
  ok(pdfLibRefused, 'PDF editing tools refuse to open it for changes');
  const info = await pdfInfo(signed);
  ok(JSON.stringify((info.permissions || []).sort((x, y) => x - y)) === JSON.stringify([4, 2048]), `PDF permissions: print only (got ${JSON.stringify(info.permissions)}); copy, modify, annotate, extract not allowed`);
  ok(info.text.includes('Access test body text') && info.text.includes('Final Audit Report'), 'it opens without a password in a PDF reader and shows every page');
  const vf = new FormData();
  vf.append('file', new Blob([signed]), 'x.pdf');
  const ver = await (await fetch(B + '/api/verify', { method: 'POST', body: vf })).json();
  ok(ver.valid && ver.embedded.certified && ver.embedded.signatures.length === 3 && ver.embedded.signatures.every((s) => s.valid && s.intact && s.trusted) && !ver.embedded.modifiedAfterLastSignature,
    `all ${ver.embedded?.signatures?.length} digital signatures (company seal + 2 signers) are valid, unchanged and trusted`);

  // Print copy
  const pr = await divya(`/api/documents/${a.id}/print.pdf?tz=UTC`, undefined, true);
  const printBuf = Buffer.from(await pr.arrayBuffer());
  const pinfo = await pdfInfo(printBuf);
  ok(pr.status === 200 && pinfo.text.includes('PRINTED COPY') && pinfo.text.includes('Access test body text') && JSON.stringify((pinfo.permissions || []).sort((x, y) => x - y)) === JSON.stringify([4, 2048]), 'print copy works, is stamped, and is copy-protected too');
  const ev = (await admin(`/api/documents/${a.id}`)).data.events.map((e) => e.text).join('\n');
  ok(ev.includes('Document protected: printing allowed'), 'audit trail records the protection');
})().catch((e) => { console.error(e); process.exit(1); });
