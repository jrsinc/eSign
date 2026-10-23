// Builds the completed PDF: stamps every field value onto the original pages,
// adds an envelope-ID footer, and appends an audit certificate.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Standard PDF fonts only cover WinAnsi; replace anything else so drawing never throws.
const safe = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

function fitText(font, text, maxWidth, maxSize) {
  let size = maxSize;
  while (size > 5 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5;
  return size;
}

function wrap(font, text, size, maxWidth) {
  const words = safe(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const fmt = (iso) => (iso ? new Date(iso).toUTCString() : '-');

async function finalize(doc, originalBytes, company) {
  const pdf = await PDFDocument.load(originalBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const f of doc.fields) {
    if (f.value == null || f.value === '') continue;
    const page = pages[f.page];
    if (!page) continue;
    const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    const x = box.x + f.x * box.width;
    const w = f.w * box.width;
    const h = f.h * box.height;
    const y = box.y + box.height - f.y * box.height - h;

    if (f.type === 'signature' || f.type === 'initials') {
      const png = await pdf.embedPng(Buffer.from(f.value.split(',')[1], 'base64'));
      const scale = Math.min(w / png.width, h / png.height);
      const dw = png.width * scale;
      const dh = png.height * scale;
      page.drawImage(png, { x: x + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
    } else if (f.type === 'checkbox') {
      if (f.value === 'true') {
        const s = Math.min(w, h);
        page.drawText('X', { x: x + (w - s * 0.6) / 2, y: y + (h - s * 0.7) / 2, size: s * 0.85, font: bold });
      }
    } else {
      const text = safe(f.value);
      const size = fitText(font, text, w - 2, Math.min(h * 0.7, 14));
      page.drawText(text, { x: x + 1, y: y + (h - size) / 2 + size * 0.2, size, font, color: rgb(0.05, 0.1, 0.3) });
    }
  }

  pages.forEach((page, i) => {
    const box = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    page.drawText(`Envelope ID: ${doc.id}  |  Page ${i + 1} of ${pages.length}`, {
      x: box.x + 18, y: box.y + 8, size: 6.5, font, color: rgb(0.45, 0.45, 0.45),
    });
  });

  // ---- Audit certificate ----
  const W = 612, H = 792, M = 50;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (needed) => {
    if (y - needed < M) {
      page = pdf.addPage([W, H]);
      y = H - M;
    }
  };
  const line = (text, { size = 10, f = font, color = rgb(0.15, 0.15, 0.15), indent = 0 } = {}) => {
    for (const l of wrap(f, text, size, W - 2 * M - indent)) {
      ensure(size + 4);
      page.drawText(l, { x: M + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };
  const rule = () => {
    ensure(12);
    page.drawLine({ start: { x: M, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
    y -= 10;
  };

  line(`${company}`, { size: 11, f: bold, color: rgb(0.15, 0.3, 0.7) });
  line('Certificate of Completion', { size: 20, f: bold });
  y -= 6;
  line(`Document: ${doc.title}`, { f: bold });
  line(`Envelope ID: ${doc.id}`);
  line(`Created: ${fmt(doc.createdAt)}   Sent: ${fmt(doc.sentAt)}`);
  line(`Completed: ${fmt(doc.completedAt)}`);
  line(`Original document SHA-256: ${doc.originalHash}`, { size: 8.5 });
  line(`Signing order: ${doc.signingOrder === 'sequential' ? 'Sequential' : 'Any order'}   Pages: ${pages.length}`);
  y -= 6;
  rule();
  line('Signers', { size: 13, f: bold });
  y -= 2;

  for (const s of [...doc.signers].sort((a, b) => a.order - b.order)) {
    ensure(110);
    line(`${s.order}. ${s.name} <${s.email}>`, { f: bold });
    line(`Status: ${s.status.toUpperCase()}   Viewed: ${fmt(s.viewedAt)}   Signed: ${fmt(s.signedAt)}`, { size: 9, indent: 14 });
    line(`IP address: ${s.ip || '-'}   Consent to electronic signature: ${s.consentAt ? fmt(s.consentAt) : '-'}`, { size: 9, indent: 14 });
    line(`Device: ${s.userAgent || '-'}`, { size: 8, indent: 14, color: rgb(0.4, 0.4, 0.4) });
    const sig = doc.fields.find((f) => f.signerId === s.id && f.type === 'signature' && f.value);
    if (sig) {
      const png = await pdf.embedPng(Buffer.from(sig.value.split(',')[1], 'base64'));
      const scale = Math.min(160 / png.width, 40 / png.height);
      ensure(48);
      page.drawRectangle({ x: M + 14, y: y - 40, width: 170, height: 46, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
      page.drawImage(png, { x: M + 19, y: y - 37, width: png.width * scale, height: png.height * scale });
      y -= 52;
    }
    y -= 6;
  }

  rule();
  line('Event history', { size: 13, f: bold });
  y -= 2;
  for (const e of doc.events) {
    line(`${fmt(e.at)}  -  ${e.text}${e.ip ? `  (IP ${e.ip})` : ''}`, { size: 8.5 });
  }
  y -= 10;
  line(
    'Each signer consented to conduct this transaction electronically and adopted the signature shown. ' +
      'The SHA-256 fingerprint of this completed file is recorded by the signing system and can be checked on its Verify page.',
    { size: 8, color: rgb(0.4, 0.4, 0.4) }
  );

  pdf.setTitle(doc.title);
  pdf.setProducer(`${company} eSign`);
  pdf.setModificationDate(new Date());
  return Buffer.from(await pdf.save());
}

module.exports = { finalize };
