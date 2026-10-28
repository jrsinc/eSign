const token = new URLSearchParams(location.search).get('t') || '';
const app = $('#app');
const values = {};
const adopted = {}; // { signature: dataUrl, initials: dataUrl }
let info = null;
let fieldEls = [];
let appearance = 'DRAW';

function message(title, body) {
  $('#bar').classList.add('hidden');
  app.innerHTML = `<div class="center-box card" style="max-width:520px;text-align:center"><h1>${title}</h1>${body}</div>`;
}

function alreadySigned() {
  const done = info.status === 'completed';
  message('Already signed ✓', `
    <p>You signed ${info.agreementId ? `agreement <strong>${esc(info.agreementId)}</strong>` : ''} "${esc(info.title)}"${info.signer.signedAt ? ` on ${esc(new Date(info.signer.signedAt).toLocaleString())}` : ''}.</p>
    <p class="muted">This signing link is no longer valid. ${done
      ? 'All parties have signed. The completed agreement was emailed to you as a PDF attachment.'
      : 'The completed agreement will be emailed to you as a PDF attachment once everyone has signed.'}</p>
    ${info.canRequestAccount ? accountOffer() : ''}`);
  bindAccountOffer();
}

// Sign in on the dashboard's sign-in page, then come straight back here.
const signInUrl = (email) => `/?next=${encodeURIComponent(location.pathname + location.search)}&email=${encodeURIComponent(email)}`;

// The server refused because this browser is not signed in as the invited recipient.
function identityPage(d) {
  const { reason, invitedEmail, loggedInAs } = d.identity;
  $('#company').textContent = d.company || 'eSign';
  const doc = `${d.agreementId ? `Agreement <strong>${esc(d.agreementId)}</strong> ` : 'The document '}"${esc(d.title || '')}"`;
  if (reason === 'login') {
    message('Sign in to continue', `
      <p>${doc} was sent to <strong>${esc(invitedEmail)}</strong>.</p>
      <p class="muted">You have an account with this email. Sign in with it to view and sign the document.</p>
      <a class="btn primary" href="${esc(signInUrl(invitedEmail))}">Sign in as ${esc(invitedEmail)}</a>`);
  } else if (reason === 'mismatch') {
    message('Wrong account', `
      <p>You are logged in as <strong>${esc(loggedInAs)}</strong>, but this document was sent to <strong>${esc(invitedEmail)}</strong>.</p>
      <p class="muted">Please log out and log in with ${esc(invitedEmail)}, or contact the sender.</p>
      <div class="row" style="justify-content:center;gap:8px">
        <button id="idLogout">Log out</button>
        <button id="idSwitch" class="primary">Switch account</button>
      </div>`);
    const logout = () => api('/api/logout', { method: 'POST' }).catch(() => {});
    $('#idLogout').onclick = async () => { await logout(); location.reload(); };
    $('#idSwitch').onclick = async () => { await logout(); location.href = signInUrl(invitedEmail); };
  } else {
    message('Can\'t sign with this account', `<p>${esc(d.error)}</p>`);
  }
}

