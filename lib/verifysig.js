// Checks the digital signatures embedded in a PDF (used by the Verify page).
// For each signature: are the signed bytes unchanged, does the signature verify with the signer's
// certificate, and was that certificate issued by this system's root CA?
const crypto = require('crypto');
const forge = require('node-forge');

const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const MD = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };

const subjectOf = (cert) => Object.fromEntries(cert.subject.attributes.map((a) => [a.shortName || a.name, a.value]));

function inspectSignatures(buf, caCertPem) {
  const text = buf.toString('latin1');
  const ca = caCertPem ? forge.pki.certificateFromPem(caCertPem) : null;
  const docMdp = /\/Perms\s*<<\s*\/DocMDP/.test(text) ? Number((/\/TransformMethod\s*\/DocMDP[\s\S]{0,200}?\/P\s+(\d)/.exec(text) || [])[1] || 2) : null;
  const results = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(text))) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const r = { index: results.length + 1, intact: false, valid: false, trusted: false, coversEnd: c + d };
    try {
      if (a !== 0 || c + d > buf.length || a + b > c) throw new Error('Signature byte range is malformed');
      const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
      const der = Buffer.from(text.slice(a + b + 1, c - 1), 'hex');
      const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')), { parseAllBytes: false });
      const p7 = forge.pkcs7.messageFromAsn1(asn1);
      const { signature, authenticatedAttributes: attrs, digestAlgorithm } = p7.rawCapture;
      const alg = MD[forge.asn1.derToOid(digestAlgorithm)] || 'sha256';

      // 1. The signed bytes still match the digest inside the signature.
      const attr = (oid) => attrs.find((x) => forge.asn1.derToOid(x.value[0].value) === oid);
      const md = attr(OID_MESSAGE_DIGEST);
      const st = attr(OID_SIGNING_TIME);
      if (st) r.signedAt = forge.asn1.utcTimeToDate(st.value[1].value[0].value).toISOString();
      r.intact = !!md && Buffer.from(md.value[1].value[0].value, 'binary').equals(crypto.createHash(alg).update(signed).digest());

      // 2. The signature over those attributes verifies with the signer's certificate.
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const attrDigest = forge.md[alg].create().update(forge.asn1.toDer(set).data).digest().bytes();
      const signer = p7.certificates.find((cert) => {
        try { return cert.publicKey.verify(attrDigest, signature); } catch { return false; }
      });
      r.valid = !!signer && r.intact;
      if (signer) {
        const s = subjectOf(signer);
        Object.assign(r, { name: s.CN, email: s.E || s.emailAddress, organization: s.O, unit: s.OU, serial: signer.serialNumber });
        // 3. Issued by this system's root certificate.
        try { r.trusted = !!ca && ca.verify(signer); } catch { r.trusted = false; }
      }
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }
  if (docMdp && results[0]) results[0].kind = 'certification';
  results.forEach((r) => { r.kind = r.kind || 'approval'; });
  const end = buf.length - (/\r?\n$/.test(text) ? (text.endsWith('\r\n') ? 2 : 1) : 0);
  const last = results[results.length - 1];
  return {
    signatures: results,
    certified: !!docMdp,
    docMdpLevel: docMdp,
    // Bytes after the last signature = something was added after signing.
    modifiedAfterLastSignature: !!last && last.coversEnd < end && last.coversEnd !== buf.length,
  };
}

module.exports = { inspectSignatures };
