const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
const app = $('#app');
const actions = $('#docActions');
let me = null;

const rid = () => Math.random().toString(36).slice(2, 10);
const REMINDER_LABELS = { none: 'Never', daily: 'Every day', every2days: 'Every 2 days', weekly: 'Every week' };

async function boot() {
  try {
    me = await api('/api/me');
    $('#company').textContent = `${me.company} eSign`;
    document.title = `${me.company} eSign`;
    $('#nav').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    route();
    watchAgreements();
    setInterval(watchAgreements, 30000);
  } catch (e) {
    if (e.status === 401) showLogin();
    else app.innerHTML = `<div class="wrap card">${esc(e.message)}</div>`;
  }
}

function showLogin() {
  actions.innerHTML = '';
  app.innerHTML = `
    <div class="center-box card">
      <h1>Sign in</h1>
      <p class="muted">Administrator access to send documents for signature.</p>
      <form id="loginForm">
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password" required autofocus>
        <p id="loginErr" class="small" style="color:var(--danger)"></p>
        <button class="primary" style="width:100%">Sign in</button>
      </form>
    </div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  };
}

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.hash = '';
  location.reload();
};

window.addEventListener('hashchange', () => me && route());

function route() {
  const m = location.hash.match(/^#\/doc\/([\w-]+)/);
  actions.innerHTML = '';
  document.onkeydown = null;
  if (m) openDoc(m[1]);
  else if (location.hash === '#/system-log') showSystemLog();
  else showList();
}

// Sign-ins, failed logins, discarded drafts and test emails, with the hash-chain check.
async function showSystemLog() {
  app.innerHTML = '<div class="wrap card">Loading…</div>';
  const { integrity, entries } = await api('/api/system-log');
  app.innerHTML = `
    <div class="wrap">
      <div class="card">
        <h1>System audit log</h1>
        <p class="muted small">Actions not tied to one agreement: sign-ins, failed sign-in attempts, discarded drafts, test emails. Each agreement's own audit trail is on its page.</p>
        ${integrityHtml(integrity)}
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>IP / details</th></tr></thead>
          <tbody>${entries.map((e) => `<tr><td class="small">${when(e.at)}</td><td class="small">${esc(e.actor || '')}</td><td>${esc(e.text)}</td><td class="small muted">${esc(e.ip || '')}${e.detail ? `<br>${esc(e.detail)}` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No entries yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ---------------- Desktop notifications ----------------
// While the dashboard is open, shows a desktop notification when someone signs or declines, or an
// agreement is completed. Works in the browser, the installed app and the desktop app.
let lastSnapshot = null;
async function watchAgreements() {
  if (!('Notification' in window)) return;
  let docs;
  try {
    docs = await api('/api/documents');
  } catch {
    return;
  }
  const snap = Object.fromEntries(docs.map((d) => [d.id, d]));
  if (lastSnapshot && Notification.permission === 'granted') {
    for (const d of docs) {
      const old = lastSnapshot[d.id];
      if (!old) continue;
      const label = d.agreementId ? ` (${d.agreementId})` : '';
      d.signers.forEach((s, i) => {
        const was = old.signers[i]?.status;
        if (s.status !== was && (s.status === 'signed' || s.status === 'declined')) {
          notify(d.id, `${s.name} ${s.status} "${d.title}"`, s.status === 'signed' ? `Signer ${i + 1} of ${d.signers.length}${label}` : `The agreement can no longer be signed${label}.`);
        }
      });
      if (d.status === 'completed' && old.status !== 'completed') notify(d.id, `Completed: "${d.title}"`, `All parties have signed${label}. The signed PDF is ready.`);
    }
  }
  lastSnapshot = snap;
}

function notify(docId, title, body) {
  const n = new Notification(title, { body, icon: '/icons/icon-192.png', tag: `${docId}-${title}` });
  n.onclick = () => {
    window.focus();
    location.hash = `#/doc/${docId}`;
    n.close();
  };
}

// ---------------- Document list ----------------
async function showList() {
  app.innerHTML = `
    <div class="wrap">
      <div class="card row" style="margin-bottom:16px;padding:12px 16px;flex-wrap:wrap;${me.mail ? '' : 'background:#fffbeb;border-color:#fde68a'}">
        ${me.mail
          ? `<span style="flex:1;min-width:220px">✉️ <strong>Email is on.</strong> Signers get their links by email${me.notify ? `, and status updates go to ${esc(me.notify)}` : ''}.</span>
             <input id="testTo" type="email" placeholder="you@company.com" style="width:220px">
             <button id="testBtn">Send test email</button>`
          : `<span>⚠️ <strong>Email is off</strong>, so signers won't receive emails. Copy each signer's link from the document page, or add your email settings to the <code>.env</code> file and restart (see README).</span>`}
      </div>
      ${'Notification' in window && Notification.permission === 'default' ? `
        <div class="card row" style="margin-bottom:16px;padding:10px 16px;flex-wrap:wrap" id="notifyBar">
          <span style="flex:1;min-width:220px">🔔 Get a desktop notification when someone signs or an agreement is completed.</span>
          <button id="notifyBtn">Turn on notifications</button>
        </div>` : ''}
      <div class="drop" id="drop">
        <strong>Drop PDFs here</strong> or click to upload a document for signature
        <div class="small muted" style="margin-top:6px">Choose several PDFs to merge them into one document. You can reorder, rotate or delete pages afterwards.</div>
        <input type="file" id="file" accept="application/pdf" multiple hidden>
      </div>
      <div class="card" style="margin-top:20px;padding:0">
        <table>
          <thead><tr><th>Agreement ID</th><th>Document</th><th>Status</th><th>Recipients</th><th>Created</th></tr></thead>
          <tbody id="rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  if ($('#testBtn')) {
    $('#testBtn').onclick = async () => {
      $('#testBtn').disabled = true;
      try {
        await api('/api/test-email', { method: 'POST', body: { to: $('#testTo').value } });
        toast('Test email sent. Check your inbox (and junk folder).', 4000);
      } catch (e) {
        toast(e.message, 8000);
      }
      $('#testBtn').disabled = false;
    };
  }
  if ($('#notifyBtn')) {
    $('#notifyBtn').onclick = async () => {
      const result = await Notification.requestPermission();
      $('#notifyBar').remove();
      toast(result === 'granted' ? 'Desktop notifications are on' : 'Notifications were not allowed. You can change this in your browser settings.', 4000);
    };
  }
  const drop = $('#drop');
  const input = $('#file');
  drop.onclick = () => input.click();
  input.onchange = () => input.files.length && uploadPdfs([...input.files]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const files = [...e.dataTransfer.files].filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
    if (files.length) uploadPdfs(files);
  };

  const docs = await api('/api/documents');
  $('#rows').innerHTML = docs.length
    ? docs.map((d) => `
      <tr class="click" data-id="${d.id}">
        <td class="small" style="font-family:Consolas,monospace;white-space:nowrap">${d.agreementId ? esc(d.agreementId) : '<span class="muted">Draft</span>'}</td>
        <td><strong>${esc(d.title)}</strong></td>
        <td><span class="badge ${d.status}">${statusLabel(d.status)}</span></td>
        <td class="small">${d.signers.map((s, i) => `${i + 1}. ${esc(s.name)} <span class="badge ${s.status}">${s.status}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="small muted">${when(d.createdAt)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">No documents yet. Upload a PDF to get started.</td></tr>';
  app.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => (location.hash = `#/doc/${tr.dataset.id}`)));
}

async function uploadPdfs(files) {
  const fd = new FormData();
  files.forEach((f) => fd.append('file', f));
  toast(files.length > 1 ? `Merging ${files.length} files…` : 'Uploading…');
  try {
    const doc = await api('/api/documents', { method: 'POST', body: fd });
    location.hash = `#/doc/${doc.id}`;
  } catch (e) {
    toast(e.message, 5000);
  }
}

async function openDoc(id) {
  try {
    const doc = await api(`/api/documents/${id}`);
    if (doc.status === 'draft') showEditor(doc);
    else showDetail(doc);
  } catch (e) {
    app.innerHTML = `<div class="wrap card">${esc(e.message)} <a href="#/">Back</a></div>`;
  }
}

// ---------------- Draft editor ----------------
function newField(type, signerId, page, x, y, w, h, extra = {}) {
  return {
    id: rid(), signerId, type, page, x, y, w, h,
    required: !['checkbox', 'radio'].includes(type),
    label: '', dateFormat: 'MM/DD/YYYY',
    options: type === 'dropdown' ? ['Option 1', 'Option 2'] : [],
    group: type === 'radio' ? 'Group 1' : '',
    formula: '', decimals: 2,
    note: type === 'note' ? 'Please fill in all highlighted fields.' : '',
    style: { font: 'Helvetica', size: 'auto', color: '#000000', align: 'left' },
    ...extra,
  };
}

function showEditor(doc) {
  let activeSigner = doc.signers[0]?.id || null;
  let placing = null;
  let selected = null;
  let pages = [];
  let saveTimer = null;
  const open = { recipients: true, fields: true, message: false, settings: false, comments: doc.comments.some((c) => !c.resolved) };
  let pinning = false; // waiting for a click on the page to pin a comment
  let pendingPin = null; // { page, x, y } chosen for the next comment

  actions.innerHTML = `
    <span id="saveState" class="small muted"></span>
    <button id="pagesBtn">📄 Organize pages</button>
    <button id="delDoc" class="ghost danger" title="Drafts have not been sent, so they can be discarded">Discard draft</button>
    <button id="sendBtn" class="primary">Send</button>`;

  app.innerHTML = `
    <div class="editor">
      <aside class="sidebar" id="sidebar"></aside>
      <div class="viewer" id="viewer"><div class="pages" id="pages"></div></div>
    </div>
    <div id="ctxMenu" class="ctx hidden"></div>`;

  const signerIndex = (sid) => doc.signers.findIndex((s) => s.id === sid);
  const colorOf = (sid) => COLORS[signerIndex(sid) % COLORS.length] || '#999';
  const selField = () => doc.fields.find((f) => f.id === selected);

  function scheduleSave() {
    $('#saveState').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  }
  async function save() {
    clearTimeout(saveTimer);
    try {
      await api(`/api/documents/${doc.id}`, {
        method: 'PUT',
        body: {
          title: doc.title, message: doc.message, emailSubject: doc.emailSubject, signingOrder: doc.signingOrder,
          reminder: doc.reminder, requireReason: doc.requireReason !== false, stampPage: doc.stampPage !== false, digitalSign: doc.digitalSign !== false, signers: doc.signers, fields: doc.fields,
        },
      });
      $('#saveState').textContent = 'All changes saved';
    } catch (e) {
      $('#saveState').textContent = `Save failed: ${e.message}`;
      throw e;
    }
  }

  // ----- Sidebar -----
  function section(key, title, body) {
    return `<section class="acc ${open[key] ? 'open' : ''}" data-key="${key}">
      <button class="acc-head" data-acc="${key}">${title}<span>${open[key] ? '▴' : '▾'}</span></button>
      <div class="acc-body">${body}</div></section>`;
  }

  function renderSidebar() {
    const f = selField();
    if (f) return renderCustomize(f);
    const sb = $('#sidebar');
    sb.innerHTML =
      section('recipients', 'ADD RECIPIENTS', `
        <div id="signers">${doc.signers.map((s, i) => `
          <div class="signer-row sortable" data-id="${s.id}">
            <div class="order-col">
              <span class="grab" title="Drag to change signing order">⋮⋮</span>
              <span class="num" style="background:${COLORS[i % COLORS.length]}" title="Signer ${i + 1}">${i + 1}</span>
              <button class="ghost mini" data-up ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
              <button class="ghost mini" data-down ${i === doc.signers.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
            </div>
            <div>
              <span class="small muted">Full name</span>
              <input data-k="name" placeholder="e.g. Jane Doe" value="${esc(s.name)}">
              <span class="small muted">Email</span>
              <input data-k="email" type="email" placeholder="jane@company.com" value="${esc(s.email)}">
            </div>
            <button class="ghost danger" data-rm title="Remove recipient">✕</button>
          </div>`).join('') || '<p class="small muted">No recipients yet.</p>'}</div>
        <button id="addSigner" style="width:100%">+ Add recipient</button>
        <label for="order">Signing order</label>
        <select id="order">
          <option value="parallel">Everyone at once</option>
          <option value="sequential">One after another (in list order)</option>
        </select>
        ${doc.signers.length > 1 ? '<p class="small muted">Drag ⋮⋮ or use ▲▼ to change who signs 1st, 2nd, 3rd…</p>' : ''}`) +
      section('fields', 'ADD FIELDS', `
        <label for="activeSigner" style="margin-top:0">Fields for</label>
        <select id="activeSigner">${doc.signers.map((s, i) => `<option value="${s.id}">${i + 1}. ${esc(s.name || s.email || '(unnamed)')}</option>`).join('') || '<option value="">Add a recipient first</option>'}</select>
        <div class="palette">
          ${Object.entries(FIELD_TYPES).map(([t, d]) => `<button data-type="${t}" class="${placing === t ? 'active' : ''}"><span class="ico">${d.icon}</span>${d.label}</button>`).join('')}
        </div>
        <p class="small muted">Pick a field, then click on the page. Click a placed field to customize it; right-click for more options.</p>`) +
      section('message', 'ADD MESSAGE', `
        <label for="title" style="margin-top:0">Agreement name *</label>
        <input id="title" value="${esc(doc.title)}">
        <label for="subject">Email subject</label>
        <input id="subject" value="${esc(doc.emailSubject || '')}" placeholder="Please sign &quot;${esc(doc.title)}&quot;">
        <label for="msg">Email message</label>
        <textarea id="msg" rows="4" placeholder="Please review and complete &quot;${esc(doc.title)}&quot;.">${esc(doc.message)}</textarea>
        <label for="reminder">Send reminder</label>
        <select id="reminder">${Object.entries(REMINDER_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`) +
      section('settings', 'SETTINGS', `
        <label class="check"><input type="checkbox" id="reqReason"> Ask signers for a reason when they sign</label>
        <p class="small muted">The reason appears under each signature and in the audit report.</p>
        <label class="check"><input type="checkbox" id="stampPage"> Add a signature page for every signer</label>
        <p class="small muted">After the document: each signer's signature, email, title and company.</p>
        <label class="check"><input type="checkbox" id="digitalSign"> Digitally sign with certificates</label>
        <p class="small muted">Each signer gets a personal certificate and a cryptographic signature in the PDF, shown in Adobe's Signatures panel. <a href="/ca.cer">Root certificate</a></p>`) +
      section('comments', `COMMENTS (${doc.comments.filter((c) => !c.resolved).length} open)`, `
        <div id="commentList">${doc.comments.length ? doc.comments.map(commentHtml).join('') : '<p class="small muted">No comments yet. Discuss the draft with your team here before sending.</p>'}</div>
        <label for="cAuthor">Your name</label>
        <input id="cAuthor" value="${esc(authorName())}" placeholder="e.g. Pratik Shah">
        <label for="cText">Comment</label>
        <textarea id="cText" rows="3" placeholder="e.g. Please check the probe serial numbers on page 1"></textarea>
        <div class="row" style="margin-top:8px;justify-content:space-between">
          <button id="cPin" class="${pendingPin ? 'active' : ''}" title="Click, then click a spot on the document">📍 ${pendingPin ? `Pinned to page ${pendingPin.page + 1}` : 'Pin to page'}</button>
          <button id="cAdd" class="primary">Add comment</button>
        </div>
        <p class="small muted">Comments are kept in the audit trail and can't be deleted. They become read-only once sent.</p>`);

    sb.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => { open[b.dataset.acc] = !open[b.dataset.acc]; renderSidebar(); }));
    $('#order').value = doc.signingOrder;
    $('#order').onchange = (e) => { doc.signingOrder = e.target.value; scheduleSave(); };
    $('#reminder').value = doc.reminder || 'none';
    $('#reminder').onchange = (e) => { doc.reminder = e.target.value; scheduleSave(); };
    $('#reqReason').checked = doc.requireReason !== false;
    $('#reqReason').onchange = (e) => { doc.requireReason = e.target.checked; scheduleSave(); };
    $('#stampPage').checked = doc.stampPage !== false;
    $('#stampPage').onchange = (e) => { doc.stampPage = e.target.checked; scheduleSave(); };
    $('#digitalSign').checked = doc.digitalSign !== false;
    $('#digitalSign').onchange = (e) => { doc.digitalSign = e.target.checked; scheduleSave(); };
    $('#cAuthor').oninput = (e) => { try { localStorage.setItem('esign.author', e.target.value); } catch {} };
    $('#cPin').onclick = () => {
      pinning = !pinning && !pendingPin;
      pendingPin = null;
      $('#viewer').classList.toggle('placing', pinning);
      renderSidebar();
      if (pinning) toast('Now click the spot on the document to pin your comment');
    };
    $('#cAdd').onclick = async () => {
      const author = $('#cAuthor').value.trim();
      const text = $('#cText').value.trim();
      try {
        const c = await api(`/api/documents/${doc.id}/comments`, { method: 'POST', body: { author, text, ...(pendingPin || {}) } });
        doc.comments.push(c);
        pendingPin = null;
        renderSidebar();
        renderFields();
        toast('Comment added');
      } catch (e) { toast(e.message); }
    };
    sb.querySelectorAll('[data-resolve]').forEach((b) => (b.onclick = async () => {
      const c = doc.comments.find((x) => x.id === b.dataset.resolve);
      try {
        Object.assign(c, await api(`/api/documents/${doc.id}/comments/${c.id}/resolve`, { method: 'POST', body: { author: $('#cAuthor').value.trim(), resolved: !c.resolved } }));
        renderSidebar();
        renderFields();
      } catch (e) { toast(e.message); }
    }));
    $('#title').oninput = (e) => { doc.title = e.target.value; scheduleSave(); };
    $('#subject').oninput = (e) => { doc.emailSubject = e.target.value; scheduleSave(); };
    $('#msg').oninput = (e) => { doc.message = e.target.value; scheduleSave(); };

    const sel = $('#activeSigner');
    if (activeSigner) sel.value = activeSigner;
    sel.style.borderLeft = `6px solid ${activeSigner ? colorOf(activeSigner) : 'var(--line)'}`;
    sel.onchange = (e) => { activeSigner = e.target.value; renderSidebar(); };

    sb.querySelectorAll('.signer-row').forEach((row) => {
      const s = doc.signers.find((x) => x.id === row.dataset.id);
      row.querySelectorAll('input').forEach((inp) => (inp.oninput = () => { s[inp.dataset.k] = inp.value; scheduleSave(); }));
      // An email typed into the name box most likely belongs in the email box.
      row.querySelector('input[data-k="name"]').onblur = () => {
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.name.trim()) && !s.email.trim()) {
          s.email = s.name.trim();
          s.name = '';
          renderSidebar();
          scheduleSave();
          toast('Moved the email to the Email box. Please enter the full name.');
          $(`.signer-row[data-id="${s.id}"] input[data-k="name"]`).focus();
        } else renderSidebarSelectOnly();
      };
      // Reordering: drag by the ⋮⋮ handle, or use the arrow buttons.
      const move = (to) => {
        const from = doc.signers.indexOf(s);
        if (to < 0 || to >= doc.signers.length || to === from) return;
        doc.signers.splice(from, 1);
        doc.signers.splice(to, 0, s);
        renderSidebar();
        renderFields();
        scheduleSave();
      };
      row.querySelector('[data-up]').onclick = () => move(doc.signers.indexOf(s) - 1);
      row.querySelector('[data-down]').onclick = () => move(doc.signers.indexOf(s) + 1);
      row.querySelector('.grab').onpointerdown = () => (row.draggable = true);
      row.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      };
      row.ondragend = () => {
        row.draggable = false;
        row.classList.remove('dragging');
        sb.querySelectorAll('.signer-row').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
      };
      row.ondragover = (e) => {
        e.preventDefault();
        const below = e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
        row.classList.toggle('drop-below', below);
        row.classList.toggle('drop-above', !below);
      };
      row.ondragleave = () => row.classList.remove('drop-above', 'drop-below');
      row.ondrop = (e) => {
        e.preventDefault();
        const dragged = doc.signers.find((x) => x.id === e.dataTransfer.getData('text/plain'));
        if (!dragged || dragged === s) return;
        const below = row.classList.contains('drop-below');
        doc.signers.splice(doc.signers.indexOf(dragged), 1);
        doc.signers.splice(doc.signers.indexOf(s) + (below ? 1 : 0), 0, dragged);
        renderSidebar();
        renderFields();
        scheduleSave();
      };
      row.querySelector('[data-rm]').onclick = () => {
        doc.signers = doc.signers.filter((x) => x.id !== s.id);
        doc.fields = doc.fields.filter((f) => f.signerId !== s.id);
        if (activeSigner === s.id) activeSigner = doc.signers[0]?.id || null;
        renderSidebar();
        renderFields();
        scheduleSave();
      };
    });
    $('#addSigner').onclick = () => {
      const s = { id: rid(), name: '', email: '' };
      doc.signers.push(s);
      activeSigner = s.id;
      renderSidebar();
      $(`.signer-row[data-id="${s.id}"] input`).focus();
      scheduleSave();
    };
    sb.querySelectorAll('.palette button').forEach((b) => (b.onclick = () => {
      if (!activeSigner) return toast('Add a recipient first');
      placing = placing === b.dataset.type ? null : b.dataset.type;
      sb.querySelectorAll('.palette button').forEach((x) => x.classList.toggle('active', x.dataset.type === placing));
      $('#viewer').classList.toggle('placing', !!placing);
    }));
  }
  function renderSidebarSelectOnly() {
    const sel = $('#activeSigner');
    if (!sel) return;
    sel.innerHTML = doc.signers.map((s, i) => `<option value="${s.id}">${i + 1}. ${esc(s.name || s.email || '(unnamed)')}</option>`).join('');
    if (activeSigner) sel.value = activeSigner;
  }

  function renderCustomize(f) {
    const sb = $('#sidebar');
    const st = f.style;
    const auto = ['date', 'name', 'email', 'formula', 'note'].includes(f.type);
    sb.innerHTML = `
      <div class="row" style="margin-bottom:12px"><button class="ghost" id="backBtn">‹</button><h2 style="margin:0">Customize field</h2></div>
      <h3>Field assigned to</h3>
      <select id="cfSigner" style="border-left:6px solid ${colorOf(f.signerId)}">${doc.signers.map((s, i) => `<option value="${s.id}">${i + 1}. ${esc(s.name || s.email || '(unnamed)')}</option>`).join('')}</select>
      <h3 style="margin-top:16px">Customize field type</h3>
      <label for="cfType" style="margin-top:0">Field type</label>
      <select id="cfType">${Object.entries(FIELD_TYPES).map(([t, d]) => `<option value="${t}">${d.label}</option>`).join('')}</select>
      ${f.type === 'date' || f.type === 'datefield' ? `
        <label for="cfDate">Date format</label>
        <select id="cfDate">${me.dateFormats.map((d) => `<option>${d}</option>`).join('')}</select>` : ''}
      <label for="cfName">${f.type === 'radio' ? 'Option label' : 'Field name'}</label>
      <input id="cfName" value="${esc(f.label)}" placeholder="${esc(FIELD_TYPES[f.type].label)}">
      ${f.type === 'signature' ? `
        <label for="cfAppearance">Signature style</label>
        <select id="cfAppearance">
          <option value="standard">Handwritten, with name, time and reason below</option>
          <option value="digital">Digital ID stamp (like Adobe)</option>
        </select>
        <p class="small muted">Digital ID stamp: the name large on the left; "Digitally signed by", DN, reason and date on the right.</p>` : ''}
      ${f.type === 'formula' ? `
        <label for="cfFormula">Formula</label>
        <input id="cfFormula" value="${esc(f.formula)}" placeholder="{Qty} * {Price}" style="font-family:Consolas,monospace">
        <div id="cfFormulaMsg" class="small"></div>
        <p class="small muted">Use field names in braces with + - * / and ( ). Calculated automatically; the signer can't change it.
          ${(() => { const names = [...new Set(doc.fields.filter((x) => ['number', 'formula'].includes(x.type) && x.label && x.id !== f.id).map((x) => x.label))]; return names.length ? `<br>Number fields: ${names.map((n) => `<code>{${esc(n)}}</code>`).join(' ')}` : '<br>Give your Number fields a name first, e.g. Qty.'; })()}</p>
        <label for="cfDecimals">Decimal places</label>
        <select id="cfDecimals">${[0, 1, 2, 3, 4].map((n) => `<option>${n}</option>`).join('')}</select>` : ''}
      ${f.type === 'note' ? `
        <label for="cfNote">Note text for the signer</label>
        <textarea id="cfNote" rows="4">${esc(f.note)}</textarea>
        <p class="small muted">Shown to the signer as guidance. Not printed on the signed document.</p>` : ''}
      ${f.type === 'attachment' ? '<p class="small muted">The signer uploads a file (PDF, image, Word, Excel, text, CSV; max 10 MB). It is embedded in the signed PDF and covered by the signatures.</p>' : ''}
      ${f.type === 'stamp' ? '<p class="small muted">The signer uploads their company stamp or seal image, placed in this box.</p>' : ''}
      ${f.type === 'radio' ? `
        <label for="cfGroup">Radio group</label>
        <input id="cfGroup" value="${esc(f.group)}">
        <p class="small muted">Buttons with the same group name are one question; the signer picks one.</p>` : ''}
      ${f.type === 'dropdown' ? `
        <label for="cfOptions">Options (one per line)</label>
        <textarea id="cfOptions" rows="4">${esc(f.options.join('\n'))}</textarea>` : ''}
      ${auto ? (f.type === 'note' ? '' : '<p class="small muted">Filled in automatically when the recipient signs.</p>') : `
        <label class="check"><input type="checkbox" id="cfReq" ${f.required ? 'checked' : ''}> Required</label>`}
      ${TEXT_LIKE.includes(f.type) || f.type === 'checkbox' || f.type === 'radio' ? `
        <h3 style="margin-top:16px">Text format</h3>
        ${TEXT_LIKE.includes(f.type) ? `
          <select id="cfFont">${Object.keys(FONT_CSS).map((n) => `<option>${n}</option>`).join('')}</select>
          <div class="row" style="margin-top:8px">
            <select id="cfSize" style="width:90px"><option value="auto">Auto</option>${[8, 9, 10, 11, 12, 14, 16, 18, 20, 24].map((n) => `<option>${n}</option>`).join('')}</select>
            <input id="cfColor" type="color" value="${st.color}" style="width:44px;padding:2px">
            <div class="seg">${['left', 'center', 'right'].map((a) => `<button data-align="${a}" class="${st.align === a ? 'active' : ''}" title="Align ${a}">${{ left: '⯇', center: '≡', right: '⯈' }[a]}</button>`).join('')}</div>
          </div>` : `<div class="row"><span class="small">Mark color</span><input id="cfColor" type="color" value="${st.color}" style="width:44px;padding:2px"></div>`}` : ''}
      <h3 style="margin-top:16px">Advanced field actions</h3>
      <div class="actions-list">
        <button class="ghost" id="cfCopy">⧉ Copy field</button>
        <button class="ghost" id="cfAll">⎘ Copy field to all pages</button>
        <button class="ghost danger" id="cfDel">🗑 Delete field</button>
      </div>`;

    const changed = () => { renderFields(); scheduleSave(); };
    $('#backBtn').onclick = () => { selected = null; renderFields(); renderSidebar(); };
    $('#cfSigner').value = f.signerId;
    $('#cfSigner').onchange = (e) => { f.signerId = e.target.value; changed(); renderCustomize(f); };
    $('#cfType').value = f.type;
    $('#cfType').onchange = (e) => {
      const t = e.target.value;
      Object.assign(f, newField(t, f.signerId, f.page, f.x, f.y, f.w, f.h, { id: f.id, style: f.style, label: f.label }));
      changed();
      renderCustomize(f);
    };
    if ($('#cfDate')) { $('#cfDate').value = f.dateFormat; $('#cfDate').onchange = (e) => { f.dateFormat = e.target.value; changed(); }; }
    $('#cfName').oninput = (e) => { f.label = e.target.value; changed(); };
    if ($('#cfFormula')) {
      const showCheck = () => {
        const problem = Formula.check(f.formula);
        $('#cfFormulaMsg').textContent = f.formula ? (problem ? `⚠ ${problem}` : '✓ Formula looks good') : '';
        $('#cfFormulaMsg').style.color = problem ? 'var(--danger)' : 'var(--ok)';
      };
      $('#cfFormula').oninput = (e) => { f.formula = e.target.value; showCheck(); changed(); };
      $('#cfDecimals').value = String(f.decimals ?? 2);
      $('#cfDecimals').onchange = (e) => { f.decimals = Number(e.target.value); changed(); };
      showCheck();
    }
    if ($('#cfNote')) $('#cfNote').oninput = (e) => { f.note = e.target.value; changed(); };
    if ($('#cfAppearance')) { $('#cfAppearance').value = f.appearance || 'standard'; $('#cfAppearance').onchange = (e) => { f.appearance = e.target.value; changed(); }; }
    if ($('#cfGroup')) $('#cfGroup').oninput = (e) => { f.group = e.target.value; changed(); };
    if ($('#cfOptions')) $('#cfOptions').oninput = (e) => { f.options = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); changed(); };
    if ($('#cfReq')) $('#cfReq').onchange = (e) => { f.required = e.target.checked; changed(); };
    if ($('#cfFont')) { $('#cfFont').value = st.font; $('#cfFont').onchange = (e) => { st.font = e.target.value; changed(); }; }
    if ($('#cfSize')) { $('#cfSize').value = String(st.size); $('#cfSize').onchange = (e) => { st.size = e.target.value === 'auto' ? 'auto' : Number(e.target.value); changed(); }; }
    if ($('#cfColor')) $('#cfColor').oninput = (e) => { st.color = e.target.value; changed(); };
    $('#sidebar').querySelectorAll('[data-align]').forEach((b) => (b.onclick = () => { st.align = b.dataset.align; changed(); renderCustomize(f); }));
    $('#cfCopy').onclick = () => copyField(f);
    $('#cfAll').onclick = () => copyToAllPages(f);
    $('#cfDel').onclick = () => deleteField(f);
  }

  // ----- Field actions -----
  function copyField(f) {
    const c = { ...structuredClone(f), id: rid(), y: Math.min(1 - f.h, f.y + f.h + 0.01) };
    doc.fields.push(c);
    selected = c.id;
    renderFields();
    renderSidebar();
    scheduleSave();
    toast('Field copied');
  }
  function copyToAllPages(f) {
    let n = 0;
    pages.forEach((_, pi) => {
      if (pi === f.page) return;
      doc.fields.push({ ...structuredClone(f), id: rid(), page: pi });
      n++;
    });
    renderFields();
    scheduleSave();
    toast(n ? `Copied to ${n} other page${n > 1 ? 's' : ''}` : 'This document has only one page');
  }
  function deleteField(f) {
    doc.fields = doc.fields.filter((x) => x !== f);
    if (selected === f.id) selected = null;
    renderFields();
    renderSidebar();
    scheduleSave();
  }

  const ctx = $('#ctxMenu');
  const hideCtx = () => ctx.classList.add('hidden');
  document.addEventListener('click', hideCtx);
  function showCtx(f, x, y) {
    ctx.innerHTML = `<button data-a="copy">⧉ Copy field</button><button data-a="del">🗑 Delete field</button><button data-a="all">⎘ Copy field to all pages</button>`;
    Object.assign(ctx.style, { left: `${x}px`, top: `${y}px` });
    ctx.classList.remove('hidden');
    ctx.querySelector('[data-a=copy]').onclick = () => copyField(f);
    ctx.querySelector('[data-a=del]').onclick = () => deleteField(f);
    ctx.querySelector('[data-a=all]').onclick = () => copyToAllPages(f);
  }

  // ----- Fields on the page -----
  function renderFields() {
    pages.forEach((p, pi) => {
      p.layer.innerHTML = '';
      doc.fields.filter((f) => f.page === pi).forEach((f) => p.layer.append(fieldEl(f, p)));
      // Comment pins: click one to jump to its comment.
      doc.comments.filter((c) => c.page === pi).forEach((c, n) => {
        const pin = document.createElement('div');
        pin.className = `pin${c.resolved ? ' resolved' : ''}`;
        pin.style.left = `${c.x * 100}%`;
        pin.style.top = `${c.y * 100}%`;
        pin.textContent = '💬';
        pin.title = `${c.author}: ${c.text}`;
        pin.onpointerdown = (e) => {
          e.stopPropagation();
          open.comments = true;
          selected = null;
          renderSidebar();
          const el = document.querySelector(`[data-comment="${c.id}"]`);
          el?.scrollIntoView({ block: 'center' });
          el?.classList.add('flash');
          setTimeout(() => el?.classList.remove('flash'), 1500);
        };
        p.layer.append(pin);
      });
      if (pendingPin?.page === pi) {
        const pin = document.createElement('div');
        pin.className = 'pin';
        pin.style.left = `${pendingPin.x * 100}%`;
        pin.style.top = `${pendingPin.y * 100}%`;
        pin.textContent = '📍';
        p.layer.append(pin);
      }
    });
  }

  function fieldText(f) {
    if (f.type === 'checkbox' || f.type === 'radio') return '';
    if (f.type === 'signature' && f.appearance === 'digital') return 'Digital ID stamp';
    if (f.type === 'formula') return `= ${f.formula || 'formula'}`;
    if (f.type === 'note') return `🗒 ${f.note || 'Note'}`;
    if (f.type === 'attachment') return `📎 ${f.label || 'Attachment'}`;
    if (f.type === 'stamp') return `🔏 ${f.label || 'Stamp'}`;
    if (f.type === 'date') return `${FIELD_TYPES.date.label} (${f.dateFormat.toLowerCase()})`;
    if (f.type === 'datefield') return `${f.label || 'Date'} (${f.dateFormat.toLowerCase()})`;
    if (f.type === 'dropdown') return `${f.label || 'Select'} ▾`;
    return f.label || FIELD_TYPES[f.type].label;
  }

  function fieldEl(f, p) {
    const el = document.createElement('div');
    el.className = `field ftype-${f.type}${selected === f.id ? ' sel' : ''}`;
    el.style.setProperty('--c', colorOf(f.signerId));
    const place = () => Object.assign(el.style, { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });
    place();
    if (TEXT_LIKE.includes(f.type)) {
      el.style.fontFamily = FONT_CSS[f.style.font];
      el.style.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[f.style.align];
      el.style.fontSize = f.style.size === 'auto' ? '' : `${f.style.size * (p.layer.clientWidth / p.width)}px`;
    }
    const signer = doc.signers.find((s) => s.id === f.signerId);
    el.innerHTML = `${f.required && !['date', 'name', 'email'].includes(f.type) ? '<span class="req">*</span>' : ''}<span class="ftext">${esc(fieldText(f))}</span><span class="grip"></span>`;
    el.title = `${FIELD_TYPES[f.type].label}${f.label ? ` "${f.label}"` : ''} for ${signer?.name || 'recipient'}${f.type === 'radio' ? ` (group ${f.group})` : ''}`;

    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      selected = f.id;
      renderFields();
      renderSidebar();
      showCtx(f, e.clientX, e.clientY);
    };
    el.onpointerdown = (e) => {
      if (e.button === 2) return;
      e.stopPropagation();
      e.preventDefault();
      hideCtx();
      const wasSelected = selected === f.id;
      selected = f.id;
      p.layer.querySelectorAll('.field').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      if (!wasSelected) renderSidebar();
      const resizing = e.target.classList.contains('grip');
      const rect = p.layer.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, f: { ...f } };
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.onpointermove = (ev) => {
        const dx = (ev.clientX - start.x) / rect.width;
        const dy = (ev.clientY - start.y) / rect.height;
        if (resizing) {
          f.w = Math.min(1 - f.x, Math.max(8 / p.width, start.f.w + dx));
          f.h = Math.min(1 - f.y, Math.max(8 / p.height, start.f.h + dy));
        } else {
          f.x = Math.min(1 - f.w, Math.max(0, start.f.x + dx));
          f.y = Math.min(1 - f.h, Math.max(0, start.f.y + dy));
        }
        place();
      };
      el.onpointerup = () => {
        el.onpointermove = el.onpointerup = null;
        if (start.f.x !== f.x || start.f.y !== f.y || start.f.w !== f.w || start.f.h !== f.h) scheduleSave();
      };
    };
    return el;
  }

  document.onkeydown = (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) deleteField(selField());
    if (e.key === 'Escape') {
      placing = null;
      selected = null;
      hideCtx();
      $('#viewer').classList.remove('placing');
      renderFields();
      renderSidebar();
    }
  };

  $('#delDoc').onclick = async () => {
    if (!confirm('Discard this unsent draft? (Sent agreements can never be deleted, only cancelled.)')) return;
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    location.hash = '#/';
  };

  $('#sendBtn').onclick = async () => {
    try {
      await save();
      const list = doc.signers.map((s, i) => `${i + 1}. ${s.name} <${s.email}>`).join('\n');
      const how = doc.signingOrder === 'sequential' && doc.signers.length > 1
        ? 'Signer 1 gets the link now. Each next signer gets theirs only after the previous one signs.'
        : 'Everyone gets their link now.';
      if (!confirm(`Send "${doc.title}" for signature?\n\n${list}\n\n${how}\n\nThis creates an agreement with its own ID. It can't be edited or deleted after sending, only cancelled.`)) return;
      const sent = await api(`/api/documents/${doc.id}/send`, { method: 'POST' });
      toast(me.mail ? 'Sent! Invitations emailed.' : 'Sent! Copy each signer\'s link to share it.');
      showDetail(sent);
    } catch (e) {
      toast(e.message, 4000);
    }
  };

  $('#pagesBtn').onclick = async () => {
    await save().catch(() => {});
    showOrganizer(doc);
  };

  renderSidebar();
  renderPdf(`/api/documents/${doc.id}/original`, $('#pages')).then((ps) => {
    pages = ps;
    pages.forEach((p, pi) => {
      p.layer.onpointerdown = (e) => {
        hideCtx();
        if (pinning) {
          const rect = p.layer.getBoundingClientRect();
          pendingPin = { page: pi, x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
          pinning = false;
          $('#viewer').classList.remove('placing');
          open.comments = true;
          selected = null;
          renderFields();
          renderSidebar();
          $('#cText')?.focus();
          return;
        }
        const hadSelection = !!selected;
        selected = null;
        p.layer.querySelectorAll('.field').forEach((x) => x.classList.remove('sel'));
        if (!placing || !activeSigner) {
          if (hadSelection) renderSidebar();
          return;
        }
        const rect = p.layer.getBoundingClientRect();
        const [pw, ph] = FIELD_TYPES[placing].size;
        const w = pw / p.width;
        const h = ph / p.height;
        const x = Math.min(1 - w, Math.max(0, (e.clientX - rect.left) / rect.width - w / 2));
        const y = Math.min(1 - h, Math.max(0, (e.clientY - rect.top) / rect.height - h / 2));
        const extra = {};
        if (placing === 'radio') {
          const n = doc.fields.filter((f) => f.type === 'radio' && f.signerId === activeSigner).length;
          extra.label = `Option ${n + 1}`;
        }
        const f = newField(placing, activeSigner, pi, x, y, w, h, extra);
        doc.fields.push(f);
        selected = f.id;
        renderFields();
        renderSidebar();
        scheduleSave();
      };
    });
    renderFields();
  });
}

