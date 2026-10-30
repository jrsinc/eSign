// Builds the completed PDF: stamps every field value onto the original pages and
// appends an Adobe-style "Final Audit Report".
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const { captionStamp, auditStamp, digitalStamp } = require('./dates');
const { distinguishedName } = require('./pki');
const { APP_NAME } = require('./brand');
const { encryptDocument } = require('./pdfcrypt');
const { prepareCertifiedSignatures, appendSignatureRevision, signRevision } = require('./pdfsign');

// Standard PDF fonts only cover WinAnsi; replace anything else so drawing never throws.
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
const BLUE = rgb(0.13, 0.4, 0.8);
const INK = rgb(0.1, 0.1, 0.1);
const GRAY = rgb(0.35, 0.35, 0.35);

function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return INK;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function wrap(font, text, size, maxWidth) {
  const lines = [];
  let line = '';
  for (const w of safe(text).split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Maps "display" coordinates (points from the top-left of the page as a viewer shows it,
// rotation applied) to PDF user space, so stamps land correctly on rotated pages too.
function pageFrame(page) {
  const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: bx, y: by, width: W, height: H } = box;
  const turned = r === 90 || r === 270;
  const map = (u, v) => {
    if (r === 90) return { x: bx + v, y: by + u };
    if (r === 180) return { x: bx + W - u, y: by + v };
    if (r === 270) return { x: bx + W - v, y: by + H - u };
    return { x: bx + u, y: by + H - v };
  };
  return { width: turned ? H : W, height: turned ? W : H, rotate: degrees(r), map };
}

// `certs` maps signer id -> certificate from pki.issueSignerCertificate, plus `seal` for the company.
// When given, the PDF is certified and locked, and each signer gets an embedded digital signature.
// `attachments`: files signers attached ({ name, bytes, mime, description }), embedded in the PDF
// before it is certified, so they are covered by the signatures too.
// `protect`: encrypt the result so it opens without a password but can only be printed (no copying
// text, no editing). Returns { bytes, plain }: `plain` is the same document unencrypted and unsigned,
// kept on the server only (print copies are made from it).
async function finalize(doc, originalBytes, company, { certs, attachments = [], protect = false } = {}) {
  const pdf = await PDFDocument.load(originalBytes);
  const logoFile = path.join(__dirname, '..', 'public', 'logo.png');
  const logo = fs.existsSync(logoFile) ? await pdf.embedPng(fs.readFileSync(logoFile)).catch(() => null) : null;
  const fonts = {
    Helvetica: await pdf.embedFont(StandardFonts.Helvetica),
    Times: await pdf.embedFont(StandardFonts.TimesRoman),
    Courier: await pdf.embedFont(StandardFonts.Courier),
  };
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dingbats = await pdf.embedFont(StandardFonts.ZapfDingbats);
  const pages = pdf.getPages();
  const signers = Object.fromEntries(doc.signers.map((s) => [s.id, s]));
  const pngCache = new Map();
  const png = async (dataUrl) => {
    if (!pngCache.has(dataUrl)) pngCache.set(dataUrl, await pdf.embedPng(Buffer.from(dataUrl.split(',')[1], 'base64')));
    return pngCache.get(dataUrl);
  };

  for (const f of doc.fields) {
    if (f.value == null || f.value === '' || f.value === 'false') continue;
    const page = pages[f.page];
    if (!page) continue;
    const fr = pageFrame(page);
    const u = f.x * fr.width;
    const v = f.y * fr.height;
    const w = f.w * fr.width;
    const h = f.h * fr.height;
    const st = f.style || {};

    if (f.type === 'signature' && f.appearance === 'digital') {
      drawDigitalStamp(page, fr, { u, v, w, h }, signers[f.signerId], company, { font: fonts.Helvetica, logo });
    } else if (f.type === 'signature' || f.type === 'initials' || f.type === 'stamp') {
      const signer = signers[f.signerId];
      const captions = f.type === 'signature' && h >= 22 ? signatureCaptions(signer) : [];
      drawSignature(page, fr, await png(f.value), { u, v, w, h }, captions, fonts.Helvetica);
    } else if (f.type === 'checkbox' || f.type === 'radio') {
      const glyph = f.type === 'checkbox' ? '✔' : '●';
      const size = Math.min(w, h) * 0.8;
      const gw = dingbats.widthOfTextAtSize(glyph, size);
      const p = fr.map(u + (w - gw) / 2, v + h / 2 + size * 0.35);
      page.drawText(glyph, { x: p.x, y: p.y, size, font: dingbats, color: hexColor(st.color), rotate: fr.rotate });
    } else {
      const font = fonts[st.font] || fonts.Helvetica;
      const text = safe(f.type === 'attachment' ? `Attached: ${f.value}` : f.value);
      let size = Number(st.size) || Math.min(h * 0.7, 14);
      while (size > 5 && font.widthOfTextAtSize(text, size) > w - 2) size -= 0.5;
      const tw = font.widthOfTextAtSize(text, size);
      const left = st.align === 'center' ? u + (w - tw) / 2 : st.align === 'right' ? u + w - tw - 1 : u + 1;
      const p = fr.map(left, v + h / 2 + size * 0.35);
      page.drawText(text, { x: p.x, y: p.y, size, font, color: hexColor(st.color), rotate: fr.rotate });
    }
  }

  pages.forEach((page) => {
    const fr = pageFrame(page);
    const p = fr.map(14, fr.height - 6);
    page.drawText(`${doc.agreementId ? `Agreement ID: ${doc.agreementId}  |  ` : ''}Transaction ID: ${doc.transactionId || doc.id}`, { x: p.x, y: p.y, size: 5.5, font: fonts.Helvetica, color: GRAY, rotate: fr.rotate });
  });

  if (doc.stampPage !== false) await appendStampPage(pdf, doc, { font: fonts.Helvetica, bold, png });
  await appendAuditReport(pdf, doc, company, { font: fonts.Helvetica, bold });

  for (const a of attachments) {
    await pdf.attach(a.bytes, a.name, { mimeType: a.mime, description: a.description, creationDate: new Date(a.at), modificationDate: new Date(a.at) });
  }
  pdf.setTitle(doc.title);
  pdf.setProducer(APP_NAME);
  pdf.setModificationDate(new Date());
  // With certificates: certify and lock the document (company seal, "no changes except signing"),
  // then add each signer's signature in signing order as its own incremental update.
  const signed = certs ? doc.signers.filter((x) => certs[x.id]).sort((a, b) => a.order - b.order) : [];
  const layout = certs ? prepareCertifiedSignatures(pdf, { company, sealName: certs.seal.name, sealEmail: certs.seal.email, signers: signed }) : null;
  // Classic cross-reference tables are needed for the incremental updates that hold the signatures.
  const saveOptions = { useObjectStreams: false, updateFieldAppearances: false };
  const plain = protect ? Buffer.from(await pdf.save(saveOptions)) : null;
  const crypt = protect ? encryptDocument(pdf) : null;
  let bytes = Buffer.from(await pdf.save(saveOptions));
  if (certs) {
    bytes = await signRevision(bytes, certs.seal, new Date());
    let nextObj = pdf.context.largestObjectNumber + 1;
    for (const s of signed) {
      bytes = appendSignatureRevision(bytes, layout, layout.signerFields[s.id], {
        reason: s.reason || 'I am signing this document', name: s.name, location: company, contact: s.email, date: new Date(s.signedAt),
      }, nextObj++, crypt);
      bytes = await signRevision(bytes, certs[s.id], new Date(s.signedAt));
    }
  }
  return { bytes, plain: plain || bytes };
}

// Adobe-style digital ID stamp: the name large on the left, signing details on the right,
// with the company logo faded behind.
function drawDigitalStamp(page, fr, { u, v, w, h }, signer, company, { font, logo }) {
  if (!signer?.signedAt) return;
  if (logo) {
    const s = Math.min((w * 0.5) / logo.width, (h * 0.9) / logo.height);
    const lw = logo.width * s;
    const lh = logo.height * s;
    const p = fr.map(u + (w - lw) / 2, v + (h + lh) / 2);
    page.drawImage(logo, { x: p.x, y: p.y, width: lw, height: lh, opacity: 0.12, rotate: fr.rotate });
  }
  const leftW = w * 0.46;
  const words = safe(signer.name).split(/\s+/);
  // Largest size that fits, measured at least once, so even a small box gets text (never nothing).
  const nameFits = (ls, s) => ls.length * s * 1.05 <= h - 2 && ls.every((l) => font.widthOfTextAtSize(l, s) <= leftW - 2);
  let size = Math.max(Math.min(h * 0.42, 28), 4);
  let lines = wrap(font, words.join(' '), size, leftW - 2);
  while (size > 4 && !nameFits(lines, size)) {
    size = Math.max(4, size - 0.5);
    lines = wrap(font, words.join(' '), size, leftW - 2);
  }
  const top = v + (h - lines.length * size * 1.05) / 2;
  lines.forEach((l, i) => {
    const p = fr.map(u + 1, top + (i + 1) * size * 1.05 - size * 0.2);
    page.drawText(l, { x: p.x, y: p.y, size, font, color: INK, rotate: fr.rotate });
  });

  const details = [
    `Digitally signed by ${signer.name}`,
    `DN: ${distinguishedName(signer)}`,
    signer.reason ? `Reason: ${signer.reason}` : '',
    `Date: ${digitalStamp(new Date(signer.signedAt), signer.tz)}`,
    `${company} via ${APP_NAME}`,
  ].filter(Boolean);
  const rightX = u + w * 0.5;
  const rightW = w * 0.5 - 1;
  let ds = Math.max(Math.min(8, h * 0.12), 3);
  let out = details.flatMap((d) => wrap(font, d, ds, rightW));
  while (ds > 3 && out.length * ds * 1.18 > h - 1) {
    ds = Math.max(3, ds - 0.25);
    out = details.flatMap((d) => wrap(font, d, ds, rightW));
  }
  // In a very small box, keep the lines that fit (name and "Digitally signed by" come first).
  out = out.slice(0, Math.max(1, Math.floor((h - 1) / (ds * 1.18))));
  out.forEach((l, i) => {
    const p = fr.map(rightX, v + 1 + (i + 1) * ds * 1.18 - ds * 0.18);
    page.drawText(l, { x: p.x, y: p.y, size: ds, font, color: INK, rotate: fr.rotate });
  });
}

// Adobe-style caption lines: "Name (Oct 23, 2026 16:10:01 EDT)" and the signer's reason.
function signatureCaptions(signer) {
  if (!signer?.signedAt) return [];
  return [`${signer.name} (${captionStamp(new Date(signer.signedAt), signer.tz)})`, signer.reason ? `Reason: ${signer.reason}` : ''].filter(Boolean);
}

// Draws a signature resting on a blue line, with caption lines below it, all inside the box.
function drawSignature(page, fr, img, { u, v, w, h }, captionLines, font) {
  const lines = captionLines.map(safe);
  let capSize = lines.length ? Math.min(7, h * 0.16) : 0;
  if (capSize < 4) lines.length = capSize = 0;
  const capH = lines.length ? lines.length * (capSize + 1.5) + 2 : 0;
  const imgH = h - capH;
  const scale = Math.min(w / img.width, imgH / img.height);
  const p = fr.map(u, v + imgH);
  page.drawImage(img, { x: p.x, y: p.y, width: img.width * scale, height: img.height * scale, rotate: fr.rotate });
  if (!lines.length) return;
  const sizes = lines.map((l) => Math.min(capSize, (capSize * w) / Math.max(1, font.widthOfTextAtSize(l, capSize))));
  const widest = Math.max(...lines.map((l, i) => font.widthOfTextAtSize(l, sizes[i])));
  const lineY = v + imgH + 0.5;
  page.drawLine({ start: fr.map(u, lineY), end: fr.map(u + Math.min(w, widest + 2), lineY), thickness: 0.6, color: BLUE });
  lines.forEach((l, i) => {
    const t = fr.map(u, lineY + (i + 1) * (capSize + 1.5));
    page.drawText(l, { x: t.x, y: t.y, size: sizes[i], font, color: BLUE, rotate: fr.rotate });
  });
}

// ---------------- Signature stamp page ----------------
// One block per signer, in signing order: Signature, Email, Title, Company.
async function appendStampPage(pdf, doc, { font, bold, png }) {
  const W = 612, H = 792, M = 60;
  const signed = [...doc.signers].filter((s) => s.status === 'signed').sort((a, b) => a.order - b.order);
  if (!signed.length) return;
  let page, y;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    page.drawText('Signature Page', { x: M, y: H - 70, size: 18, font: bold, color: INK });
    page.drawText(safe(`${doc.agreementId ? `Agreement ID: ${doc.agreementId}  -  ` : ''}${doc.title}`), { x: M, y: H - 88, size: 9, font, color: GRAY });
    page.drawLine({ start: { x: M, y: H - 98 }, end: { x: W - M, y: H - 98 }, thickness: 0.8, color: BLUE });
    page.drawText(`${doc.agreementId ? `Agreement ID: ${doc.agreementId}  |  ` : ''}Transaction ID: ${doc.transactionId || doc.id}`, { x: 14, y: 8, size: 5.5, font, color: GRAY });
    y = H - 130;
  };
  newPage();
  const fr = { map: (u, v) => ({ x: u, y: H - v }), rotate: degrees(0) };
  const labelX = M + 70;
  const valueX = M + 80;
  for (const s of signed) {
    const rows = [['Email:', s.email], ['Title:', s.title], ['Company:', s.company]].filter(([, val]) => val);
    const blockH = 70 + rows.length * 18 + 26;
    if (y - blockH < 60) newPage();
    const label = (text, yy) => page.drawText(text, { x: labelX - bold.widthOfTextAtSize(text, 11), y: yy, size: 11, font: bold, color: INK });
    label('Signature:', y - 38);
    const sig = doc.fields.find((f) => f.signerId === s.id && f.type === 'signature' && f.value);
    if (sig) drawSignature(page, fr, await png(sig.value), { u: valueX, v: H - y, w: 240, h: 62 }, signatureCaptions(s), font);
    let ry = y - 82;
    for (const [k, val] of rows) {
      label(k, ry);
      page.drawText(safe(val), { x: valueX, y: ry, size: 11, font, color: INK });
      ry -= 18;
    }
    y = ry - 14;
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.4, color: rgb(0.85, 0.85, 0.85) });
    y -= 12;
  }
}

