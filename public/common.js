// Shared helpers: PDF rendering, fetch wrapper, small UI utilities.
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

const FIELD_LABELS = { signature: 'Signature', initials: 'Initials', date: 'Date signed', name: 'Full name', text: 'Text', checkbox: '☐' };
// Default field size in PDF points.
const FIELD_SIZES = { signature: [170, 42], initials: [70, 36], date: [100, 22], name: [150, 22], text: [150, 22], checkbox: [18, 18] };

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
