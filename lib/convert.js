// Turns an uploaded file into a PDF, so agreements can start from Word documents and images as well
// as PDFs. What is signed is always the resulting PDF.
//   PDF                       used as it is
//   Images (JPG, PNG, GIF, WebP, TIFF, AVIF, BMP, SVG)
//                             one A4 page per image (each frame of a multi-page TIFF), turned upright
//                             from the camera's orientation
//   Word and other office files (DOC, DOCX, RTF, ODT, TXT, XLS, XLSX, ODS, PPT, PPTX, ODP)
//                             converted by LibreOffice, which must be installed on the server
//                             (SOFFICE_PATH in .env if it isn't found by itself)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'avif', 'bmp', 'svg'];
const OFFICE_TYPES = ['doc', 'docx', 'rtf', 'odt', 'txt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'];
const ACCEPTED = ['pdf', ...IMAGE_TYPES, ...OFFICE_TYPES];

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

// What a file really is, from its first bytes (the name alone can't be trusted).
function sniff(buf, name) {
  const head = buf.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (ascii.startsWith('%PDF-')) return 'pdf';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image';
  if (ascii.startsWith('\x89PNG') || ascii.startsWith('GIF8') || ascii.startsWith('BM')) return 'image';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image';
  if (ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')) return 'image';
  if (ascii.slice(4, 8) === 'ftyp') {
    // AVIF images can be read; HEIC (iPhone) photos can't.
    const brands = buf.subarray(8, Math.min(buf.readUInt32BE(0), 64)).toString('latin1');
    if (/avif|avis/.test(brands)) return 'image';
    if (/heic|heix|hevc|heim|heis|mif1|msf1/.test(brands)) return 'heic';
  }
  const ext = extOf(name);
  if (ext === 'svg' && /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'))) return 'image';
  if (OFFICE_TYPES.includes(ext)) return 'office';
  return 'unknown';
}

// Uncompressed 24/32-bit Windows bitmaps (what Paint saves), which the image library can't read.
function decodeBmp(buf) {
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (![24, 32].includes(bits) || ![0, 3].includes(compression) || width <= 0 || width > 20000 || Math.abs(rawHeight) > 20000) {
    throw bad('This BMP image type is not supported. Save it as PNG or JPG and try again.');
  }
  const height = Math.abs(rawHeight);
  const bpp = bits / 8;
  const stride = Math.ceil((width * bpp) / 4) * 4;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (rawHeight > 0 ? height - 1 - y : y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * bpp;
      const o = (y * width + x) * 3;
      out[o] = buf[p + 2];
      out[o + 1] = buf[p + 1];
      out[o + 2] = buf[p];
    }
  }
  return { raw: out, width, height };
}

const A4 = [595.28, 841.89];
const MARGIN = 28;

async function imageToPdf(buf, name) {
  const sharp = require('sharp');
  const pdf = await PDFDocument.create();
  let input = buf;
  let options = { failOn: 'error', limitInputPixels: 100e6, animated: false };
  if (buf.subarray(0, 2).toString('latin1') === 'BM') {
    const { raw, width, height } = decodeBmp(buf);
    input = raw;
    options = { raw: { width, height, channels: 3 } };
  }
  let meta;
  try {
    meta = options.raw ? { format: 'bmp' } : await sharp(buf, { failOn: 'error' }).metadata();
  } catch {
    throw bad(`"${name}" could not be read as an image. It may be damaged.`);
  }
  // Multi-page TIFFs (scans) give every page; animated GIFs and WebPs their first frame.
  const pages = meta.format === 'tiff' ? Math.min(meta.pages || 1, 50) : 1;
  for (let i = 0; i < pages; i++) {
    let img;
    try {
      const s = sharp(input, options.raw ? options : { ...options, page: i }).rotate().flatten({ background: '#ffffff' });
      img = await s.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
    } catch {
      throw bad(`"${name}" could not be read as an image. It may be damaged.`);
    }
    const embedded = await pdf.embedJpg(img.data);
    const landscape = img.info.width > img.info.height;
    const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
    const scale = Math.min((pw - 2 * MARGIN) / img.info.width, (ph - 2 * MARGIN) / img.info.height, 1.5);
    const w = img.info.width * scale;
    const h = img.info.height * scale;
    pdf.addPage([pw, ph]).drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return Buffer.from(await pdf.save());
}

// LibreOffice's command-line program, if installed.
function soffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// One conversion at a time: LibreOffice is slow to start and heavy on memory.
let queue = Promise.resolve();
function officeToPdf(buf, name) {
  const run = async () => {
    const exe = soffice();
    if (!exe) throw bad('Word and other office files can\'t be converted on this server because LibreOffice is not installed. Save the file as PDF and upload that, or ask your administrator to install LibreOffice.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm365-convert-'));
    try {
      const input = path.join(dir, `upload.${extOf(name)}`);
      fs.writeFileSync(input, buf);
      // A private LibreOffice profile, so it never clashes with someone using LibreOffice on the server.
      const profile = `file:///${path.join(dir, 'profile').replace(/\\/g, '/').replace(/^\//, '')}`;
      await new Promise((resolve, reject) => {
        execFile(exe, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input],
          { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      }).catch(() => { throw bad(`"${name}" could not be converted to PDF. It may be damaged or password-protected. Save it as PDF and upload that.`); });
      const out = path.join(dir, 'upload.pdf');
      if (!fs.existsSync(out)) throw bad(`"${name}" could not be converted to PDF. Save it as PDF and upload that.`);
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const job = queue.then(run, run);
  queue = job.catch(() => {});
  return job;
}

// Returns { pdf, from } where `from` says what the file was ('pdf', 'image' or 'office').
async function toPdf(buf, name) {
  const kind = sniff(buf, name);
  if (kind === 'pdf') return { pdf: buf, from: 'pdf' };
  if (kind === 'image') return { pdf: await imageToPdf(buf, name), from: 'image' };
  if (kind === 'office') return { pdf: await officeToPdf(buf, name), from: 'office' };
  if (kind === 'heic') throw bad(`"${name}" is an iPhone HEIC photo, which can't be converted here. Share it as JPG (on the iPhone: Settings > Camera > Formats > Most Compatible) and upload that.`);
  throw bad(`"${name}" is not a supported file. Upload PDF, Word (DOC, DOCX, RTF, ODT), Excel, PowerPoint, text or image files (JPG, PNG, GIF, WebP, TIFF, BMP).`);
}

module.exports = { toPdf, soffice, ACCEPTED };
