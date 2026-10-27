// Sends email through SMTP when configured; otherwise prints the message to the console
// so links can still be shared by hand.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const COMPANY = process.env.COMPANY_NAME || 'Our Company';
const FROM_ADDRESS = process.env.MAIL_FROM || process.env.SMTP_USER;
let transport = null;

// Google shows App Passwords in groups of four; the spaces aren't part of it.
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const missingPassword = !!process.env.SMTP_USER && !SMTP_PASS;
if (process.env.SMTP_HOST && missingPassword) console.warn('Email is OFF: SMTP_PASS is empty in .env.');

if (process.env.SMTP_HOST && !missingPassword) {
  const port = Number(process.env.SMTP_PORT || 587);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    requireTLS: port === 587,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// public/logo.png, when present, is embedded in every email header.
const LOGO_FILE = path.join(__dirname, '..', 'public', 'logo.png');

// Blank lines start a new paragraph and single line breaks become <br>, so the layout holds in every mail
// program (Outlook ignores white-space:pre-line).
const paragraphs = (text) => String(text).trim().split(/\n\s*\n/)
  .map((p) => `<p style="margin:0 0 14px;line-height:1.6;font-size:15px">${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

// Label / value rows in a shaded box, e.g. a sign-in ID and password.
const detailBox = (details) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:4px 0 18px;background:#f1f5fb;border:1px solid #d6e2f3;border-left:4px solid #1e63b5;border-radius:6px">
    ${details.map(([label, value]) => `<tr>
      <td style="padding:10px 14px;font-size:13px;color:#6b7280;white-space:nowrap;width:1%">${esc(label)}</td>
      <td style="padding:10px 14px;font-size:16px;font-weight:bold;font-family:Consolas,'Courier New',monospace;color:#111827;word-break:break-all">${esc(value)}</td>
    </tr>`).join('')}
  </table>`;

function render({ heading, text, details, after, link, linkLabel, personal, note, pixel, logo }) {
  const header = logo
    ? `<div style="padding:18px 28px;border-bottom:4px solid #1e63b5"><img src="cid:logo" alt="${esc(COMPANY)}" style="height:44px;max-width:260px"></div>`
    : `<div style="background:#1e3a8a;color:#fff;padding:18px 28px;font-size:16px;font-weight:bold">${esc(COMPANY)} eSign</div>`;
  return `<div style="background:#f4f6fa;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
    <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb">
      ${header}
      <div style="padding:28px">
        ${heading ? `<h2 style="margin:0 0 14px;font-size:20px">${esc(heading)}</h2>` : ''}
        ${paragraphs(text)}
        ${details?.length ? detailBox(details) : ''}
        ${after ? `<div style="font-size:13px;color:#4b5563">${paragraphs(after)}</div>` : ''}
        ${link ? `<p style="margin:28px 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#f59e0b;color:#111827;font-weight:bold;padding:13px 26px;border-radius:6px;text-decoration:none">${esc(linkLabel || 'Open')}</a></p>
        <p style="font-size:12px;color:#6b7280;word-break:break-all">If the button doesn't work, copy this link into your browser:<br>${esc(link)}</p>` : ''}
      </div>
      <div style="padding:16px 28px;background:#f9fafb;font-size:11px;color:#6b7280;line-height:1.5">
        ${note ? `<strong>Do not share this email.</strong> ${esc(note)} ` : personal ? '<strong>Do not share this email.</strong> It contains a secure link to your document. ' : ''}
        This message was sent by ${esc(COMPANY)}'s electronic signature system.
      </div>
    </div>${pixel ? `<img src="${esc(pixel)}" width="1" height="1" alt="" style="display:block;border:0">` : ''}</div>`;
}

async function send({ to, subject, heading, text, details, after, link, linkLabel, personal = !!link, note, attachments = [], pixel }) {
  // Plain-text version: the same content, details as "Label: value" lines.
  const plain = [text, details?.map(([l, v]) => `${l}: ${v}`).join('\n'), after, link].filter(Boolean).join('\n\n');
  if (!transport) {
    console.log(`\n[mail disabled] To: ${to}\nSubject: ${subject}\n${plain}\n`);
    return false;
  }
  const info = await transport.sendMail({
    from: { name: `${COMPANY} via eSign`, address: FROM_ADDRESS },
    to,
    subject,
    text: plain,
    html: render({ heading, text, details, after, link, linkLabel, personal, note, pixel, logo: fs.existsSync(LOGO_FILE) }),
    attachments: fs.existsSync(LOGO_FILE) ? [...attachments, { filename: 'logo.png', path: LOGO_FILE, cid: 'logo' }] : attachments,
  });
  console.log(`[mail] ${new Date().toISOString()} to=${to} subject="${subject}" accepted=${info.accepted} rejected=${info.rejected} server="${info.response}"`);
  return true;
}

module.exports = { send, render, enabled: () => !!transport, verify: () => transport.verify(), COMPANY };
