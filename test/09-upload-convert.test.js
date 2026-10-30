// env: LOGIN_CODE=off
// Test: agreements from Word documents and images as well as PDFs, mixed in one upload.
// The Word part runs only where LibreOffice is installed (it is skipped, and says so, elsewhere).
const path = require('path');
const root = process.argv[3];
const { PDFDocument, StandardFonts } = require(path.join(root, 'node_modules', 'pdf-lib'));
const sharp = require(path.join(root, 'node_modules', 'sharp'));
const { soffice } = require(path.join(root, 'lib', 'convert'));
const B = process.env.B;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };
let cookie = '';
async function api(p, body, raw) {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (raw) return r;
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const form = (files) => {
  const fd = new FormData();
  for (const [name, bytes] of files) fd.append('file', new Blob([bytes]), name);
  return fd;
};
const pageSizes = async (docId) => {
  const pdf = await PDFDocument.load(Buffer.from(await (await api(`/api/documents/${docId}/original`, undefined, true)).arrayBuffer()));
  return pdf.getPages().map((p) => { const { width, height } = p.getSize(); return [Math.round(width), Math.round(height)]; });
};
// A 24-bit BMP, as Windows Paint saves it.
function bmp(w, h) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + stride * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
  for (let i = 54; i < buf.length; i += 3) buf[i] = 200;
  return buf;
}

(async () => {
  await api('/api/auth/setup', { adminPassword: 'admin', name: 'Pratik Shah', email: 'pratik@test.local', password: 'Strong-pass-2026' });
  ok((await api('/api/login', { email: 'pratik@test.local', password: 'Strong-pass-2026' })).status === 200, 'signed in');

  const src = await PDFDocument.create();
  src.addPage([612, 792]).drawText('Contract', { x: 50, y: 740, size: 18, font: await src.embedFont(StandardFonts.Helvetica) });
  const pdfBytes = Buffer.from(await src.save());
  const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
  const portraitPng = await sharp({ create: { width: 600, height: 900, channels: 4, background: { r: 0, g: 160, b: 80, alpha: 0.5 } } }).png().toBuffer();
  const tiff2 = await sharp([
    await sharp({ create: { width: 500, height: 700, channels: 3, background: '#ffffff' } }).png().toBuffer(),
    await sharp({ create: { width: 500, height: 700, channels: 3, background: '#eeeeee' } }).png().toBuffer(),
  ], { join: { animated: true } }).tiff().toBuffer().catch(() => null);
  // Camera photos store "rotate 90°" in EXIF; the page must come out upright (portrait).
  const sideways = await sharp({ create: { width: 1000, height: 600, channels: 3, background: '#999999' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();

  // ---- One image ----
  const one = await api('/api/documents', form([['Site photo.jpg', photo]]));
  ok(one.status === 200 && one.data.title === 'Site photo', 'a JPG becomes an agreement; the title drops the extension');
  ok(JSON.stringify(await pageSizes(one.data.id)) === JSON.stringify([[842, 595]]), 'a landscape photo becomes one landscape A4 page');
  const ev = (await api(`/api/documents/${one.data.id}`)).data.events.map((e) => `${e.text} | ${e.detail || ''}`).join('\n');
  ok(/Converted to PDF: Site photo\.jpg \(image\) \| SHA-256 of the uploaded file: [0-9a-f]{64}/.test(ev), 'the audit trail records the conversion and the uploaded file\'s fingerprint');
  const up = await api('/api/documents', form([['IMG_0001.jpg', sideways]]));
  ok(JSON.stringify(await pageSizes(up.data.id)) === JSON.stringify([[595, 842]]), 'a phone photo taken sideways comes out upright');

  // ---- Mixed: PDF + images + BMP (+ multi-page TIFF) in one upload ----
  const files = [['Contract.pdf', pdfBytes], ['Photo.jpg', photo], ['Signature page.png', portraitPng], ['Scan.bmp', bmp(300, 400)]];
  if (tiff2) files.push(['Scan.tiff', tiff2]);
  const mixed = await api('/api/documents', form(files));
  const sizes = await pageSizes(mixed.data.id);
  ok(mixed.status === 200 && sizes.length === 4 + (tiff2 ? 2 : 0), `mixed upload merges into one agreement in the order given (${sizes.length} pages)`);
  ok(JSON.stringify(sizes.slice(0, 4)) === JSON.stringify([[612, 792], [842, 595], [595, 842], [595, 842]]), 'the PDF keeps its own page size; images become A4 pages');
  const mev = (await api(`/api/documents/${mixed.data.id}`)).data.events.map((e) => e.text);
  ok(mev.filter((t) => t.startsWith('Converted to PDF')).length === files.length - 1 && mev.some((t) => t.startsWith(`${files.length} files merged`)), 'each converted file and the merge are in the audit trail');

  // ---- Adding files on the page organizer ----
  const added = await api(`/api/documents/${one.data.id}/sources`, form([['Extra.png', portraitPng]]));
  ok(added.status === 200 && added.data[0].pages === 1 && added.data[0].name === 'Extra.png', 'images can be added to a draft on the page organizer');

  // ---- Refused files ----
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic'), Buffer.alloc(64)]);
  const h = await api('/api/documents', form([['IMG_0002.HEIC', heic]]));
  ok(h.status === 400 && /iPhone HEIC/.test(h.data.error), 'an iPhone HEIC photo is refused with how to send it as JPG');
  const exe = await api('/api/documents', form([['setup.exe', Buffer.from('MZ\x90\0this is a program')]]));
  ok(exe.status === 400 && /not a supported file/.test(exe.data.error), 'other files (e.g. programs) are refused');
  const fake = await api('/api/documents', form([['photo.jpg', Buffer.from('not really an image')]]));
  ok(fake.status === 400, 'a file whose content doesn\'t match its name is refused');
  const broken = await api('/api/documents', form([['broken.png', Buffer.from('\x89PNG\r\n\x1a\nbroken', 'latin1')]]));
  ok(broken.status === 400 && /could not be read as an image/.test(broken.data.error), 'a damaged image gives a clear message');

  // ---- Word ----
  if (!soffice()) {
    console.log('SKIP  Word conversion: LibreOffice is not installed here');
    return;
  }
  const rtf = Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0\\fs28 Service agreement\\par Signed by both parties.\\par}');
  const word = await api('/api/documents', form([['Service agreement.rtf', rtf], ['Contract.pdf', pdfBytes]]));
  ok(word.status === 200 && word.data.title === 'Service agreement', 'a Word (RTF) file becomes an agreement');
  const wsizes = await pageSizes(word.data.id);
  ok(wsizes.length === 2 && wsizes[1][0] === 612, 'Word pages and a PDF merge into one agreement');
  const wev = (await api(`/api/documents/${word.data.id}`)).data.events.map((e) => e.text);
  ok(wev.includes('Converted to PDF: Service agreement.rtf (office document)'), 'the Word conversion is in the audit trail');
})().catch((e) => { console.error(e); process.exitCode = 1; });
