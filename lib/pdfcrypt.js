// Locks completed PDFs: Standard security handler, AES-128 (V4/R4, AESV2 crypt filter), opened without
// a password but with permissions that allow printing only: no copying text, no editing, no extracting
// pages. The owner password that could lift the restrictions is random and never stored.
//
// Encryption is applied to the pdf-lib document before it is saved and signed. Signature /Contents
// stay unencrypted (as the PDF standard requires), so the embedded digital signatures still verify.
// Incremental updates written later (one per signer) encrypt their own strings with `stringHex`.
const crypto = require('crypto');
const { PDFName, PDFNumber, PDFString, PDFHexString, PDFDict, PDFArray, PDFStream, PDFRawStream } = require('pdf-lib');

const PADDING = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const KEY_BYTES = 16;

// Permission bits (PDF 32000-1, table 22): print (3) and high-quality print (12). Bits 7-8 and 13-32
// must be 1. Everything else (modify 4, copy 5, annotate 6, fill forms 9, extract 10, assemble 11) is off.
const PERMISSIONS = (0xfffff0c0 | (1 << 2) | (1 << 11)) | 0;

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const pad = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PADDING]).subarray(0, 32);

// RC4 is only used for the O and U entries (Algorithms 3 and 5); OpenSSL 3 no longer ships it.
function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const rc4Rounds = (key, data) => {
  let out = rc4(key, data);
  for (let i = 1; i <= 19; i++) out = rc4(Buffer.from(key.map((b) => b ^ i)), out);
  return out;
};

function makeKeys(fileId) {
  const ownerPassword = crypto.randomBytes(32).toString('hex');
  // Algorithm 3: O entry.
  let h = md5(pad(ownerPassword));
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, KEY_BYTES));
  const O = rc4Rounds(h.subarray(0, KEY_BYTES), pad(''));
  // Algorithm 2: file encryption key (empty user password, metadata encrypted).
  const p = Buffer.alloc(4);
  p.writeInt32LE(PERMISSIONS);
  let key = md5(pad(''), O, p, fileId);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, KEY_BYTES));
  key = key.subarray(0, KEY_BYTES);
  // Algorithm 5: U entry.
  const U = Buffer.concat([rc4Rounds(key, md5(PADDING, fileId)), crypto.randomBytes(16)]);
  return { key, O, U };
}

// Algorithm 1 (AES variant): the key for one object.
function objectKey(key, num, gen = 0) {
  const n = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
  return md5(key, n, Buffer.from('sAlT', 'latin1')).subarray(0, 16);
}
function aes(key, num, gen, data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', objectKey(key, num, gen), iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

const stringBytes = (s) => Buffer.from(s.asBytes ? s.asBytes() : PDFHexString.fromText(String(s)).asBytes());

// Encrypts every string and stream of a pdf-lib document in place and adds the /Encrypt dictionary.
// Call it last, right before saving (and after any signature placeholders were added).
function encryptDocument(pdf) {
  const ctx = pdf.context;
  const fileId = crypto.randomBytes(16);
  const { key, O, U } = makeKeys(fileId);

  const encryptDict = ctx.obj({
    Filter: 'Standard', V: 4, R: 4, Length: 128, P: PDFNumber.of(PERMISSIONS),
    CF: { StdCF: { Type: 'CryptFilter', CFM: 'AESV2', AuthEvent: 'DocOpen', Length: 16 } },
    StmF: 'StdCF', StrF: 'StdCF',
    O: PDFHexString.of(O.toString('hex')), U: PDFHexString.of(U.toString('hex')),
  });
  const encryptRef = ctx.register(encryptDict);

  const isSigDict = (d) => d instanceof PDFDict && d.get(PDFName.of('Type')) === PDFName.of('Sig');
  const encryptValue = (value, num, gen) => {
    if (value instanceof PDFString || value instanceof PDFHexString) {
      return PDFHexString.of(aes(key, num, gen, stringBytes(value)).toString('hex'));
    }
    if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) value.set(i, encryptValue(value.get(i), num, gen));
      return value;
    }
    if (value instanceof PDFDict) {
      const sig = isSigDict(value);
      for (const [k, v] of value.entries()) {
        // Signature /Contents are never encrypted (they are filled in after saving).
        if (sig && k === PDFName.of('Contents')) continue;
        value.set(k, encryptValue(v, num, gen));
      }
      return value;
    }
    return value;
  };

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encryptRef) continue;
    if (obj instanceof PDFStream) {
      const contents = Buffer.from(obj.getContents());
      encryptValue(obj.dict, ref.objectNumber, ref.generationNumber);
      ctx.assign(ref, PDFRawStream.of(obj.dict, aes(key, ref.objectNumber, ref.generationNumber, contents)));
    } else {
      encryptValue(obj, ref.objectNumber, ref.generationNumber);
    }
  }

  const idHex = fileId.toString('hex');
  ctx.trailerInfo.Encrypt = encryptRef;
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(idHex), PDFHexString.of(idHex)]);

  return {
    encryptNum: encryptRef.objectNumber,
    idHex,
    // A text string for an incremental update, encrypted for object `num`, as <hex>.
    stringHex: (num, text) => `<${aes(key, num, 0, Buffer.from(PDFHexString.fromText(String(text)).asBytes())).toString('hex')}>`,
    // A byte string (e.g. a PDF date) for object `num`, as <hex>.
    bytesHex: (num, latin1) => `<${aes(key, num, 0, Buffer.from(latin1, 'latin1')).toString('hex')}>`,
  };
}

module.exports = { encryptDocument, PERMISSIONS };
