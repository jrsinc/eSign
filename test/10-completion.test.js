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
})().catch((e) => { console.error(e); process.exitCode = 1; });