// ---------------- Final Audit Report ----------------
function drawIcon(page, type, x, y) {
  const red = rgb(0.86, 0.2, 0.15);
  const green = rgb(0.18, 0.62, 0.35);
  const blue = rgb(0.2, 0.45, 0.8);
  const c = { x: x + 5, y: y + 3.5 };
  if (type === 'created' || type === 'viewed' || type === 'email_viewed' || type === 'pages') {
    page.drawRectangle({ x: x + 1.5, y: y - 1, width: 7, height: 9, borderColor: red, borderWidth: 1 });
    page.drawLine({ start: { x: x + 3, y: y + 5 }, end: { x: x + 7, y: y + 5 }, thickness: 0.7, color: red });
    page.drawLine({ start: { x: x + 3, y: y + 2.5 }, end: { x: x + 7, y: y + 2.5 }, thickness: 0.7, color: red });
  } else if (type === 'emailed' || type === 'reminder') {
    page.drawRectangle({ x, y: y - 0.5, width: 10, height: 7.5, borderColor: blue, borderWidth: 1 });
    page.drawLine({ start: { x, y: y + 7 }, end: { x: x + 5, y: y + 3 }, thickness: 0.8, color: blue });
    page.drawLine({ start: { x: x + 10, y: y + 7 }, end: { x: x + 5, y: y + 3 }, thickness: 0.8, color: blue });
  } else if (type === 'signed') {
    page.drawLine({ start: { x: x + 1, y: y - 1 }, end: { x: x + 9, y: y + 8 }, thickness: 2, color: green });
    page.drawLine({ start: { x: x + 1, y: y - 1.5 }, end: { x: x + 4, y: y - 1.5 }, thickness: 0.8, color: green });
  } else if (type === 'completed') {
    page.drawCircle({ ...c, size: 5, color: green });
    page.drawLine({ start: { x: c.x - 2.5, y: c.y }, end: { x: c.x - 0.5, y: c.y - 2 }, thickness: 1.2, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: c.x - 0.5, y: c.y - 2 }, end: { x: c.x + 2.8, y: c.y + 2.2 }, thickness: 1.2, color: rgb(1, 1, 1) });
  } else if (type === 'declined' || type === 'voided' || type === 'failed') {
    page.drawCircle({ ...c, size: 5, color: red });
    page.drawLine({ start: { x: c.x - 2, y: c.y - 2 }, end: { x: c.x + 2, y: c.y + 2 }, thickness: 1.2, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: c.x - 2, y: c.y + 2 }, end: { x: c.x + 2, y: c.y - 2 }, thickness: 1.2, color: rgb(1, 1, 1) });
  } else {
    page.drawCircle({ ...c, size: 3, color: GRAY });
  }
}

