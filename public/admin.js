const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
const app = $('#app');
const actions = $('#docActions');
let me = null;

const rid = () => Math.random().toString(36).slice(2, 10);

async function boot() {
  try {
    me = await api('/api/me');
    $('#company').textContent = `${me.company} eSign`;
    document.title = `${me.company} eSign`;
    $('#nav').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    route();
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
  if (m) openDoc(m[1]);
  else showList();
}

// ---------------- Document list ----------------
async function showList() {
  app.innerHTML = `
    <div class="wrap">
      <div class="drop" id="drop">
        <strong>Drop a PDF here</strong> or click to upload a document for signature
        <input type="file" id="file" accept="application/pdf" hidden>
      </div>
      <div class="card" style="margin-top:20px;padding:0">
        <table>
          <thead><tr><th>Document</th><th>Status</th><th>Recipients</th><th>Created</th></tr></thead>
          <tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  const drop = $('#drop');
  const input = $('#file');
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && uploadPdf(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) uploadPdf(f);
  };

  const docs = await api('/api/documents');
  $('#rows').innerHTML = docs.length
    ? docs.map((d) => `
      <tr class="click" data-id="${d.id}">
        <td><strong>${esc(d.title)}</strong></td>
        <td><span class="badge ${d.status}">${d.status}</span></td>
        <td class="small">${d.signers.map((s) => `${esc(s.name)} <span class="badge ${s.status}">${s.status}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="small muted">${when(d.createdAt)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">No documents yet. Upload a PDF to get started.</td></tr>';
  app.querySelectorAll('tr.click').forEach((tr) => (tr.onclick = () => (location.hash = `#/doc/${tr.dataset.id}`)));
}

async function uploadPdf(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const doc = await api('/api/documents', { method: 'POST', body: fd });
    location.hash = `#/doc/${doc.id}`;
  } catch (e) {
    toast(e.message);
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
function showEditor(doc) {
  let activeSigner = doc.signers[0]?.id || null;
  let placing = null;
  let selected = null;
  let pages = [];
  let saveTimer = null;

  actions.innerHTML = `
    <span id="saveState" class="small muted"></span>
    <button id="delDoc" class="ghost danger">Delete</button>
    <button id="sendBtn" class="primary">Send for signature</button>`;

  app.innerHTML = `
    <div class="editor">
      <aside class="sidebar">
        <section>
          <label for="title">Document title</label>
          <input id="title" value="${esc(doc.title)}">
          <label for="msg">Message to signers (optional)</label>
          <textarea id="msg" rows="3" placeholder="Please review and sign.">${esc(doc.message)}</textarea>
          <label for="order">Signing order</label>
          <select id="order">
            <option value="parallel">Everyone at once</option>
            <option value="sequential">One after another (in list order)</option>
          </select>
        </section>
        <section>
          <h3>Signers</h3>
          <div id="signers"></div>
          <button id="addSigner" style="width:100%">+ Add signer</button>
        </section>
        <section style="border:none">
          <h3>Fields</h3>
          <label for="activeSigner">Place fields for</label>
          <select id="activeSigner"></select>
          <div class="palette" style="margin-top:10px">
            ${Object.keys(FIELD_LABELS).map((t) => `<button data-type="${t}">${t === 'checkbox' ? '☑ Checkbox' : FIELD_LABELS[t]}</button>`).join('')}
          </div>
          <p class="small muted">Pick a field, then click on the page to drop it. Drag to move, use the corner to resize. Delete key removes the selected field.</p>
        </section>
      </aside>
      <div class="viewer" id="viewer"><div class="pages" id="pages"></div></div>
    </div>`;

  $('#order').value = doc.signingOrder;

  const colorOf = (sid) => COLORS[doc.signers.findIndex((s) => s.id === sid) % COLORS.length] || '#999';

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
        body: { title: doc.title, message: doc.message, signingOrder: doc.signingOrder, signers: doc.signers, fields: doc.fields },
      });
      $('#saveState').textContent = 'All changes saved';
    } catch (e) {
      $('#saveState').textContent = `Save failed: ${e.message}`;
      throw e;
    }
  }

  $('#title').oninput = (e) => { doc.title = e.target.value; scheduleSave(); };
  $('#msg').oninput = (e) => { doc.message = e.target.value; scheduleSave(); };
  $('#order').onchange = (e) => { doc.signingOrder = e.target.value; scheduleSave(); };

  function renderSigners() {
    $('#signers').innerHTML = doc.signers.map((s, i) => `
      <div class="signer-row" data-id="${s.id}">
        <span class="dot" style="background:${COLORS[i % COLORS.length]}"></span>
        <div>
          <input data-k="name" placeholder="Full name" value="${esc(s.name)}">
          <input data-k="email" type="email" placeholder="email@example.com" value="${esc(s.email)}">
        </div>
        <button class="ghost danger" data-rm title="Remove signer">✕</button>
      </div>`).join('') || '<p class="small muted">No signers yet.</p>';
    $('#signers').querySelectorAll('.signer-row').forEach((row) => {
      const s = doc.signers.find((x) => x.id === row.dataset.id);
      row.querySelectorAll('input').forEach((inp) => (inp.oninput = () => {
        s[inp.dataset.k] = inp.value;
        renderSignerSelect();
        scheduleSave();
      }));
      row.querySelector('[data-rm]').onclick = () => {
        doc.signers = doc.signers.filter((x) => x.id !== s.id);
        doc.fields = doc.fields.filter((f) => f.signerId !== s.id);
        if (activeSigner === s.id) activeSigner = doc.signers[0]?.id || null;
        renderSigners();
        renderSignerSelect();
        renderFields();
        scheduleSave();
      };
    });
  }
  function renderSignerSelect() {
    const sel = $('#activeSigner');
    sel.innerHTML = doc.signers.map((s, i) => `<option value="${s.id}">${i + 1}. ${esc(s.name || '(unnamed)')}</option>`).join('') || '<option value="">Add a signer first</option>';
    if (activeSigner) sel.value = activeSigner;
    sel.style.borderLeft = `6px solid ${activeSigner ? colorOf(activeSigner) : 'var(--line)'}`;
  }
  $('#activeSigner').onchange = (e) => { activeSigner = e.target.value; renderSignerSelect(); };
  $('#addSigner').onclick = () => {
    const s = { id: rid(), name: '', email: '' };
    doc.signers.push(s);
    activeSigner = s.id;
    renderSigners();
    renderSignerSelect();
    $(`.signer-row[data-id="${s.id}"] input`).focus();
    scheduleSave();
  };

  app.querySelectorAll('.palette button').forEach((b) => (b.onclick = () => {
    if (!activeSigner) return toast('Add a signer first');
    placing = placing === b.dataset.type ? null : b.dataset.type;
    app.querySelectorAll('.palette button').forEach((x) => x.classList.toggle('active', x.dataset.type === placing));
    $('#viewer').classList.toggle('placing', !!placing);
  }));

  function renderFields() {
    pages.forEach((p, pi) => {
      p.layer.innerHTML = '';
      doc.fields.filter((f) => f.page === pi).forEach((f) => p.layer.append(fieldEl(f, p)));
    });
  }

  function fieldEl(f, p) {
    const el = document.createElement('div');
    el.className = `field${selected === f.id ? ' sel' : ''}`;
    el.style.setProperty('--c', colorOf(f.signerId));
    const place = () => Object.assign(el.style, { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });
    place();
    const signer = doc.signers.find((s) => s.id === f.signerId);
    const initials = (signer?.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
    el.innerHTML = `<span>${f.type === 'checkbox' ? '' : `${FIELD_LABELS[f.type]} · ${esc(initials)}`}</span><button class="del" title="Delete">×</button><span class="grip"></span>`;
    el.title = `${FIELD_LABELS[f.type]} for ${signer?.name || 'signer'}${f.type === 'text' ? ' (double-click to set a label)' : ''}`;

    el.querySelector('.del').onpointerdown = (e) => e.stopPropagation();
    el.querySelector('.del').onclick = (e) => {
      e.stopPropagation();
      doc.fields = doc.fields.filter((x) => x !== f);
      renderFields();
      scheduleSave();
    };
    el.ondblclick = (e) => {
      e.stopPropagation();
      if (f.type !== 'text' && f.type !== 'checkbox') return;
      const label = prompt('Label shown to the signer:', f.label || '');
      if (label !== null) f.label = label;
      if (f.type === 'checkbox') f.required = confirm('Must the signer tick this checkbox?');
      scheduleSave();
    };
    el.onpointerdown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      selected = f.id;
      p.layer.querySelectorAll('.field').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      const resizing = e.target.classList.contains('grip');
      const rect = p.layer.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, f: { ...f } };
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.onpointermove = (ev) => {
        const dx = (ev.clientX - start.x) / rect.width;
        const dy = (ev.clientY - start.y) / rect.height;
        if (resizing) {
          f.w = Math.min(1 - f.x, Math.max(10 / p.width, start.f.w + dx));
          f.h = Math.min(1 - f.y, Math.max(10 / p.height, start.f.h + dy));
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      doc.fields = doc.fields.filter((x) => x.id !== selected);
      selected = null;
      renderFields();
      scheduleSave();
    }
    if (e.key === 'Escape') {
      placing = null;
      app.querySelectorAll('.palette button').forEach((x) => x.classList.remove('active'));
      $('#viewer').classList.remove('placing');
    }
  };

  $('#delDoc').onclick = async () => {
    if (!confirm('Delete this draft permanently?')) return;
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    location.hash = '#/';
  };

  $('#sendBtn').onclick = async () => {
    try {
      await save();
      const who = doc.signers.map((s) => `• ${s.name} <${s.email}>`).join('\n');
      if (!confirm(`Send "${doc.title}" for signature to:\n${who}\n\nThe document can't be edited after sending.`)) return;
      const sent = await api(`/api/documents/${doc.id}/send`, { method: 'POST' });
      toast(me.mail ? 'Sent! Invitations emailed.' : 'Sent! Copy each signer\'s link to share it.');
      showDetail(sent);
    } catch (e) {
      toast(e.message, 4000);
    }
  };

  renderSigners();
  renderSignerSelect();
  renderPdf(`/api/documents/${doc.id}/original`, $('#pages')).then((ps) => {
    pages = ps;
    pages.forEach((p, pi) => {
      p.layer.onpointerdown = (e) => {
        selected = null;
        p.layer.querySelectorAll('.field').forEach((x) => x.classList.remove('sel'));
        if (!placing || !activeSigner) return;
        const rect = p.layer.getBoundingClientRect();
        const [pw, ph] = FIELD_SIZES[placing];
        const w = pw / p.width;
        const h = ph / p.height;
        const x = Math.min(1 - w, Math.max(0, (e.clientX - rect.left) / rect.width - w / 2));
        const y = Math.min(1 - h, Math.max(0, (e.clientY - rect.top) / rect.height - h / 2));
        const f = { id: rid(), signerId: activeSigner, type: placing, page: pi, x, y, w, h, required: placing !== 'checkbox', label: '' };
        doc.fields.push(f);
        selected = f.id;
        renderFields();
        scheduleSave();
      };
    });
    renderFields();
  });
}

// ---------------- Sent / completed view ----------------
function showDetail(doc) {
  document.onkeydown = null;
  location.hash = `#/doc/${doc.id}`;
  const done = doc.status === 'completed';
  actions.innerHTML = `
    ${done ? `<a class="btn primary" href="/api/documents/${doc.id}/signed">Download signed PDF</a>` : ''}
    ${doc.status === 'sent' ? '<button id="voidBtn" class="danger">Void</button>' : ''}
    <button id="delDoc" class="ghost danger">Delete</button>`;

  app.innerHTML = `
    <div class="editor">
      <aside class="sidebar">
        <section>
          <h2>${esc(doc.title)}</h2>
          <span class="badge ${doc.status}">${doc.status}</span>
          <p class="small muted" style="margin:10px 0 0">Envelope ID: ${doc.id}<br>Sent ${when(doc.sentAt)}${done ? `<br>Completed ${when(doc.completedAt)}` : ''}</p>
          ${done ? `<p class="small muted" style="word-break:break-all">Signed file SHA-256:<br>${doc.finalHash}</p>` : ''}
        </section>
        <section>
          <h3>Signers${doc.signingOrder === 'sequential' ? ' (in order)' : ''}</h3>
          ${doc.signers.map((s) => `
            <div class="signer-row" style="grid-template-columns:12px 1fr">
              <span class="dot" style="background:${s.color}"></span>
              <div>
                <strong>${esc(s.name)}</strong> <span class="badge ${s.status}">${s.status}</span><br>
                <span class="small muted">${esc(s.email)}</span>
                ${s.signedAt ? `<div class="small muted">Signed ${when(s.signedAt)} · IP ${esc(s.ip)}</div>` : ''}
                ${doc.status === 'sent' && s.status !== 'signed' ? `
                  <div class="linkbox"><input readonly value="${esc(s.link)}"><button data-copy="${esc(s.link)}">Copy</button></div>
                  ${me.mail ? `<button class="ghost small" data-remind="${s.id}" style="padding:4px 0">Send reminder</button>` : ''}` : ''}
              </div>
            </div>`).join('')}
        </section>
        <section style="border:none">
          <h3>Audit trail</h3>
          <ul class="events">${doc.events.slice().reverse().map((e) => `<li><span class="muted small">${when(e.at)}</span><br>${esc(e.text)}</li>`).join('')}</ul>
        </section>
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
  $('#voidBtn') && ($('#voidBtn').onclick = async () => {
    const reason = prompt('Void this document? Signers will no longer be able to sign.\nReason (optional):');
    if (reason === null) return;
    showDetail(await api(`/api/documents/${doc.id}/void`, { method: 'POST', body: { reason } }));
  });
  $('#delDoc').onclick = async () => {
    if (!confirm('Delete this document and its audit trail permanently?')) return;
    await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
    location.hash = '#/';
  };

  renderPdf(done ? `/api/documents/${doc.id}/signed` : `/api/documents/${doc.id}/original`, $('#pages')).then((pages) => {
    if (done) return;
    pages.forEach((p, pi) => doc.fields.filter((f) => f.page === pi).forEach((f) => {
      const s = doc.signers.find((x) => x.id === f.signerId);
      const el = document.createElement('div');
      el.className = 'field';
      el.style.cssText = `--c:${s?.color};left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%;cursor:default`;
      el.textContent = f.value && f.type !== 'checkbox' ? (f.value === '[signed]' ? '✓ Signed' : f.value) : f.type === 'checkbox' ? '' : FIELD_LABELS[f.type];
      p.layer.append(el);
    }));
  });
}

boot();