// ---------------- Organize pages / merge files ----------------
async function showOrganizer(doc) {
  document.onkeydown = null;
  const sources = { doc: await pdfjsLib.getDocument(`/api/documents/${doc.id}/original`).promise };
  const names = { doc: doc.title };
  let items = [];
  for (let i = 0; i < sources.doc.numPages; i++) items.push({ key: rid(), src: 'doc', index: i, rotate: 0 });
  const fieldsOn = (i) => doc.fields.filter((f) => f.page === i).length;

  actions.innerHTML = `
    <button id="orgCancel">Cancel</button>
    <button id="orgApply" class="primary">Apply changes</button>`;
  app.innerHTML = `
    <div class="wrap" style="max-width:1200px">
      <div class="card row" style="flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1;min-width:240px"><h2 style="margin:0">Organize pages</h2>
          <span class="small muted">Drag pages to reorder. Rotate or delete pages, or add more PDFs to merge them in.</span></div>
        <button id="addFiles">+ Add PDF files</button>
        <input type="file" id="moreFiles" accept="application/pdf" multiple hidden>
      </div>
      <div class="thumbs" id="thumbs"></div>
    </div>`;

  let dragKey = null;
  async function render() {
    const grid = $('#thumbs');
    grid.innerHTML = '';
    for (const [n, it] of items.entries()) {
      const card = document.createElement('div');
      card.className = 'thumb';
      card.draggable = true;
      const nf = it.src === 'doc' ? fieldsOn(it.index) : 0;
      card.innerHTML = `
        <div class="thumb-img"><canvas></canvas></div>
        <div class="thumb-bar">
          <strong>${n + 1}</strong>
          <span class="small muted" title="${esc(names[it.src])}">${it.src === 'doc' ? '' : '+ '}${esc(names[it.src]).slice(0, 14)}${nf ? ` · ${nf} field${nf > 1 ? 's' : ''}` : ''}</span>
        </div>
        <div class="thumb-tools">
          <button data-a="left" title="Move left">◀</button>
          <button data-a="ccw" title="Rotate left">⟲</button>
          <button data-a="cw" title="Rotate right">⟳</button>
          <button data-a="del" title="Delete page" class="danger">🗑</button>
          <button data-a="right" title="Move right">▶</button>
        </div>`;
      card.ondragstart = () => { dragKey = it.key; card.classList.add('dragging'); };
      card.ondragend = () => card.classList.remove('dragging');
      card.ondragover = (e) => e.preventDefault();
      card.ondrop = (e) => {
        e.preventDefault();
        const from = items.findIndex((x) => x.key === dragKey);
        if (from < 0 || from === n) return;
        const [moved] = items.splice(from, 1);
        items.splice(n, 0, moved);
        render();
      };
      card.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
        const a = b.dataset.a;
        if (a === 'cw') it.rotate = (it.rotate + 90) % 360;
        if (a === 'ccw') it.rotate = (it.rotate + 270) % 360;
        if (a === 'del') {
          if (items.length === 1) return toast('A document needs at least one page');
          items.splice(n, 1);
        }
        if (a === 'left' && n > 0) [items[n - 1], items[n]] = [items[n], items[n - 1]];
        if (a === 'right' && n < items.length - 1) [items[n + 1], items[n]] = [items[n], items[n + 1]];
        render();
      }));
      grid.append(card);
      const page = await sources[it.src].getPage(it.index + 1);
      await renderThumb(page, card.querySelector('canvas'), it.rotate);
    }
  }

  $('#addFiles').onclick = () => $('#moreFiles').click();
  $('#moreFiles').onchange = async () => {
    const fd = new FormData();
    [...$('#moreFiles').files].forEach((f) => fd.append('file', f));
    try {
      const added = await api(`/api/documents/${doc.id}/sources`, { method: 'POST', body: fd });
      for (const s of added) {
        sources[s.id] = await pdfjsLib.getDocument(`/api/documents/${doc.id}/sources/${s.id}`).promise;
        names[s.id] = s.name;
        for (let i = 0; i < s.pages; i++) items.push({ key: rid(), src: s.id, index: i, rotate: 0 });
      }
      toast(`Added ${added.length} file${added.length > 1 ? 's' : ''}`);
      render();
    } catch (e) {
      toast(e.message, 5000);
    }
    $('#moreFiles').value = '';
  };
  $('#orgCancel').onclick = () => openDoc(doc.id);
  $('#orgApply').onclick = async () => {
    const kept = new Set(items.filter((i) => i.src === 'doc').map((i) => i.index));
    const lost = doc.fields.filter((f) => !kept.has(f.page)).length;
    if (lost && !confirm(`${lost} field${lost > 1 ? 's are' : ' is'} on deleted pages and will be removed. Continue?`)) return;
    $('#orgApply').disabled = true;
    try {
      const updated = await api(`/api/documents/${doc.id}/pages`, { method: 'POST', body: { pages: items.map(({ src, index, rotate }) => ({ src, index, rotate })) } });
      toast('Pages updated');
      actions.innerHTML = '';
      showEditor(updated);
    } catch (e) {
      toast(e.message, 5000);
      $('#orgApply').disabled = false;
    }
  };
  render();
}

