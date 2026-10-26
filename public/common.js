// Shared helpers: PDF rendering, field catalog, date formatting, fetch wrapper, small UI utilities.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

// Field catalog: label, icon and default size in PDF points.
const FIELD_TYPES = {
  signature: { label: 'E-signature', icon: '✍', size: [180, 52] },
  initials: { label: 'Initials', icon: 'IN', size: [70, 36] },
  text: { label: 'Text', icon: 'T', size: [150, 22] },
  date: { label: 'Date of signing', icon: '📅', size: [110, 22] },
  name: { label: 'Recipient name', icon: '👤', size: [150, 22] },
  email: { label: 'Recipient email', icon: '✉', size: [170, 22] },
  datefield: { label: 'Date', icon: '🗓', size: [110, 22] },
  number: { label: 'Number', icon: '#', size: [90, 22] },
  checkbox: { label: 'Checkbox', icon: '☑', size: [16, 16] },
  radio: { label: 'Radio button', icon: '◉', size: [16, 16] },
  dropdown: { label: 'Drop-down menu', icon: '▾', size: [140, 22] },
  company: { label: 'Company', icon: '🏢', size: [170, 22] },
  title: { label: 'Title', icon: '🪪', size: [170, 22] },
};
const TEXT_LIKE = ['text', 'date', 'name', 'email', 'datefield', 'number', 'dropdown', 'company', 'title'];
const FONT_CSS = { Helvetica: 'Helvetica, Arial, sans-serif', Times: '"Times New Roman", Times, serif', Courier: '"Courier New", Courier, monospace' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatYMD(Y, M, D, fmt) {
  const mon = MONTHS[Number(M) - 1];
  switch (fmt) {
    case 'DD/MM/YYYY': return `${D}/${M}/${Y}`;
    case 'YYYY-MM-DD': return `${Y}-${M}-${D}`;
    case 'DD-MMM-YYYY': return `${D}-${mon.toUpperCase()}-${Y}`;
    case 'DD-Mon-YYYY': return `${D}-${mon}-${Y}`;
    case 'Mon DD, YYYY': return `${mon} ${D}, ${Y}`;
    case 'DD.MM.YYYY': return `${D}.${M}.${Y}`;
    default: return `${M}/${D}/${Y}`;
  }
}
function formatToday(fmt) {
  const d = new Date();
  return formatYMD(d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'), fmt);
}

async function renderPdf(url, container) {
  container.innerHTML = '<p class="muted">Loading document…</p>';
  const pdf = await pdfjsLib.getDocument(url).promise;
  container.innerHTML = '';
  const maxW = Math.min(900, container.clientWidth || 900);
  const dpr = window.devicePixelRatio || 1;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (maxW / base.width) * dpr });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.index = i - 1;
    el.style.width = `${maxW}px`;
    el.style.aspectRatio = `${base.width} / ${base.height}`;
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const layer = document.createElement('div');
    layer.className = 'layer';
    el.append(canvas, layer);
    container.append(el);
    pages.push({ el, layer, width: base.width, height: base.height, render: () => page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise });
  }
  // Layout is ready now; draw canvases one by one in the background so fields can be placed immediately.
  (async () => {
    for (const p of pages) await p.render();
  })().catch((e) => console.error(e));
  return pages;
}

// Small page preview, with an extra clockwise rotation applied.
async function renderThumb(pdfPage, canvas, extraRotation = 0, width = 140) {
  const rotation = (pdfPage.rotate + extraRotation) % 360;
  const base = pdfPage.getViewport({ scale: 1, rotation });
  const vp = pdfPage.getViewport({ scale: width / base.width, rotation });
  canvas.width = vp.width;
  canvas.height = vp.height;
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
}

async function api(url, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, init);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const $ = (sel, root = document) => root.querySelector(sel);

// Shows the company logo (public/logo.png) in the header when it exists.
function showLogo() {
  const img = new Image();
  img.onload = () => {
    const logo = $('.logo');
    if (!logo) return;
    img.alt = 'Logo';
    img.style.height = '32px';
    logo.querySelector('svg')?.replaceWith(img);
  };
  img.src = '/logo.png';
}
showLogo();
