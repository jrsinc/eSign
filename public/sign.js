const token = new URLSearchParams(location.search).get('t') || '';
const app = $('#app');
const values = {};
const adopted = {}; // { signature: dataUrl, initials: dataUrl }
let info = null;
let fieldEls = [];

function message(title, body) {
  $('#bar').classList.add('hidden');
  app.innerHTML = `<div class="center-box card" style="max-width:520px;text-align:center"><h1>${title}</h1>${body}</div>`;
}

async function load() {
  try {
    info = await api(`/api/sign/${encodeURIComponent(token)}`);
  } catch (e) {
    return message('Link not valid', `<p class="muted">${esc(e.message)} Please contact the sender.</p>`);
  }
  $('#company').textContent = info.company;
  document.title = `Sign: ${info.title}`;
  const dl = info.hasFinal ? `<p><a class="btn primary" href="/api/sign/${encodeURIComponent(token)}/signed">Download signed copy</a></p>` : '';

  if (info.status === 'voided') return message('Document voided', '<p class="muted">The sender cancelled this document. No action is needed.</p>');
  if (info.status === 'declined') return message('Document declined', '<p class="muted">This document was declined and can no longer be signed.</p>');
  if (info.signer.status === 'signed') {
    return message('You have signed ✓', info.status === 'completed'
      ? `<p class="muted">All parties have signed <strong>${esc(info.title)}</strong>.</p>${dl}`
      : '<p class="muted">Thank you. We\'ll email you the completed copy once everyone has signed.</p>');
  }
  if (info.waitingOn.length) return message('Not your turn yet', `<p class="muted">This document is waiting for ${esc(info.waitingOn.join(', '))} to sign first. You'll get an email when it's your turn.</p>`);

  app.innerHTML = `
    <div class="wrap" style="max-width:960px">
      <div class="card" style="margin-bottom:16px">
        <h1 style="margin-bottom:4px">${esc(info.title)}</h1>
        <p class="muted" style="margin:0">Hi ${esc(info.signer.name)}, please review the document and complete the highlighted fields.</p>
        ${info.message ? `<p style="white-space:pre-line;margin:10px 0 0;padding:10px;background:#f9fafb;border-radius:8px">${esc(info.message)}</p>` : ''}
      </div>
      <div class="pages" id="pages"></div>
    </div>`;
  $('#bar').classList.remove('hidden');

  const pages = await renderPdf(`/api/sign/${encodeURIComponent(token)}/file`, $('#pages'));
  const today = new Date().toISOString().slice(0, 10);
  fieldEls = info.fields.map((f) => {
    const el = document.createElement('div');
    el.className = 'field signer-field';
    el.style.cssText = `--c:${info.signer.color};left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%`;
    el.dataset.id = f.id;
    if (f.type === 'date') { el.textContent = today; el.classList.add('done'); values[f.id] = today; }
    else if (f.type === 'name') { el.textContent = info.signer.name; el.classList.add('done'); values[f.id] = info.signer.name; }
    else if (f.type === 'text') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = f.label || (f.required ? 'Required' : 'Optional');
      inp.title = f.label || 'Text';
      inp.oninput = () => { values[f.id] = inp.value; el.classList.toggle('done', !!inp.value.trim()); updateProgress(); };
      el.append(inp);
    } else if (f.type === 'checkbox') {
      el.classList.add('cb');
      el.title = f.label || 'Checkbox';
      el.onclick = () => { values[f.id] = !values[f.id]; el.textContent = values[f.id] ? '✓' : ''; el.classList.toggle('done', values[f.id]); updateProgress(); };
      if (!f.required) el.classList.add('done');
    } else {
      el.textContent = f.type === 'signature' ? 'Click to sign' : 'Initial';
      el.onclick = () => (adopted[f.type] ? applySig(f.type) : openPad(f.type));
    }
    pages[f.page]?.layer.append(el);
    return { f, el };
  });
  updateProgress();
}

function remaining() {
  return fieldEls.filter(({ f }) => {
    if (f.type === 'signature' || f.type === 'initials') return !values[f.id];
    if (f.type === 'text') return f.required && !String(values[f.id] || '').trim();
    if (f.type === 'checkbox') return f.required && !values[f.id];
    return false;
  });
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

document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  mode = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== mode));
  if (mode === 'type') $('#typed').focus();
}));

function openPad(type) {
  padType = type;
  $('#modalTitle').textContent = type === 'signature' ? 'Adopt your signature' : 'Adopt your initials';
  const name = info.signer.name;
  $('#typed').value = type === 'signature' ? name : name.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
  $('#typedPreview').textContent = $('#typed').value;
  $('#modal').classList.remove('hidden');
  resetPad();
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
  if (mode === 'draw') {
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
  $('#finishBtn').disabled = true;
  $('#finishBtn').textContent = 'Signing…';
  try {
    const r = await api(`/api/sign/${encodeURIComponent(token)}`, { method: 'POST', body: { consent: true, values } });
    window.scrollTo(0, 0);
    if (r.completed) load();
    else message('You have signed ✓', '<p class="muted">Thank you. We\'ll email you the completed copy once everyone has signed.</p>');
  } catch (e) {
    toast(e.message, 4000);
    $('#finishBtn').disabled = false;
    $('#finishBtn').textContent = 'Finish';
  }
};

$('#declineBtn').onclick = async () => {
  const reason = prompt('Decline to sign? The sender will be notified and the document will be cancelled.\nReason (optional):');
  if (reason === null) return;
  try {
    await api(`/api/sign/${encodeURIComponent(token)}/decline`, { method: 'POST', body: { reason } });
    message('You declined to sign', '<p class="muted">The sender has been notified.</p>');
  } catch (e) { toast(e.message); }
};

load();
