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
      : 'The completed agreement will be emailed to you as a PDF attachment once everyone has signed.'}</p>`);
}

async function load() {
  try {
    info = await api(`/api/sign/${encodeURIComponent(token)}`);
  } catch (e) {
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
      </div>
      <div class="pages" id="pages"></div>
    </div>`;
  $('#bar').classList.remove('hidden');

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
    const input = (type, placeholder) => {
      const inp = styled(document.createElement('input'));
      inp.type = type;
      inp.placeholder = placeholder;
      inp.oninput = inp.onchange = () => {
        values[f.id] = inp.value;
        el.classList.toggle('done', !!inp.value.trim() || !f.required);
        // Company and title are the same everywhere they appear.
        if (f.type === 'company' || f.type === 'title') {
          for (const o of fieldEls) if (o.f.type === f.type && o.f.id !== f.id) {
            values[o.f.id] = inp.value;
            o.el.querySelector('input').value = inp.value;
            o.el.classList.toggle('done', !!inp.value.trim() || !o.f.required);
          }
        }
        updateProgress();
      };
      el.append(inp);
      if (!f.required) el.classList.add('done');
    };

    switch (f.type) {
      case 'date': auto(formatToday(f.dateFormat)); break;
      case 'name': auto(info.signer.name); break;
      case 'email': auto(info.signer.email); break;
      case 'datefield': input('date', f.label || 'Date'); break;
      case 'number': input('number', f.label || 'Number'); break;
      case 'company': input('text', f.label || 'Company'); break;
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
      el.querySelector('input').value = known;
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

function remaining() {
  const out = [];
  const seenGroups = new Set();
  for (const item of fieldEls) {
    const { f } = item;
    const v = values[f.id];
    if (f.type === 'signature' || f.type === 'initials') {
      if (!v) out.push(item);
    } else if (['text', 'company', 'title', 'number', 'datefield', 'dropdown'].includes(f.type)) {
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

function updateProgress() {
  const left = remaining().length;
  $('#progress').textContent = left ? `${left} required field${left > 1 ? 's' : ''} left` : 'All fields complete';
  $('#nextBtn').classList.toggle('hidden', !left);
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
  if (padType === 'signature') appearance = mode === 'saved' ? (info.profile.appearance || 'DRAW') : mode === 'draw' ? 'DRAW' : 'TYPE';
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
function confirmAndSign() {
  // Each detail is asked once: a Title/Company field on the document is shown read-only for checking;
  // otherwise the box is pre-filled from this person's previous agreement, ready to verify.
  const fromField = (type) => fieldEls.find((o) => o.f.type === type);
  let prefilled = false;
  for (const [type, input] of [['title', $('#sgTitle')], ['company', $('#sgCompany')]]) {
    const field = fromField(type);
    const note = input.nextElementSibling?.classList.contains('verify-note') ? input.nextElementSibling : null;
    note?.remove();
    input.readOnly = !!field;
    input.classList.toggle('verified', !!field);
    if (field) {
      input.value = values[field.f.id] || '';
      input.insertAdjacentHTML('afterend', '<div class="verify-note small muted">✓ As entered in the document</div>');
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
  submit(reason, $('#sgTitle').value.trim(), $('#sgCompany').value.trim());
};

async function submit(reason, title, company) {
  $('#finishBtn').disabled = true;
  $('#finishBtn').textContent = 'Signing…';
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const r = await api(`/api/sign/${encodeURIComponent(token)}`, { method: 'POST', body: { consent: true, values, reason, title, company, tz, appearance } });
    window.scrollTo(0, 0);
    message('Signed successfully ✓', `
      <p>Thank you, ${esc(info.signer.name)}. Your signature on ${info.agreementId ? `agreement <strong>${esc(info.agreementId)}</strong>` : 'this agreement'} has been recorded.</p>
      <p class="muted">${r.completed
        ? 'All parties have signed. The completed agreement has been emailed to you as a PDF attachment.'
        : 'The completed agreement will be emailed to you as a PDF attachment once everyone has signed.'}
      This signing link is no longer valid.</p>`);
  } catch (e) {
    toast(e.message, 4000);
    $('#finishBtn').disabled = false;
    $('#finishBtn').textContent = 'Finish';
  }
}

$('#declineBtn').onclick = async () => {
  const reason = prompt('Decline to sign? The sender will be notified and the document will be cancelled.\nReason (optional):');
  if (reason === null) return;
  try {
    await api(`/api/sign/${encodeURIComponent(token)}/decline`, { method: 'POST', body: { reason } });
    message('You declined to sign', '<p class="muted">The sender has been notified.</p>');
  } catch (e) { toast(e.message); }
};

load();
