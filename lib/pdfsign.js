// Certified, locked PDFs with one digital signature per signer.
//
// Revision 0 (built with pdf-lib): the finished document plus
//   - a certification signature by the company with DocMDP P=2: "no changes allowed except signing",
//     which makes Acrobat disable its editing tools and flag any other change, and
//   - an empty signature field for every signer, created up front because new fields may not be added
//     after certification.
// Revisions 1..n (written by hand as incremental updates): each signer's signature fills their field.
// Every revision is signed with @signpdf, which fills the ByteRange/Contents placeholders.
const { PDFName, PDFNumber, PDFString, PDFHexString, PDFDict, PDFArray } = require('pdf-lib');
const signpdf = require('@signpdf/signpdf').default;
const { P12Signer } = require('@signpdf/signer-p12');

const SIG_BYTES = 16384; // room for the PKCS#7 signature with its certificate chain
const BYTE_RANGE_PLACEHOLDER = '**********';

function sigDict(ctx, { reason, name, location, contact, date, reference }) {
  return ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    // ByteRange must come before Contents: @signpdf looks for /Contents after the ByteRange placeholder.
    ByteRange: ctx.obj([0, PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER)]),
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
    Reason: PDFHexString.fromText(reason),
    M: PDFString.fromDate(date),
    Name: PDFHexString.fromText(name),
    Location: PDFHexString.fromText(location),
    ContactInfo: PDFHexString.fromText(contact),
    ...(reference ? { Reference: reference } : {}),
  });
}

// Adds the certification signature placeholder and empty signer fields to the pdf-lib document.
// Returns what the later revisions need: object numbers of the fields, the page and the catalog.
function prepareCertifiedSignatures(pdf, { company, sealName, sealEmail, signers }) {
  const ctx = pdf.context;
  const page = pdf.getPages()[pdf.getPageCount() - 1];
  const catalog = pdf.catalog;

  let acroForm = catalog.lookup(PDFName.of('AcroForm'));
  if (!(acroForm instanceof PDFDict)) {
    acroForm = ctx.obj({ Fields: [] });
    catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));
  }
  let fields = acroForm.lookup(PDFName.of('Fields'));
  if (!(fields instanceof PDFArray)) {
    fields = ctx.obj([]);
    acroForm.set(PDFName.of('Fields'), fields);
  }
  acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); // signatures exist, append-only

  const docMdp = ctx.obj([ctx.obj({
    Type: 'SigRef',
    TransformMethod: 'DocMDP',
    TransformParams: ctx.obj({ Type: 'TransformParams', P: 2, V: PDFName.of('1.2') }),
  })]);
  const certSig = ctx.register(sigDict(ctx, {
    reason: 'Certified: signed agreement locked. No changes allowed except signing.',
    name: sealName, location: company, contact: sealEmail, date: new Date(), reference: docMdp,
  }));
  catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: certSig }));

  const widget = (title, extra = {}) => {
    const ref = ctx.register(ctx.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], F: 4,
      T: PDFHexString.fromText(title), P: page.ref, ...extra,
    }));
    page.node.addAnnot(ref);
    fields.push(ref);
    return ref;
  };
  widget(`Certification - ${company}`, { V: certSig });
  const signerFields = {};
  for (const s of signers) {
    const title = `${s.name} (signer ${s.order})`;
    signerFields[s.id] = { num: widget(title).objectNumber, title };
  }
  return { signerFields, pageNum: page.ref.objectNumber, rootNum: ctx.trailerInfo.Root.objectNumber, infoNum: ctx.trailerInfo.Info?.objectNumber };
}

// Appends an incremental update that fills one signer's empty field with a signature placeholder.
// `crypt` (from pdfcrypt.encryptDocument) encrypts the update's strings when the document is encrypted.
function appendSignatureRevision(bytes, layout, field, { reason, name, location, contact, date }, nextObjNum, crypt) {
  const text = bytes.toString('latin1');
  const prevXref = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split(/\s/)[0]);
  const sigNum = nextObjNum;
  const hexText = (num, s) => (crypt ? crypt.stringHex(num, s) : PDFHexString.fromText(String(s)).toString());
  const dateString = (num) => {
    const literal = PDFString.fromDate(date).toString(); // "(D:...)"
    return crypt ? crypt.bytesHex(num, literal.slice(1, -1)) : literal;
  };
  const sigObj = `${sigNum} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached`
    + ` /ByteRange [0 /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER} /${BYTE_RANGE_PLACEHOLDER}]`
    + ` /Contents <${'0'.repeat(SIG_BYTES * 2)}>`
    + ` /Reason ${hexText(sigNum, reason)} /M ${dateString(sigNum)} /Name ${hexText(sigNum, name)}`
    + ` /Location ${hexText(sigNum, location)} /ContactInfo ${hexText(sigNum, contact)} >>\nendobj\n`;
  const fieldObj = `${field.num} 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Sig /Rect [0 0 0 0] /F 4`
    + ` /T ${hexText(field.num, field.title)} /P ${layout.pageNum} 0 R /V ${sigNum} 0 R >>\nendobj\n`;

  let out = text.endsWith('\n') ? text : `${text}\n`;
  const sigOffset = Buffer.byteLength(out, 'latin1');
  out += sigObj;
  const fieldOffset = Buffer.byteLength(out, 'latin1');
  out += fieldObj;
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  const entry = (off) => `${String(off).padStart(10, '0')} 00000 n \n`;
  const sections = [[sigNum, sigOffset], [field.num, fieldOffset]].sort((a, b) => a[0] - b[0]);
  out += 'xref\n' + sections.map(([num, off]) => `${num} 1\n${entry(off)}`).join('');
  const encryption = crypt ? ` /Encrypt ${crypt.encryptNum} 0 R /ID [<${crypt.idHex}> <${crypt.idHex}>]` : '';
  out += `trailer\n<< /Size ${sigNum + 1} /Root ${layout.rootNum} 0 R${layout.infoNum ? ` /Info ${layout.infoNum} 0 R` : ''}${encryption} /Prev ${prevXref} >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Signs the single open placeholder in `bytes` with a PKCS#12 certificate bundle.
async function signRevision(bytes, cert, when) {
  return Buffer.from(await signpdf.sign(bytes, new P12Signer(cert.p12, { passphrase: cert.passphrase }), when));
}

module.exports = { prepareCertifiedSignatures, appendSignatureRevision, signRevision };
