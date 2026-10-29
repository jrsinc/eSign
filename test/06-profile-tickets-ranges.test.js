// Test: my profile (title, company, default signature reach the signing page), sign-in help tickets with
// case numbers, and audit trail / system log by time range.
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
const pdfText = async (buf) => {
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let t = '';
  for (let i = 1; i <= d.numPages; i++) t += (await (await d.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ') + ' ';
  return t.replace(/\s+/g, ' ');
};

(async () => {
  const admin = client();
  await admin('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  await signIn(admin, 'pratik@test.local', 'Strong-pass-2026');
  await admin('/api/companies', { name: 'Jupiter Research Services' });
  const d = (await admin('/api/users', { name: 'Divya Gadhiya', email: 'divya@test.local', role: 'sender', password: 'River-stone-2026' })).data;
  const divya = client();
  await signIn(divya, 'divya@test.local', 'River-stone-2026');

  // ---- My profile ----
  const p0 = (await divya('/api/profile')).data;
  ok(p0.id === d.user.id && p0.name === 'Divya Gadhiya' && p0.email === 'divya@test.local' && p0.companies.includes('Jupiter Research Services'), 'profile shows user name, ID, email and the company list');
  ok((await divya('/api/profile', { title: 'QA', company: 'X', signature: 'data:image/png;base64,not-an-image' }, false, 'PUT')).status === 400, 'an unreadable signature is refused');
  ok((await divya('/api/profile', { title: 'QA Manager', company: 'Jupiter Research Services', signature: PNG }, false, 'PUT')).status === 200, 'title, company and default signature saved');
  const p1 = (await divya('/api/profile')).data;
  ok(p1.title === 'QA Manager' && p1.company === 'Jupiter Research Services' && p1.signature === PNG, 'profile keeps them');
  ok((await divya('/api/profile', { title: 'QA Manager', company: 'Jupiter Research Services', signature: PNG, name: 'Hacker', email: 'x@y.z' }, false, 'PUT')).status === 200
    && (await divya('/api/profile')).data.email === 'divya@test.local', 'name and email cannot be changed from the profile');

  // The signing page offers them to Divya
  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText('Profile test', { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await src.save())]), 'Profile test.pdf');
  const doc = (await admin('/api/documents', fd)).data;
  await admin(`/api/documents/${doc.id}`, { signers: [{ id: 's', name: 'Divya Gadhiya', email: 'divya@test.local' }], fields: [{ id: 'f', signerId: 's', type: 'signature', page: 0, x: 0.1, y: 0.3, w: 0.3, h: 0.07 }] }, false, 'PUT');
  const sent = (await admin(`/api/documents/${doc.id}/send`, {})).data;
  const info = (await divya(`/api/sign/${sent.signers[0].link.split('t=')[1]}`)).data;
  ok(info.profile?.title === 'QA Manager' && info.profile?.company === 'Jupiter Research Services' && info.profile?.signature === PNG, 'the signing page offers the profile\'s title, company and default signature');

  // ---- Sign-in help tickets ----
  const anon = client();
  const step1 = await anon('/api/login', { email: 'divya@test.local', password: 'River-stone-2026' });
  const t1 = await anon('/api/support/sign-in-help', { kind: 'code', challenge: step1.data.challenge, message: 'Code never arrives' });
  const year = new Date().getFullYear();
  ok(t1.status === 200 && t1.data.caseNo === `CASE-${year}-00001` && t1.data.status === 'open', `"code not received" opens a case with a case number (${t1.data?.caseNo})`);
  ok((await anon('/api/support/sign-in-help', { kind: 'code', challenge: step1.data.challenge })).data.caseNo === t1.data.caseNo, 'asking again returns the same open case, no duplicate');
  const t2 = await client()('/api/support/sign-in-help', { kind: 'password', email: 'DIVYA@test.local' });
  ok(t2.data.caseNo === `CASE-${year}-00002`, 'forgot password / locked out opens its own case');
  ok((await client()('/api/support/sign-in-help', { kind: 'password', email: '' })).status === 400, 'without a challenge or an email, no ticket is made');
  await sleep(250);
  ok(mails('pratik@test.local').some((m) => m.includes(`Support ticket ${t1.data.caseNo}`) && m.includes('Code never arrives')), 'administrators are emailed the case with the person\'s message');
  ok((await divya('/api/tickets')).status === 403, 'only administrators see tickets');
  const list = (await admin('/api/tickets')).data;
  const tk = list.find((t) => t.caseNo === t1.data.caseNo);
  ok(list.length === 2 && tk.email === 'divya@test.local' && tk.account?.status === 'active' && tk.kindLabel === 'Sign-in code not received', 'administrator sees both tickets with the account state');
  ok((await admin(`/api/tickets/${tk.id}/resolve`, { note: '' })).status === 400, 'resolving needs a note');
  ok((await admin(`/api/tickets/${tk.id}/resolve`, { note: 'Email address corrected' })).status === 200, 'administrator resolves the ticket');
  await sleep(250);
  ok(mails('divya@test.local').some((m) => m.includes(`${t1.data.caseNo} is resolved`) && m.includes('Email address corrected')), 'the person is emailed that the case is resolved, with what was done');
  ok((await admin(`/api/tickets/${tk.id}/resolve`, { note: 'again' })).status === 400, 'a resolved ticket cannot be resolved twice');
  const log = JSON.stringify((await admin('/api/system-log')).data.entries);
  ok(log.includes(`Support ticket ${t1.data.caseNo} opened`) && log.includes(`Support ticket ${t1.data.caseNo} resolved`), 'opening and resolving are in the system log');

  // ---- Time ranges ----
  const future = new Date(Date.now() + 864e5).toISOString();
  const past = new Date(Date.now() - 864e5).toISOString();
  const all = (await admin('/api/system-log')).data;
  const none = (await admin(`/api/system-log?from=${future}`)).data;
  const some = (await admin(`/api/system-log?from=${past}&to=${future}`)).data;
  ok(none.matching === 0 && none.entries.length === 0 && some.matching === all.total && none.integrity.ok, 'system log by time range: a future window has no entries, a window around now has all; integrity still checked');
  ok((await admin(`/api/system-log?from=${future}&to=${past}`)).status === 400 && (await admin('/api/system-log?from=not-a-date')).status === 400, 'a start after the end, or a bad time, is refused');
  const evCount = (await admin(`/api/documents/${doc.id}`)).data.events.length;
  const r1 = await admin(`/api/documents/${doc.id}/audit.pdf?from=${future}`, undefined, true);
  const t = await pdfText(Buffer.from(await r1.arrayBuffer()));
  ok(r1.status === 200 && t.includes(`(0 of ${evCount})`) && t.includes('Audit trail integrity: verified'), 'audit trail PDF for a period says which period and how many events, and still checks integrity');
  // The first download added an event of its own, so count again.
  const evNow = (await admin(`/api/documents/${doc.id}`)).data.events.length;
  const r2 = await admin(`/api/documents/${doc.id}/audit.pdf?from=${past}&to=${future}`, undefined, true);
  const t2pdf = await pdfText(Buffer.from(await r2.arrayBuffer()));
  ok(evNow === evCount + 1 && t2pdf.includes(`(${evNow} of ${evNow})`) && t2pdf.includes('Document created'), 'a period around now includes every event');
  const sysPdf = await pdfText(Buffer.from(await (await admin(`/api/system-log.pdf?from=${past}&to=${future}`, undefined, true)).arrayBuffer()));
  ok(sysPdf.includes('Entries from') && sysPdf.includes('System Audit Log'), 'system log PDF for a period');
  ok((await admin(`/api/documents/${doc.id}`)).data.events.some((e) => e.text.includes('Audit trail downloaded as PDF') && e.text.includes('events from')), 'the agreement\'s audit trail records the download and its period');
})().catch((e) => { console.error(e); process.exit(1); });