async function appendAuditReport(pdf, doc, company, { font, bold }) {
  const W = 612, H = 792, M = 60;
  let logo = null;
  const logoFile = path.join(__dirname, '..', 'public', 'logo.png');
  if (fs.existsSync(logoFile)) logo = await pdf.embedPng(fs.readFileSync(logoFile)).catch(() => null);

  let page, y;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    page.drawRectangle({ x: 14, y: 14, width: W - 28, height: H - 28, borderColor: BLUE, borderWidth: 2.5 });
    if (logo) {
      const s = Math.min(110 / logo.width, 30 / logo.height);
      page.drawImage(logo, { x: M - 20, y: 34, width: logo.width * s, height: logo.height * s });
    } else {
      page.drawText(safe(company), { x: M - 20, y: 42, size: 11, font: bold, color: BLUE });
    }
    page.drawText(`Powered by ${safe(APP_NAME)}`, { x: W - M - 120, y: 42, size: 7, font, color: GRAY });
    y = H - 60;
  };
  const ensure = (needed) => {
    if (y - needed < 80) newPage();
  };

  newPage();
  for (const line of wrap(font, doc.title, 24, W - 2 * M)) {
    page.drawText(line, { x: M - 20, y, size: 24, font, color: BLUE });
    y -= 27;
  }
  page.drawText('Final Audit Report', { x: M - 20, y: y + 6, size: 9, font, color: INK });
  page.drawText((doc.completedAt || new Date().toISOString()).slice(0, 10), { x: W - M - 70, y: y + 6, size: 9, font, color: INK });
  y -= 12;

  const status = { completed: 'Signed', declined: 'Declined', voided: 'Cancelled', draft: 'Draft (not sent)' }[doc.status] || 'Out for signature';
  const rows = [
    ...(doc.agreementId ? [['Agreement ID:', doc.agreementId]] : []),
    ['Created:', (doc.createdAt || '').slice(0, 10)],
    ['By:', `${doc.senderName || company}${doc.senderEmail ? ` (${doc.senderEmail})` : ''}`],
    ['Status:', status],
    ['Transaction ID:', doc.transactionId || doc.id],
    ['Original SHA-256:', doc.originalHash],
  ];
  const boxH = rows.length * 20 + 8;
  page.drawRectangle({ x: M - 18, y: y - boxH, width: W - 2 * M + 36, height: boxH, color: rgb(0.94, 0.94, 0.94), borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 0.8 });
  let ry = y - 18;
  for (const [k, val] of rows) {
    page.drawText(k, { x: M - 6, y: ry, size: 7, font, color: INK });
    page.drawText(safe(val), { x: M + 80, y: ry, size: k === 'Original SHA-256:' ? 6.2 : 7, font, color: INK });
    ry -= 20;
  }
  y -= boxH + 40;

  for (const line of wrap(font, `"${doc.title}" History`, 17, W - 2 * M)) {
    page.drawText(line, { x: M - 20, y, size: 17, font, color: INK });
    y -= 22;
  }
  y -= 4;

  const sealed = doc.events.filter((e) => e.hash);
  const chainNote = sealed.length
    ? `Audit trail integrity: ${sealed.length} entries are SHA-256 hash-chained; changing or removing any entry breaks the chain. Final entry hash: ${sealed[sealed.length - 1].hash}`
    : '';
  for (const e of doc.events) {
    const main = wrap(font, e.text, 9.5, W - 2 * M - 10);
    const detailText = e.detail || `${auditStamp(e.at)}${e.ip ? `- IP address: ${e.ip}` : ''}`;
    const detail = wrap(font, detailText, 7, W - 2 * M - 10);
    ensure(main.length * 13 + detail.length * 10 + 16);
    drawIcon(page, e.type, M - 20, y - 1);
    for (const l of main) {
      page.drawText(l, { x: M - 2, y, size: 9.5, font, color: INK });
      y -= 13;
    }
    for (const l of detail) {
      page.drawText(l, { x: M - 2, y: y + 1, size: 7, font, color: INK });
      y -= 10;
    }
    y -= 14;
  }
  if (chainNote) {
    const lines = wrap(font, chainNote, 6.5, W - 2 * M + 10);
    ensure(lines.length * 9 + 6);
    for (const l of lines) {
      page.drawText(l, { x: M - 20, y, size: 6.5, font, color: GRAY });
      y -= 9;
    }
  }
}

module.exports = { finalize, pageFrame, appendAuditReport, safe, wrap };