const authorName = () => { try { return localStorage.getItem('esign.author') || ''; } catch { return ''; } };

function commentHtml(c, readOnly) {
  return `<div class="comment${c.resolved ? ' resolved' : ''}" data-comment="${c.id}">
    <div class="meta"><strong>${esc(c.author)}</strong> · ${when(c.at)}${c.page != null ? ` · 📍 page ${c.page + 1}` : ''}${c.resolved ? ` · ✓ resolved by ${esc(c.resolvedBy || '')}` : ''}</div>
    <div style="white-space:pre-wrap;margin-top:3px">${esc(c.text)}</div>
    ${readOnly ? '' : `<button class="ghost small" data-resolve="${c.id}" style="padding:3px 0">${c.resolved ? 'Reopen' : '✓ Resolve'}</button>`}
  </div>`;
}

// Hash-chain check result shown above every audit trail.
function integrityHtml(r) {
  if (!r) return '';
  return r.ok
    ? `<p class="small chain-ok">✓ Audit trail intact: ${r.checked} entr${r.checked === 1 ? 'y' : 'ies'} verified by SHA-256 hash chain${r.unsealed ? ` (${r.unsealed} older entr${r.unsealed === 1 ? 'y' : 'ies'} from before sealing)` : ''}.</p>`
    : `<p class="small chain-bad">✗ AUDIT TRAIL TAMPERED: ${esc(r.reason)} (entry ${r.brokenAt + 1}).</p>`;
}

