// Certificates for digital signatures.
// The app runs its own certificate authority (CA). Each signer gets a personal certificate from it,
// e.g. "cn=Pratik Shah, o=Jupiter Research Services Inc, ou=QA, email=pratik@x.com, c=US",
// which is used once to sign the finished PDF. Adobe shows these signatures in its Signatures panel;
// to make them show as "valid", import ca-cert.pem into Adobe as a trusted certificate
// (or replace the CA files with ones issued by your company's own CA).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const COUNTRY = (process.env.PKI_COUNTRY || 'US').slice(0, 2).toUpperCase();

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' })),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

const serial = () => `01${crypto.randomBytes(15).toString('hex')}`;

function loadOrCreateCA(dir, company) {
  const keyFile = path.join(dir, 'ca-key.pem');
  const certFile = path.join(dir, 'ca-cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: forge.pki.privateKeyFromPem(fs.readFileSync(keyFile, 'utf8')), cert: forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8')), certFile };
  }
  fs.mkdirSync(dir, { recursive: true });
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 15 * 365 * 864e5);
  const attrs = [
    { name: 'commonName', value: `${company} eSign Root CA` },
    { name: 'organizationName', value: company },
    { name: 'countryName', value: COUNTRY },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(keyFile, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(certFile, forge.pki.certificateToPem(cert));
  return { key: keys.privateKey, cert, certFile };
}

// "cn=Pratik Shah, o=..., ou=..., email=..., c=US" as Adobe shows it.
function distinguishedName({ name, company, title, email }) {
  return [`cn=${name}`, company && `o=${company}`, title && `ou=${title}`, `email=${email}`, `c=${COUNTRY}`].filter(Boolean).join(', ');
}

// Issues a personal signing certificate and returns it as a password-protected PKCS#12 bundle.
function issueSignerCertificate(ca, person) {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 864e5);
  const clip = (s) => String(s).slice(0, 64);
  cert.setSubject([
    { name: 'commonName', value: clip(person.name) },
    ...(person.company ? [{ name: 'organizationName', value: clip(person.company) }] : []),
    ...(person.title ? [{ name: 'organizationalUnitName', value: clip(person.title) }] : []),
    { name: 'emailAddress', value: clip(person.email) },
    { name: 'countryName', value: COUNTRY },
  ]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectAltName', altNames: [{ type: 1, value: person.email }] },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  const passphrase = crypto.randomBytes(16).toString('hex');
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert, ca.cert], passphrase, { algorithm: '3des' });
  return {
    p12: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    passphrase,
    serial: cert.serialNumber,
    dn: distinguishedName(person),
    certPem: forge.pki.certificateToPem(cert),
  };
}

module.exports = { loadOrCreateCA, issueSignerCertificate, distinguishedName };
