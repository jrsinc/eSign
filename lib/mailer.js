// Sends email through SMTP when configured; otherwise prints the message to the console
// so links can still be shared by hand.
const nodemailer = require('nodemailer');

const COMPANY = process.env.COMPANY_NAME || 'Our Company';
let transport = null;

if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function send({ to, subject, text, link, linkLabel }) {
  if (!transport) {
    console.log(`\n[mail disabled] To: ${to}\nSubject: ${subject}\n${text}\n${link || ''}\n`);
    return false;
  }
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#1f2937">
    <h2 style="margin:0 0 16px">${esc(COMPANY)}</h2>
    <p style="white-space:pre-line">${esc(text)}</p>
    ${link ? `<p style="margin:28px 0"><a href="${esc(link)}" style="background:#2563eb;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none">${esc(linkLabel || 'Open')}</a></p>
    <p style="font-size:12px;color:#6b7280">If the button doesn't work, copy this link: ${esc(link)}</p>` : ''}
    <p style="font-size:12px;color:#6b7280">Do not forward this email: the link is personal to you.</p></div>`;
  await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text: `${text}\n\n${link || ''}`, html });
  return true;
}

module.exports = { send, enabled: () => !!transport, COMPANY };
