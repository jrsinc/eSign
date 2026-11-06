// env: LOGIN_CODE=off
// Test: an agreement completes even with small "digital ID" signature boxes (JRS-2026-00002 stayed
// "out for signature" because of them), and the completion retry is for administrators only.
const fs = require('fs');
const path = require('path');
const root = process.argv[3];
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const B = process.env.B;
const LOG = process.argv[2];
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempFor = (to) => [...fs.readFileSync(LOG, 'utf8').matchAll(new RegExp(`To: ${to.replace('.', '\\.')}[\\s\\S]*?Temporary password: (\\S+)`, 'g'))].pop()?.[1];
function client() {
  let cookie = '';
  return async (p, body, method) => {
    const r = await fetch(B + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  await admin('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026' });
  await admin('/api/users', { name: 'Sara Sender', email: 'sara@test.local', role: 'sender', password: 'River-stone-2026' });
  const sara = client();
  await sara('/api/login', { email: 'sara@test.local', password: 'River-stone-2026' });

  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText('Please sign this Sample', { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), 'Please sign this Sample.pdf');
  const doc = (await sara('/api/documents', fd)).data;
  // Digital-ID boxes from tiny to normal: 8, 16, 20 and 55 points tall.
  const heights = [0.01, 0.02, 0.025, 0.07];
  const signers = heights.map((_, i) => ({ id: `s${i}`, name: `Signer ${i + 1} with a longer name`, email: `p${i}@outside.test` }));
  await sara(`/api/documents/${doc.id}`, { signers, signingOrder: 'parallel',
    fields: heights.map((h, i) => ({ id: `f${i}`, signerId: `s${i}`, type: 'signature', appearance: 'digital', page: 0, x: 0.1, y: 0.15 + i * 0.15, w: 0.4, h })) }, 'PUT');
  const sent = (await sara(`/api/documents/${doc.id}/send`, {})).data;
  let last;
  for (const [i, s] of sent.signers.entries()) {
    const t = s.link.split('t=')[1];
    await fetch(`${B}/api/sign/${t}`);
    await sleep(200);
    last = await client()(`/api/sign/${t}`, { consent: true, values: { [`f${i}`]: PNG }, reason: 'I approve this document', tz: 'UTC', password: tempFor(`p${i}@outside.test`) });
  }
  ok(last.status === 200 && last.data.completed === true, 'the last signature completes the agreement, even with small digital-ID boxes');
  const done = (await admin(`/api/documents/${doc.id}`)).data;
  ok(done.status === 'completed' && done.finalFile && done.locked && !done.events.some((e) => /could not/.test(e.text)), 'signed, certified PDF made with digital signatures; no failure in the audit trail');
  ok((await admin(`/api/documents/${doc.id}/complete`, {})).status === 400, 'retry is refused for an agreement that isn\'t waiting to be completed');
  ok((await sara(`/api/documents/${doc.id}/complete`, {})).status === 403, 'only administrators can retry completion');

  // ---- Every signature and initials shows its date and time, in any box size, for every signer ----
  const { captionStamp } = require(path.join(root, 'lib', 'dates'));
  const pdfjs = require(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from(await src.save())]), 'Time stamps.pdf');
  const doc2 = (await sara('/api/documents', fd2)).data;
  const box = (id, s, type, x, y, w, h) => ({ id, signerId: s, type, page: 0, x, y, w, h });
  await sara(`/api/documents/${doc2.id}`, { signingOrder: 'parallel',
    signers: [{ id: 'a', name: 'Sara Sender', email: 'sara@test.local' }, { id: 'o', name: 'Olga Outside', email: 'olga@outside.test' }],
    fields: ['a', 'o'].flatMap((s, k) => [box(`${s}1`, s, 'signature', 0.08, 0.15 + k * 0.3, 0.22, 0.03), box(`${s}2`, s, 'initials', 0.4, 0.15 + k * 0.3, 0.1, 0.035), box(`${s}3`, s, 'signature', 0.55, 0.12 + k * 0.3, 0.35, 0.08)]) }, 'PUT');
  const sent2 = (await sara(`/api/documents/${doc2.id}/send`, {})).data;
  const ta = sent2.signers[0].link.split('t=')[1];
  await sara(`/api/sign/${ta}`);
  ok((await sara(`/api/sign/${ta}`, { consent: true, values: { a1: PNG, a2: PNG, a3: PNG }, reason: 'I approve this document', tz: 'America/New_York', password: 'River-stone-2026' })).status === 200, 'account holder signs small and normal boxes');
  const to = sent2.signers[1].link.split('t=')[1];
  const olga = client();
  await olga(`/api/sign/${to}`);
  await sleep(200);
  ok((await olga(`/api/sign/${to}`, { consent: true, values: { o1: PNG, o2: PNG, o3: PNG }, reason: 'I have reviewed this document', tz: 'Asia/Kolkata', password: tempFor('olga@outside.test') })).data?.completed === true, 'outside signer signs; agreement completed');
  // Read the signed PDF's first page (where the boxes are) as text.
  const login = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pratik@test.local', password: 'Strong-pass-2026' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const pdf = Buffer.from(await (await fetch(`${B}/api/documents/${doc2.id}/signed`, { headers: { cookie } })).arrayBuffer());
  const page1 = await (await (await pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise).getPage(1)).getTextContent();
  const text = page1.items.map((x) => x.str).join('\n');
  const signed = (await admin(`/api/documents/${doc2.id}`)).data.signers;
  for (const s of signed) {
    const stamp = captionStamp(new Date(s.signedAt), s.tz);
    const count = text.split(stamp).length - 1;
    ok(count === 3, `${s.name}: date and time on all 3 boxes, including the small signature and the initials (${stamp}, found ${count})`);
  }

  // ---- Signed stamp (shield) and framed styles: name, reason, time and signature ID, for an outside signer too ----
  const fd3 = new FormData();
  fd3.append('file', new Blob([Buffer.from(await src.save())]), 'Styles.pdf');
  const doc3 = (await sara('/api/documents', fd3)).data;
  await sara(`/api/documents/${doc3.id}`, { signingOrder: 'parallel',
    signers: [{ id: 'o', name: 'Omar Outside', email: 'omar@outside.test' }],
    fields: [{ ...box('o1', 'o', 'signature', 0.05, 0.1, 0.42, 0.075), appearance: 'shield' }, { ...box('o2', 'o', 'signature', 0.5, 0.3, 0.45, 0.15), appearance: 'framed' }] }, 'PUT');
  const saved = (await admin(`/api/documents/${doc3.id}`)).data.fields.map((f) => f.appearance).join(',');
  ok(saved === 'shield,framed', `signature styles are kept on the fields (${saved})`);
  const t3 = (await sara(`/api/documents/${doc3.id}/send`, {})).data.signers[0].link.split('t=')[1];
  const omar = client();
  await omar(`/api/sign/${t3}`);
  await sleep(200);
  ok((await omar(`/api/sign/${t3}`, { consent: true, values: { o1: PNG, o2: PNG }, reason: 'I have reviewed this document', tz: 'Asia/Kolkata', password: tempFor('omar@outside.test') })).data?.completed === true, 'outside signer signs both styles');
  const d3 = (await admin(`/api/documents/${doc3.id}`)).data;
  const serial = d3.events.map((e) => (e.detail || '').match(/Certificate serial: (\w+) - Subject: cn=Omar/)?.[1]).find(Boolean)?.toUpperCase();
  const pdf3 = Buffer.from(await (await fetch(`${B}/api/documents/${doc3.id}/signed`, { headers: { cookie } })).arrayBuffer());
  const text3 = (await (await (await pdfjs.getDocument({ data: new Uint8Array(pdf3), verbosity: 0 }).promise).getPage(1)).getTextContent()).items.map((x) => x.str).join('\n');
  const stamp3 = captionStamp(new Date(d3.signers[0].signedAt), 'Asia/Kolkata');
  ok(text3.includes('Signed by Omar Outside') && text3.includes('Digitally signed via Method 365 by:'), 'both stamps carry their heading');
  ok(text3.split(stamp3).length - 1 === 2 && text3.split('I have reviewed this document').length - 1 === 2, `both stamps show the reason and the time (${stamp3})`);
  ok(!!serial && text3.split(serial).length - 1 === 2, `both stamps show the signature ID, the signer's certificate serial (${serial})`);
  ok(text3.includes('omar@outside.test'), 'framed stamp shows the email');
})().catch((e) => { console.error(e); process.exitCode = 1; });