async function load() {
  try {
    info = await api(`/api/sign/${encodeURIComponent(token)}`);
  } catch (e) {
    if (e.data?.identity) return identityPage(e.data);
    return message('Link not valid', `<p class="muted">${esc(e.message)} Please contact the sender.</p>`);
  }
  $('#company').textContent = info.company;
  document.title = `Sign: ${info.title}`;

  // Links stop working once their owner has signed.
  if (info.expired) return alreadySigned();
  if (info.status === 'voided') {
    return message('Agreement cancelled', `<p class="muted">${esc(info.company)} cancelled agreement <strong>${esc(info.agreementId || '')}</strong> "${esc(info.title)}". No action is needed.</p>${info.cancelReason ? `<p>Reason: ${esc(info.cancelReason)}</p>` : ''}`);
  }
  if (info.status === 'declined') return message('Document declined', '<p class="muted">This document was declined and can no longer be signed.</p>');
  if (info.waitingOn.length) return message('Not your turn yet', `<p class="muted">This document is waiting for ${esc(info.waitingOn.join(', '))} to sign first. You'll get an email when it's your turn.</p>`);

  app.innerHTML = `
    <div class="wrap" style="max-width:960px">
      <div class="card" style="margin-bottom:16px">
        ${info.agreementId ? `<div class="agr-id">Agreement ID: ${esc(info.agreementId)}</div>` : ''}
        <h1 style="margin-bottom:4px">${esc(info.title)}</h1>
        <p class="muted" style="margin:0">Hi ${esc(info.signer.name)}, please review the document and complete the highlighted fields.</p>
        ${info.message ? `<p style="white-space:pre-line;margin:10px 0 0;padding:10px;background:#f9fafb;border-radius:8px">${esc(info.message)}</p>` : ''}
        <div id="identity"></div>
      </div>
      <div class="pages" id="pages"></div>
    </div>`;
  $('#bar').classList.remove('hidden');
  renderIdentity();
  $('#consent').onchange = updateProgress;

  const pages = await renderPdf(`/api/sign/${encodeURIComponent(token)}/file`, $('#pages'));
  fieldEls = info.fields.map((f) => {
    const el = document.createElement('div');
    const st = f.style || {};
    el.className = 'field signer-field';
    el.style.cssText = `--c:${info.signer.color};left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
    el.dataset.id = f.id;
    el.title = f.label || FIELD_TYPES[f.type]?.label || '';
    const styled = (node) => {
      node.style.fontFamily = FONT_CSS[st.font] || '';
      node.style.color = st.color || '';
      node.style.textAlign = st.align || 'left';
      return node;
    };
    const auto = (text) => {
      el.append(styled(Object.assign(document.createElement('span'), { textContent: text, className: 'ftext' })));
      el.style.justifyContent = { center: 'center', right: 'flex-end' }[st.align] || 'flex-start';
      el.classList.add('done');
    };
    // Company and title are the same everywhere they appear.
    const changed = (value) => {
      values[f.id] = value;
      el.classList.toggle('done', !!value.trim() || !f.required);
      if (f.type === 'company' || f.type === 'title') {
        for (const o of fieldEls) if (o.f.type === f.type && o.f.id !== f.id) {
          values[o.f.id] = value;
          o.el.setValue(value);
          o.el.classList.toggle('done', !!value.trim() || !o.f.required);
        }
      }
      updateProgress();
    };
    const input = (type, placeholder) => {
      const inp = styled(document.createElement('input'));
      inp.type = type;
      inp.placeholder = placeholder;
      inp.oninput = inp.onchange = () => changed(inp.value);
      el.setValue = (v) => { inp.value = v; };
      el.append(inp);
      if (!f.required) el.classList.add('done');
    };

    switch (f.type) {
      case 'date': auto(formatToday(f.dateFormat)); break;
      case 'name': auto(info.signer.name); break;
      case 'email': auto(info.signer.email); break;
      case 'datefield': input('date', f.label || 'Date'); break;
      case 'number': input('number', f.label || 'Number'); break;
      case 'company': {
        if (!info.companies?.length) { input('text', f.label || 'Company'); break; }
        const pick = companyPicker({ placeholder: f.label || 'Company', styled, compact: true, onChange: changed });
        el.setValue = pick.set;
        el.append(pick.node);
        if (!f.required) el.classList.add('done');
        break;
      }
      case 'title': input('text', f.label || 'Title'); break;
      case 'text': input('text', f.label || (f.required ? 'Required' : 'Optional')); break;
      case 'dropdown': {
        const sel = styled(document.createElement('select'));
        sel.innerHTML = `<option value="">${esc(f.label || 'Select…')}</option>${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}`;
        sel.onchange = () => { values[f.id] = sel.value; el.classList.toggle('done', !!sel.value || !f.required); updateProgress(); };
        el.append(sel);
        if (!f.required) el.classList.add('done');
        break;
      }
      case 'checkbox':
        el.classList.add('cb');
        el.onclick = () => { values[f.id] = !values[f.id]; el.textContent = values[f.id] ? '✓' : ''; el.classList.toggle('done', values[f.id] || !f.required); updateProgress(); };
        if (!f.required) el.classList.add('done');
        break;
      case 'radio':
        el.classList.add('cb', 'radio');
        el.title = `${f.label}${f.group ? ` (${f.group})` : ''}`;
        el.onclick = () => {
          const group = f.group || f.id;
          for (const o of fieldEls) if (o.f.type === 'radio' && (o.f.group || o.f.id) === group) {
            values[o.f.id] = o.f.id === f.id;
            o.el.textContent = values[o.f.id] ? '●' : '';
            o.el.classList.add('done');
          }
          updateProgress();
        };
        break;
      case 'formula':
        // Calculated live from other fields; the server recalculates it when signing.
        auto('');
        el.classList.add('formula');
        el.title = `Calculated: ${f.formula}`;
        break;
      case 'note':
        el.classList.add('note', 'done');
        el.innerHTML = `<span>🗒 ${esc(f.note)}</span>`;
        el.title = 'Note from the sender';
        break;
      case 'attachment': {
        const pick = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.csv', hidden: true });
        const label = document.createElement('span');
        label.className = 'ftext';
        const show = (name) => {
          label.textContent = name ? `📎 ${name}` : `📎 ${f.label || 'Attach a file'}${f.required ? '' : ' (optional)'}`;
          el.classList.toggle('done', !!name || !f.required);
          if (name) values[f.id] = name;
        };
        show(info.attached?.[f.id]);
        pick.onchange = async () => {
          const file = pick.files[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) return toast('File is larger than 10 MB');
          const fd = new FormData();
          fd.append('file', file);
          label.textContent = 'Uploading…';
          try {
            const r = await api(`/api/sign/${encodeURIComponent(token)}/attachment/${f.id}`, { method: 'POST', body: fd });
            show(r.name);
            toast('File attached');
          } catch (e) {
            show(values[f.id]);
            toast(e.message, 4000);
          }
          updateProgress();
        };
        el.append(label, pick);
        el.onclick = (e) => { if (e.target !== pick) pick.click(); };
        break;
      }
      case 'stamp': {
        const pick = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
        el.textContent = `🔏 ${f.label || 'Add your stamp'}`;
        if (!f.required) el.classList.add('done');
        pick.onchange = async () => {
          const file = pick.files[0];
          if (!file) return;
          try {
            const url = await imageToPng(file, false);
            values[f.id] = url;
            el.innerHTML = `<img alt="stamp" src="${url}">`;
            el.classList.add('done');
            updateProgress();
          } catch (e) { toast(e.message); }
        };
        el.append(pick);
        el.onclick = (e) => { if (e.target !== pick) pick.click(); };
        break;
      }
      default:
        el.textContent = f.type === 'signature' ? 'Click to sign' : 'Initial';
        el.onclick = () => (adopted[f.type] ? applySig(f.type) : openPad(f.type));
    }
    pages[f.page]?.layer.append(el);
    return { f, el };
  });
  // Details this person entered on an earlier agreement are filled in; they only need to check them.
  for (const type of ['title', 'company']) {
    const known = info.profile?.[type];
    if (!known) continue;
    for (const { f, el } of fieldEls) {
      if (f.type !== type) continue;
      values[f.id] = known;
      el.setValue(known);
      el.classList.add('done');
      el.title = 'Filled from your previous agreement. Please check it.';
    }
  }
  // Radio groups that need no answer start out complete.
  for (const { f, el } of fieldEls) {
    if (f.type !== 'radio') continue;
    const group = fieldEls.filter((o) => o.f.type === 'radio' && (o.f.group || o.f.id) === (f.group || f.id));
    if (!group.some((o) => o.f.required)) el.classList.add('done');
  }
  updateProgress();
}

// Company dropdown from the administrators' list, with "Other" to type a name that isn't listed.
// `compact` (a field on the page) shows either the list or the text box; otherwise both stack.
function companyPicker({ placeholder, styled = (n) => n, compact = false, onChange, select, other }) {
  const OTHER = '__other';
  const sel = select || styled(document.createElement('select'));
  sel.innerHTML = `<option value="">${esc(placeholder)}: choose…</option>${info.companies.map((c) => `<option>${esc(c)}</option>`).join('')}<option value="${OTHER}">Other (type the company name)</option>`;
  const box = other || styled(Object.assign(document.createElement('input'), { type: 'text', maxLength: 120 }));
  box.placeholder = 'Type the company name';
  const show = (isOther) => {
    box.hidden = !isOther;
    if (compact) sel.hidden = isOther;
  };
  const value = () => (sel.value === OTHER ? box.value.trim() : sel.value);
  sel.onchange = () => {
    show(sel.value === OTHER);
    if (sel.value === OTHER) box.focus();
    onChange?.(value());
  };
  box.oninput = () => onChange?.(value());
  // Back to the list when the typed name is cleared.
  box.onblur = () => {
    if (compact && !box.value.trim()) { sel.value = ''; show(false); onChange?.(''); }
  };
  const set = (v) => {
    v = String(v || '').trim();
    const match = info.companies.find((c) => c.toLowerCase() === v.toLowerCase());
    if (!v || match) { sel.value = match || ''; box.value = ''; show(false); } else { sel.value = OTHER; box.value = v; show(true); }
  };
  show(false);
  const node = document.createElement('span');
  node.style.display = 'contents';
  if (!select) node.append(sel);
  if (!other) node.append(box);
  return { node, set, value, sel, box };
}

function remaining() {
  const out = [];
  const seenGroups = new Set();
  for (const item of fieldEls) {
    const { f } = item;
    const v = values[f.id];
    if (f.type === 'signature' || f.type === 'initials') {
      if (!v) out.push(item);
    } else if (['text', 'company', 'title', 'number', 'datefield', 'dropdown', 'attachment', 'stamp'].includes(f.type)) {
      if (f.required && !String(v || '').trim()) out.push(item);
    } else if (f.type === 'checkbox') {
      if (f.required && !v) out.push(item);
    } else if (f.type === 'radio') {
      const group = f.group || f.id;
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      const list = fieldEls.filter((o) => o.f.type === 'radio' && (o.f.group || o.f.id) === group);
      if (list.some((o) => o.f.required) && !list.some((o) => values[o.f.id])) out.push(item);
    }
  }
  return out;
}

// Live preview of Formula fields from this signer's own fields (the server makes the final calculation).
function recalcFormulas() {
  const valueOf = (name) => {
    const o = fieldEls.find((x) => (x.f.label || '').trim().toLowerCase() === name.toLowerCase());
    return o ? values[o.f.id] : '';
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const { f, el } of fieldEls) {
      if (f.type !== 'formula') continue;
      values[f.id] = Formula.calculate(f.formula, valueOf, f.decimals);
      el.querySelector('.ftext').textContent = values[f.id] || '—';
    }
  }
}

function updateProgress() {
  recalcFormulas();
  const left = remaining().length;
  $('#progress').textContent = left ? `${left} required field${left > 1 ? 's' : ''} left` : 'All fields complete';
  $('#nextBtn').classList.toggle('hidden', !left);
  // Finish stays off until every required field is complete and the consent box is ticked.
  const ready = !left && $('#consent').checked;
  $('#finishBtn').disabled = !ready;
  $('#finishBtn').title = ready ? '' : left ? 'Complete all required fields first' : 'Tick the consent box first';
}

// Who is signing: the account signed in here (flow A), or the invited email that receives a temporary
// password (flow B). The email can't be changed.
function renderIdentity(note = '') {
  const a = info.auth;
  const locked = a.lockedUntil && Date.parse(a.lockedUntil) > Date.now();
  const lockLine = locked ? `<div class="identity warn" style="margin-top:8px">Signing is locked after too many wrong passwords until ${esc(new Date(a.lockedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}. The sender has been notified.</div>` : '';
  if (a.flow === 'account') {
    $('#identity').innerHTML = `<div class="identity">🔒 Signing as <strong>${esc(a.signedInAs)}</strong>. You'll confirm with your account password when you sign.</div>${lockLine}`;
    return;
  }
  const status = note || (a.tempError ? `<span style="color:var(--danger)">${esc(a.tempError)}</span>`
    : a.tempSent ? `Temporary password sent to <strong>${esc(a.invitedEmail)}</strong>. Check your inbox (and spam). It's valid for ${a.tempMinutes} minutes and works once.` : '');
  $('#identity').innerHTML = `
    <div class="identity">
      <label for="invitedEmail" style="margin:0">This document was sent to</label>
      <input id="invitedEmail" type="email" value="${esc(a.invitedEmail)}" readonly aria-readonly="true">
      <div id="tempStatus">${status}</div>
      <p class="small muted" style="margin:6px 0 0">You can view and fill in the document now. To sign, you'll enter the temporary password.
      <a href="#" id="sendTemp">Send a new temporary password</a></p>
    </div>${lockLine}`;
  $('#sendTemp').onclick = (e) => { e.preventDefault(); sendTempPassword(); };
}

async function sendTempPassword() {
  try {
    const r = await api(`/api/sign/${encodeURIComponent(token)}/temp-password`, { method: 'POST' });
    info.auth.tempSent = info.auth.tempValid = true;
    info.auth.tempError = '';
    const msg = `Temporary password sent to <strong>${esc(r.sentTo)}</strong>. Check your inbox (and spam). It's valid for ${r.minutes} minutes and works once.`;
    if ($('#tempStatus')) $('#tempStatus').innerHTML = msg;
    if (!$('#pwModal').classList.contains('hidden')) { $('#pwHelp').innerHTML = msg; $('#pwErr').textContent = ''; }
    toast('Temporary password sent');
  } catch (e) { toast(e.message, 4000); }
}

$('#nextBtn').onclick = () => {
  const next = remaining()[0];
  if (!next) return;
  next.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  next.el.querySelector('input')?.focus({ preventScroll: true });
};

function applySig(type) {
  for (const { f, el } of fieldEls) {
    if (f.type !== type) continue;
    values[f.id] = adopted[type];
    el.innerHTML = `<img alt="${type}" src="${adopted[type]}">`;
    el.classList.add('done');
    el.onclick = () => openPad(type);
  }
  updateProgress();
}

// ---------- Signature pad ----------
const pad = $('#pad');
const ctx = pad.getContext('2d');
let mode = 'draw';
let padType = 'signature';
let inked = false;

function resetPad() {
  const r = pad.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  pad.width = r.width * dpr;
  pad.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 2.6;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0b1a4d';
  inked = false;
}

let last = null;
pad.onpointerdown = (e) => {
  try { pad.setPointerCapture(e.pointerId); } catch {}
  last = [e.offsetX, e.offsetY];
  ctx.beginPath();
  ctx.arc(e.offsetX, e.offsetY, 1.2, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1a4d';
  ctx.fill();
  inked = true;
};
pad.onpointermove = (e) => {
  if (!last) return;
  const mid = [(last[0] + e.offsetX) / 2, (last[1] + e.offsetY) / 2];
  ctx.beginPath();
  ctx.moveTo(last[0], last[1]);
  ctx.quadraticCurveTo(last[0], last[1], mid[0], mid[1]);
  ctx.lineTo(e.offsetX, e.offsetY);
  ctx.stroke();
  last = [e.offsetX, e.offsetY];
};
pad.onpointerup = pad.onpointercancel = () => (last = null);
$('#clearPad').onclick = resetPad;

const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
$('#typed').oninput = () => ($('#typedPreview').textContent = $('#typed').value);

function showTab(tab) {
  mode = tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
  if (tab === 'type') $('#typed').focus();
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function openPad(type) {
  padType = type;
  const saved = info.profile?.[type];
  $('#modalTitle').textContent = saved
    ? (type === 'signature' ? 'Verify your signature' : 'Verify your initials')
    : (type === 'signature' ? 'Adopt your signature' : 'Adopt your initials');
  $('#adoptSig').textContent = saved ? `Use this ${type === 'signature' ? 'signature' : 'initials'}` : 'Adopt and sign';
  const name = info.signer.name;
  $('#typed').value = type === 'signature' ? name : name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
  $('#typedPreview').textContent = $('#typed').value;
  $('.tabs [data-tab=saved]').classList.toggle('hidden', !saved);
  if (saved) $('#savedImg').src = saved;
  $('#modal').classList.remove('hidden');
  resetPad();
  showTab(saved ? 'saved' : 'draw');
}
$('#cancelSig').onclick = () => $('#modal').classList.add('hidden');

// Turns an uploaded JPG/PNG into a PNG data URL (max 1200 px wide). For signatures the white paper
// background becomes transparent and the image is cropped to the ink.
async function imageToPng(file, removeWhite) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Please choose a PNG or JPG image');
  if (file.size > 8 * 1024 * 1024) throw new Error('Image is larger than 8 MB');
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That image could not be opened'));
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, 1200 / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  if (removeWhite) {
    const data = x.getImageData(0, 0, c.width, c.height);
    const p = data.data;
    for (let k = 0; k < p.length; k += 4) {
      const light = (p[k] + p[k + 1] + p[k + 2]) / 3;
      if (light > 200) p[k + 3] = 0;
      else if (light > 150) p[k + 3] = Math.round(((200 - light) / 50) * 255);
    }
    x.putImageData(data, 0, 0);
    const url = trimmed(c);
    if (!url) throw new Error('No signature found in that image');
    return url;
  }
  return c.toDataURL('image/png');
}

let uploadedSig = null;
$('#sigFile').onchange = async () => {
  const file = $('#sigFile').files[0];
  uploadedSig = null;
  $('#sigFilePreview').removeAttribute('src');
  if (!file) return;
  try {
    uploadedSig = await imageToPng(file, true);
    $('#sigFilePreview').src = uploadedSig;
  } catch (e) {
    toast(e.message, 4000);
  }
};

// Crop a canvas to its inked pixels so the image fills the field nicely.
function trimmed(canvas) {
  const c = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = c.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

$('#adoptSig').onclick = () => {
  let url;
  if (mode === 'saved') {
    url = info.profile[padType];
  } else if (mode === 'upload') {
    if (!uploadedSig) return toast('Please choose an image of your signature');
    url = uploadedSig;
  } else if (mode === 'draw') {
    if (!inked) return toast('Please draw your signature');
    url = trimmed(pad);
  } else {
    const text = $('#typed').value.trim();
    if (!text) return toast('Please type your name');
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = 240;
    const x = c.getContext('2d');
    x.font = `110px ${SCRIPT_FONT}`;
    x.fillStyle = '#0b1a4d';
    x.textBaseline = 'middle';
    x.fillText(text, 20, 120, 1160);
    url = trimmed(c);
  }
  if (!url) return toast('Signature is empty');
  adopted[padType] = url;
  if (padType === 'signature') appearance = mode === 'saved' ? (info.profile.appearance || 'DRAW') : { draw: 'DRAW', type: 'TYPE', upload: 'UPLOAD' }[mode];
  applySig(padType);
  $('#modal').classList.add('hidden');
};

// ---------- Finish / decline ----------
$('#finishBtn').onclick = async () => {
  const left = remaining();
  if (left.length) {
    toast(`Please complete ${left.length} more field${left.length > 1 ? 's' : ''}`);
    return $('#nextBtn').click();
  }
  if (!$('#consent').checked) {
    toast('Please tick the consent box to sign electronically');
    return $('#consent').focus();
  }
  confirmAndSign();
};

// Final step: title and company for the signature page, plus the reason for signing.
let sgCompanyPick = null;
function confirmAndSign() {
  // Each detail is asked once: a Title/Company field on the document is shown read-only for checking;
  // otherwise the box is pre-filled from this person's previous agreement, ready to verify.
  const fromField = (type) => fieldEls.find((o) => o.f.type === type);
  let prefilled = false;
  // With a company list, the company box becomes a dropdown (the text box is used for "Other").
  if (info.companies?.length && !sgCompanyPick) {
    const sel = document.createElement('select');
    sel.id = 'sgCompanySel';
    $('#sgCompany').before(sel);
    $('label[for=sgCompany]').htmlFor = 'sgCompanySel';
    sgCompanyPick = companyPicker({ placeholder: 'Company', select: sel, other: $('#sgCompany') });
    sgCompanyPick.box.style.marginTop = '6px';
  }
  for (const [type, input] of [['title', $('#sgTitle')], ['company', $('#sgCompany')]]) {
    const field = fromField(type);
    const pick = type === 'company' ? sgCompanyPick : null;
    const note = input.nextElementSibling?.classList.contains('verify-note') ? input.nextElementSibling : null;
    note?.remove();
    input.readOnly = !!field;
    input.classList.toggle('verified', !!field);
    if (field) {
      // Read-only: show what was entered in the document, as text.
      if (pick) { pick.sel.hidden = true; input.hidden = false; }
      input.value = values[field.f.id] || '';
      input.insertAdjacentHTML('afterend', '<div class="verify-note small muted">✓ As entered in the document</div>');
    } else if (pick) {
      pick.sel.hidden = false;
      const current = pick.value() || input.value || info.profile?.[type] || '';
      if (!pick.value() && !input.value && info.profile?.[type]) prefilled = true;
      pick.set(current);
    } else if (!input.value && info.profile?.[type]) {
      input.value = info.profile[type];
      prefilled = true;
    }
  }
  $('#confirmHint').textContent = prefilled || fromField('title') || fromField('company')
    ? 'Please check your details. They appear with your signature on the signature page.'
    : 'These details appear with your signature on the signature page.';
  $('#reasonBox').classList.toggle('hidden', !info.requireReason);
  $('#reasonList').innerHTML = [...info.reasons, 'Other'].map((r, i) =>
    `<label><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}> ${esc(r === 'Other' ? 'Other (type your own)' : r)}</label>`).join('');
  const other = $('#reasonOther');
  other.value = '';
  other.classList.add('hidden');
  $('#reasonList').onchange = () => other.classList.toggle('hidden', $('input[name=reason]:checked').value !== 'Other');
  $('#reasonModal').classList.remove('hidden');
  if (!$('#sgTitle').classList.contains('hidden')) $('#sgTitle').focus();
}
$('#reasonCancel').onclick = () => $('#reasonModal').classList.add('hidden');
$('#reasonOk').onclick = () => {
  let reason = '';
  if (info.requireReason) {
    const picked = $('input[name=reason]:checked').value;
    reason = picked === 'Other' ? $('#reasonOther').value.trim() : picked;
    if (!reason) return toast('Please type your reason');
  }
  $('#reasonModal').classList.add('hidden');
  const company = sgCompanyPick && !$('#sgCompany').readOnly ? sgCompanyPick.value() : $('#sgCompany').value.trim();
  const title = $('#sgTitle').value.trim();
  askPassword({
    action: 'sign', meaning: reason,
    send: (password) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return api(`/api/sign/${encodeURIComponent(token)}`, { method: 'POST', body: { consent: true, values, reason, title, company, tz, appearance, password } });
    },
    done: signedPage,
  });
};

// The final confirmation: shows what is being signed and by whom, and asks for the account password
// (flow A) or the temporary password (flow B). The server checks it; wrong ones count toward a lock.
function askPassword({ action, meaning, send, done }) {
  const a = info.auth;
  const signing = action === 'sign';
  $('#pwTitle').textContent = a.flow === 'account'
    ? (signing ? 'Confirm signing with your password' : 'Confirm declining with your password')
    : `Enter the temporary password sent to ${a.invitedEmail} to ${signing ? 'sign' : 'decline'}`;
  $('#pwSummary').innerHTML = [
    ['Document', info.title], ['Agreement ID', info.agreementId], ['Signer', info.signer.name], ['Invited email', a.invitedEmail],
    [signing ? 'Meaning of signature' : 'Action', signing ? (meaning || 'Signature') : `Decline to sign${meaning ? `: ${meaning}` : ''}`],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  $('#pwLabel').textContent = a.flow === 'account' ? `Your account password (${a.signedInAs})` : 'Temporary password';
  $('#signPw').autocomplete = a.flow === 'account' ? 'current-password' : 'one-time-code';
  $('#signPw').value = '';
  $('#pwErr').textContent = '';
  $('#pwHelp').innerHTML = a.flow === 'account'
    ? 'Your password confirms it is you signing, at this moment.'
    : `${a.tempValid ? 'Check your inbox (and spam) for the email with the temporary password.' : 'Your temporary password has expired or was not sent yet.'} <a href="#" id="pwResend">Send a new one</a>`;
  $('#pwResend')?.addEventListener('click', (e) => { e.preventDefault(); sendTempPassword(); });
  $('#pwOk').textContent = signing ? 'Sign' : 'Decline';
  $('#pwOk').classList.toggle('danger', !signing);
  $('#pwOk').disabled = false;
  $('#pwModal').classList.remove('hidden');
  $('#signPw').focus();
  $('#pwCancel').onclick = () => $('#pwModal').classList.add('hidden');
  $('#signPw').onkeydown = (e) => { if (e.key === 'Enter') $('#pwOk').click(); };
  $('#pwOk').onclick = async () => {
    const password = $('#signPw').value;
    if (!password) return $('#signPw').focus();
    $('#pwOk').disabled = true;
    $('#pwOk').textContent = signing ? 'Signing…' : 'Declining…';
    try {
      const r = await send(password);
      $('#pwModal').classList.add('hidden');
      done(r);
    } catch (e) {
      $('#pwOk').disabled = false;
      $('#pwOk').textContent = signing ? 'Sign' : 'Decline';
      $('#pwErr').textContent = e.message;
      $('#signPw').value = '';
      $('#signPw').focus();
      if (e.status === 423) {
        // Locked: no more tries for now.
        $('#pwOk').disabled = true;
        info.auth.lockedUntil = new Date(Date.now() + 30 * 60000).toISOString();
        renderIdentity();
      }
      if (e.data?.tempExpired || e.data?.tempMissing) info.auth.tempValid = false;
      if (e.data?.identity) { $('#pwModal').classList.add('hidden'); identityPage(e.data); }
    }
  };
}

function signedPage(r) {
  window.scrollTo(0, 0);
  const c = r.confirmation;
  message('Signed successfully ✓', `
    <table class="sign-summary" style="text-align:left">
      <tr><th>Signed by</th><td>${esc(c.name)}</td></tr>
      <tr><th>Email</th><td>${esc(c.email)}</td></tr>
      <tr><th>Date and time</th><td>${esc(new Date(c.signedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'long' }))}</td></tr>
      ${c.reason ? `<tr><th>Meaning</th><td>${esc(c.reason)}</td></tr>` : ''}
      ${c.agreementId ? `<tr><th>Agreement</th><td>${esc(c.agreementId)}: ${esc(c.title)}</td></tr>` : ''}
    </table>
    <p class="muted">${r.completed
      ? 'All parties have signed. The completed agreement has been emailed to you as a PDF attachment.'
      : 'The completed agreement will be emailed to you as a PDF attachment once everyone has signed.'}
    This signing link is no longer valid.</p>
    ${r.canRequestAccount ? accountOffer() : ''}`);
  bindAccountOffer();
}

// Optional, after signing only: ask the administrators for an account for future documents.
const accountOffer = () => `
  <div class="identity" id="acctOffer" style="text-align:left">
    <strong>Create an account with this email for future documents?</strong>
    <p class="small muted" style="margin:4px 0 8px">Optional. Without one, you'll keep signing with a temporary password emailed to you.</p>
    <button id="acctYes" class="primary">Yes, request an account</button> <button id="acctNo" class="ghost">No thanks</button>
  </div>`;
function bindAccountOffer() {
  if (!$('#acctOffer')) return;
  $('#acctNo').onclick = () => $('#acctOffer').remove();
  $('#acctYes').onclick = async () => {
    try {
      await api(`/api/sign/${encodeURIComponent(token)}/request-account`, { method: 'POST' });
      $('#acctOffer').innerHTML = '<strong>Request sent.</strong> An administrator will set up your account and email you your sign-in details.';
    } catch (e) { toast(e.message, 4000); }
  };
}

$('#declineBtn').onclick = async () => {
  const reason = prompt('Decline to sign? The sender will be notified and the document will be cancelled.\nReason (optional):');
  if (reason === null) return;
  askPassword({
    action: 'decline', meaning: reason.trim(),
    send: (password) => api(`/api/sign/${encodeURIComponent(token)}/decline`, { method: 'POST', body: { reason, password } }),
    done: () => message('You declined to sign', '<p class="muted">The sender has been notified.</p>'),
  });
};

load();