const statusLabel = (s) => ({ voided: 'cancelled', sent: 'out for signature' }[s] || s);

function cancelAgreement(doc) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal">
      <h2>Cancel agreement ${esc(doc.agreementId || '')}?</h2>
      <p class="muted">"${esc(doc.title)}" will be cancelled for good. Nobody will be able to sign it, and it stays in your records with its full audit trail.</p>
      <p class="small"><strong>Everyone below will get a cancellation email:</strong><br>${doc.signers.map((s) => `${s.order}. ${esc(s.name)} &lt;${esc(s.email)}&gt;`).join('<br>')}</p>
      ${me.mail ? '' : '<p class="small" style="color:var(--warn)">Email is off, so signers will not be emailed.</p>'}
      <label for="cancelReason">Reason for cancelling *</label>
      <textarea id="cancelReason" rows="3" maxlength="300" placeholder="e.g. Wrong version of the form was sent"></textarea>
      <div class="row end" style="margin-top:14px">
        <button id="cancelNo">Keep agreement</button>
        <button id="cancelYes" class="primary" style="background:var(--danger);border-color:var(--danger)">Cancel agreement</button>
      </div>
    </div>`;
  document.body.append(bg);
  $('#cancelReason').focus();
  $('#cancelNo').onclick = () => bg.remove();
  $('#cancelYes').onclick = async () => {
    const reason = $('#cancelReason').value.trim();
    if (!reason) return toast('Please enter a reason');
    $('#cancelYes').disabled = true;
    try {
      const updated = await api(`/api/documents/${doc.id}/void`, { method: 'POST', body: { reason } });
      bg.remove();
      toast(updated.notified ? `Agreement cancelled. ${updated.notified} signer${updated.notified > 1 ? 's' : ''} notified by email.` : 'Agreement cancelled.', 4000);
      showDetail(updated);
    } catch (e) {
      toast(e.message, 4000);
      $('#cancelYes').disabled = false;
    }
  };
}

// ---------------- Sent / completed view ----------------
function showDetail(doc) {
  document.onkeydown = null;
  location.hash = `#/doc/${doc.id}`;
  const done = doc.status === 'completed';
  // Agreements are never deleted; while out for signature they can only be cancelled.
  actions.innerHTML = `
    ${done ? `<a class="btn primary" href="/api/documents/${doc.id}/signed">Download signed PDF</a>` : ''}
    ${doc.status === 'sent' ? '<button id="voidBtn" class="danger">Cancel agreement</button>' : ''}`;
  const sequential = doc.signingOrder === 'sequential';
  const current = doc.signers.filter((s) => s.link).map((s) => s.order);

  app.innerHTML = `
    <div class="editor">
      <aside class="sidebar">
        <section>
          <div class="agr-id">${esc(doc.agreementId || '')}</div>
          <h2>${esc(doc.title)}</h2>
          <span class="badge ${doc.status}">${statusLabel(doc.status)}</span>
          <p class="small muted" style="margin:10px 0 0">Transaction ID: ${esc(doc.transactionId || doc.id)}<br>Sent ${when(doc.sentAt)}${done ? `<br>Completed ${when(doc.completedAt)}` : ''}
          ${doc.status === 'voided' ? `<br>Cancelled ${when(doc.cancelledAt)}${doc.cancelReason ? `<br>Reason: ${esc(doc.cancelReason)}` : ''}` : ''}
          ${doc.status === 'sent' ? `<br>Reminders: ${REMINDER_LABELS[doc.reminder || 'none']}` : ''}</p>
          ${done && doc.locked ? `<div class="locked">🔒 <strong>Locked.</strong> Certified by ${esc(me.company)} eSign: no changes allowed. Any edit breaks the signatures.</div>` : ''}
          ${done ? `<p class="small muted" style="word-break:break-all">Signed file SHA-256:<br>${doc.finalHash}</p>` : ''}
        </section>
        <section>
          <h3>Recipients${doc.signingOrder === 'sequential' ? ' (in order)' : ''}</h3>
          ${[...doc.signers].sort((a, b) => a.order - b.order).map((s) => `
            <div class="signer-row" style="grid-template-columns:auto 1fr">
              <span class="num" style="background:${s.color}" title="Signer ${s.order}">${s.order}</span>
              <div>
                <strong>${esc(s.name)}</strong> <span class="badge ${s.status}">${s.status}</span><br>
                <span class="small muted">${esc(s.email)}</span>
                ${s.signedAt ? `<div class="small muted">Signed ${when(s.signedAt)} · IP ${esc(s.ip)}${s.title || s.company ? `<br>${esc([s.title, s.company].filter(Boolean).join(', '))}` : ''}${s.reason ? `<br>Reason: ${esc(s.reason)}` : ''}</div>` : ''}
                ${doc.status === 'sent' && s.status !== 'signed' && s.link ? `
                  <div class="small" style="color:var(--ok);margin-top:4px">● ${sequential ? 'Their turn to sign now' : 'Can sign now'}</div>
                  <div class="linkbox"><input readonly value="${esc(s.link)}"><button data-copy="${esc(s.link)}">Copy</button></div>
                  ${me.mail ? `<button class="ghost small" data-remind="${s.id}" style="padding:4px 0">Send reminder</button>` : ''}` : ''}
                ${doc.status === 'sent' && s.status !== 'signed' && !s.link ? `
                  <div class="small muted" style="margin-top:4px">🔒 Waiting for signer ${current.join(', ')}. Their link is sent automatically after that.</div>` : ''}
              </div>
            </div>`).join('')}
        </section>
        <section style="border:none">
          <h3>Audit trail</h3>
          ${integrityHtml(doc.auditIntegrity)}
          <ul class="events">${doc.events.slice().reverse().map((e) => `<li><span class="muted small">${when(e.at)}${e.actor ? ` · ${esc(e.actor)}` : ''}</span><br>${esc(e.text)}${e.detail ? `<br><span class="small muted">${esc(e.detail)}</span>` : ''}</li>`).join('')}</ul>
        </section>
        ${doc.comments?.length ? `<section style="border:none">
          <h3>Comments before sending (${doc.comments.length})</h3>
          ${doc.comments.map((c) => commentHtml(c, true)).join('')}
        </section>` : ''}
      </aside>
      <div class="viewer"><div class="pages" id="pages"></div></div>
    </div>`;

  app.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast('Signing link copied');
  }));
  app.querySelectorAll('[data-remind]').forEach((b) => (b.onclick = async () => {
    try {
      await api(`/api/documents/${doc.id}/remind/${b.dataset.remind}`, { method: 'POST' });
      toast('Reminder sent');
    } catch (e) { toast(e.message); }
  }));
  $('#voidBtn') && ($('#voidBtn').onclick = () => cancelAgreement(doc));

  renderPdf(done ? `/api/documents/${doc.id}/signed` : `/api/documents/${doc.id}/original`, $('#pages')).then((pages) => {
    if (done) return;
    pages.forEach((p, pi) => doc.fields.filter((f) => f.page === pi).forEach((f) => {
      const s = doc.signers.find((x) => x.id === f.signerId);
      const el = document.createElement('div');
      el.className = `field ftype-${f.type}`;
      el.style.cssText = `--c:${s?.color};left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%;cursor:default`;
      el.textContent = f.value && !['checkbox', 'radio'].includes(f.type) ? (f.value === '[signed]' ? '✓ Signed' : f.value) : ['checkbox', 'radio'].includes(f.type) ? (f.value === 'true' ? '✓' : '') : (f.label || FIELD_TYPES[f.type]?.label || f.type);
      p.layer.append(el);
    }));
  });
}

boot();
