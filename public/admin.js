const COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d'];
const app = $('#app');
const actions = $('#docActions');
let me = null;

const rid = () => Math.random().toString(36).slice(2, 10);
const REMINDER_LABELS = { none: 'Never', daily: 'Every day', every2days: 'Every 2 days', weekly: 'Every week' };

// Coming from a signing link that needs an account, or from "Log in to view" after signing: after
// sign-in, go straight there. Only this site's signing page or an agreement page is accepted, so the
// link can't send anyone elsewhere.
const params = new URLSearchParams(location.search);
const nextUrl = /^\/(sign\.html\?t=[\w-]+|#\/doc\/[\w-]+)$/.test(params.get('next') || '') ? params.get('next') : null;

let watcher = null;
async function boot() {
  try {
    me = await api('/api/me');
    if (nextUrl) return location.replace(nextUrl);
    $('#company').textContent = me.companyFull || me.company;
    document.title = `${me.app} – ${me.company}`;
    $('#nav').classList.remove('hidden');
    $('#logout').classList.remove('hidden');
    $('#adminMenu').classList.toggle('hidden', me.user.role !== 'admin');
    $('#serverMenu').classList.toggle('hidden', !me.user.systemAdmin);
    refreshTicketCount();
    $('#account').classList.remove('hidden');
    $('#account').textContent = `👤 ${me.user.name}`;
    $('#account').title = `${me.user.email} · ${me.user.role === 'admin' ? 'Administrator' : 'Sender'} · click for your profile`;
    route();
    if (!watcher) {
      watchAgreements();
      watcher = setInterval(watchAgreements, 30000);
    }
  } catch (e) {
    if (e.status === 401) showLogin(e.message !== 'Not logged in' ? e.message : '');
    else app.innerHTML = `<div class="wrap card">${esc(e.message)}</div>`;
  }
}

// Any request that finds the session gone (signed out after inactivity, disabled, …) returns to sign-in.
window.onUnauthorized = (message) => {
  if (!me) return;
  me = null;
  showLogin(message);
};

// ---------------- Sign-in: email + password, then a code sent by email ----------------
async function showLogin(notice = '') {
  me = null;
  actions.innerHTML = '';
  ['#nav', '#logout', '#account'].forEach((s) => $(s).classList.add('hidden'));
  const status = await api('/api/auth/status');
  $('#company').textContent = status.companyFull || status.company;
  if (status.setupRequired) return showSetup(status);
  app.innerHTML = `
    <div class="center-box card">
      <h1>Sign in</h1>
      <p class="muted">${esc(status.app)} for ${esc(status.companyFull || status.company)}. Use your own email address and password.</p>
      ${nextUrl ? `<p class="small identity">${nextUrl.startsWith('/#/doc/') ? 'Sign in to view your signed agreement.' : 'Sign in with the email the document was sent to. You\'ll go straight back to the document.'}</p>` : ''}
      ${notice ? `<p class="small" style="color:var(--warn)">${esc(notice)}</p>` : ''}
      <form id="loginForm">
        <label for="email">Email</label>
        <input id="email" type="email" autocomplete="username" required autofocus>
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password" required>
        <p id="loginErr" class="small" style="color:var(--danger)"></p>
        <button class="primary" style="width:100%">Continue</button>
      </form>
      <p class="small muted" style="margin-top:14px">${status.loginCode === false ? '' : 'Two-step sign-in: after your password, we email you a one-time code.<br>'}Forgot your password or locked out? <a href="#" id="helpPassword">Ask an administrator for help</a></p>
      <p class="small muted" style="margin:10px 0 0;text-align:center"><a href="/policy.html" target="_blank" rel="noopener">Policies and privacy</a></p>
    </div>`;
  if (nextUrl && params.get('email')) {
    $('#email').value = params.get('email');
    $('#pw').focus();
  }
  $('#helpPassword').onclick = (e) => {
    e.preventDefault();
    const email = $('#email').value.trim();
    if (!email) { toast('Type your email address first, then click again.', 4000); return $('#email').focus(); }
    raiseHelpTicket({ kind: 'password', email });
  };
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#loginForm button.primary');
    btn.disabled = true;
    try {
      const r = await api('/api/login', { method: 'POST', body: { email: $('#email').value, password: $('#pw').value } });
      // Sign-in codes turned off (testing): the password alone signed us in.
      if (r.signedIn) { location.hash = ''; return boot(); }
      showCodeStep(r);
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false;
    }
  };
}

function showCodeStep({ challenge, sentTo, minutes }) {
  app.innerHTML = `
    <div class="center-box card">
      <h1>Enter your sign-in code</h1>
      <p class="muted">We emailed a 6-digit code to <strong>${esc(sentTo)}</strong>. It expires in ${minutes} minutes.</p>
      <form id="codeForm">
        <label for="code">Code</label>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus
          style="font-size:24px;letter-spacing:8px;text-align:center;font-family:var(--font)" placeholder="000000">
        <p id="codeErr" class="small" style="color:var(--danger)"></p>
        <button class="primary" style="width:100%">Verify and sign in</button>
      </form>
      <div class="row" style="justify-content:space-between;margin-top:12px">
        <a href="#" id="back" class="small">← Use a different account</a>
        <a href="#" id="resend" class="small">Send a new code</a>
      </div>
      <p class="small muted" style="margin-top:12px">Can't find it? Check your junk / spam folder. Still not there? <a href="#" id="helpCode">Report a problem</a></p>
    </div>`;
  $('#helpCode').onclick = (e) => { e.preventDefault(); raiseHelpTicket({ kind: 'code', challenge }); };
  $('#back').onclick = (e) => { e.preventDefault(); showLogin(); };
  $('#resend').onclick = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login/resend', { method: 'POST', body: { challenge } });
      toast('A new code has been emailed');
    } catch (err) {
      if (err.restart) return showLogin(err.message);
      toast(err.message, 4000);
    }
  };
  $('#codeForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login/verify', { method: 'POST', body: { challenge, code: $('#code').value } });
      location.hash = '';
      boot();
    } catch (err) {
      if (err.restart) return showLogin(err.message);
      $('#codeErr').textContent = err.message;
      $('#code').select();
    }
  };
}

// Sign-in trouble: raises a support ticket for the administrators and shows its case number.
function raiseHelpTicket({ kind, challenge, email }) {
  const what = kind === 'code' ? 'Your sign-in code did not arrive.' : 'You forgot your password or your account is locked.';
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="max-width:440px">
      <h2>Report a problem</h2>
      <p class="small muted">${what} We'll open a support case and tell the administrators, who can check your account and fix it.</p>
      <label for="tkMsg">Anything to add? (optional)</label>
      <textarea id="tkMsg" rows="3" maxlength="1000" placeholder="e.g. I changed my email address last week"></textarea>
      <div class="row end" style="margin-top:12px"><button id="tkCancel">Cancel</button><button id="tkSend" class="primary">Open a support case</button></div>
    </div>`;
  document.body.append(bg);
  $('#tkMsg').focus();
  $('#tkCancel').onclick = () => bg.remove();
  $('#tkSend').onclick = async () => {
    $('#tkSend').disabled = true;
    try {
      const t = await api('/api/support/sign-in-help', { method: 'POST', body: { kind, challenge, email, message: $('#tkMsg').value } });
      bg.querySelector('.modal').innerHTML = `
        <h2>Support case opened</h2>
        <p>Your case number is</p>
        <p style="font-size:22px;font-weight:700;letter-spacing:.03em;margin:4px 0 12px">${esc(t.caseNo)}</p>
        <p class="small muted">${esc(t.kind)}. The administrators have been told and will fix it. Quote this number if you contact them. You'll get an email when it is resolved.</p>
        <div class="row end"><button id="tkDone" class="primary">OK</button></div>`;
      $('#tkDone').onclick = () => bg.remove();
    } catch (err) {
      $('#tkSend').disabled = false;
      toast(err.message, 5000);
    }
  };
}

// First run: no accounts yet. The setup password from .env proves ownership once.
function showSetup(status) {
  app.innerHTML = `
    <div class="center-box card" style="max-width:460px">
      <h1>Create the first administrator</h1>
      <p class="muted">${esc(status.app)} uses personal accounts: each person signs in with their own email, password and an emailed code.</p>
      <form id="setupForm">
        <label for="sPw">Setup password (ADMIN_PASSWORD in the .env file)</label>
        <input id="sPw" type="password" required autofocus>
        <label for="sName">Your full name</label>
        <input id="sName" required autocomplete="name">
        <label for="sEmail">Your email (this is your sign-in ID)</label>
        <input id="sEmail" type="email" required autocomplete="username">
        <label for="sNew">Choose your password</label>
        <input id="sNew" type="password" required autocomplete="new-password">
        <p class="small muted">At least 10 characters, with letters and numbers; not your name or email.</p>
        <p id="setupErr" class="small" style="color:var(--danger)"></p>
        <button class="primary" style="width:100%">Create account</button>
      </form>
    </div>`;
  $('#setupForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/setup', { method: 'POST', body: { adminPassword: $('#sPw').value, name: $('#sName').value, email: $('#sEmail').value, password: $('#sNew').value } });
      showLogin('Account created. Sign in with your email and new password.');
    } catch (err) { $('#setupErr').textContent = err.message; }
  };
}

$('#logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.hash = '';
  location.reload();
};

$('#account').onclick = () => { location.hash = '#/profile'; };

// Administrators change their own password from their profile; other users ask an administrator.
function changeOwnPassword() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal" style="max-width:420px">
      <h2>Change password</h2>
      <p class="small muted">${esc(me.user.name)} · ${esc(me.user.email)} · ${me.user.role === 'admin' ? 'Administrator' : 'Sender'}</p>
      <label for="cpCur">Current password</label>
      <input id="cpCur" type="password" autocomplete="current-password">
      <label for="cpNew">New password</label>
      <input id="cpNew" type="password" autocomplete="new-password">
      <p class="small muted">At least 10 characters, with letters and numbers; not your name or email. Other devices will be signed out.</p>
      <div class="row end" style="margin-top:12px"><button id="cpCancel">Cancel</button><button id="cpSave" class="primary">Change password</button></div>
    </div>`;
  document.body.append(bg);
  $('#cpCur').focus();
  $('#cpCancel').onclick = () => bg.remove();
  $('#cpSave').onclick = async () => {
    try {
      await api('/api/password/change', { method: 'POST', body: { current: $('#cpCur').value, next: $('#cpNew').value } });
      bg.remove();
      toast('Password changed');
    } catch (e) { toast(e.message, 4000); }
  };
}

window.addEventListener('hashchange', () => me && route());
// The Admin menu closes after choosing a page or clicking elsewhere.
document.addEventListener('click', (e) => {
  const menu = $('#adminMenu');
  if (menu?.open && (!menu.contains(e.target) || e.target.closest('.menu-list a'))) menu.open = false;
});

function route() {
  const m = location.hash.match(/^#\/doc\/([\w-]+)/);
  actions.innerHTML = '';
  document.onkeydown = null;
  if (m) openDoc(m[1]);
  else if (location.hash === '#/system-log' && me.user.role === 'admin') showSystemLog();
  else if (location.hash === '#/users' && me.user.role === 'admin') showUsers();
  else if (location.hash === '#/outside-signers' && me.user.role === 'admin') showOutsideSigners();
  else if (location.hash === '#/server' && me.user.systemAdmin) showServer();
  else if (location.hash === '#/companies' && me.user.role === 'admin') showCompanies();
  else if (location.hash === '#/backup' && me.user.role === 'admin') showBackup();
  else if (location.hash === '#/tickets' && me.user.role === 'admin') showTickets();
  else if (location.hash === '#/profile') showProfile();
  else showList();
}

// ---------------- Support tickets (administrators) ----------------
// Raised from the sign-in page. Fix the problem (Users page: correct the email, unlock, set a new
// password), then resolve the ticket with a note; the person is emailed.
async function refreshTicketCount(tickets) {
  if (me?.user.role !== 'admin') return;
  try {
    const list = tickets || (await api('/api/tickets'));
    const open = list.filter((t) => t.status === 'open').length;
    $('#ticketCount').textContent = open;
    $('#ticketCount').classList.toggle('hidden', !open);
  } catch {}
}

async function showTickets() {
  const tickets = await api('/api/tickets');
  refreshTicketCount(tickets);
  const open = tickets.filter((t) => t.status === 'open');
  const accountState = (t) => (!t.account ? '<span class="badge declined">no account</span>'
    : t.account.locked ? '<span class="badge declined">locked</span>'
    : t.account.status === 'disabled' ? '<span class="badge voided">deactivated</span>' : '<span class="badge completed">active</span>');
  app.innerHTML = `
    <div class="wrap" style="max-width:1100px">
      <div class="card" style="margin-bottom:16px">
        <h1>Support tickets</h1>
        <p class="muted small">Raised from the sign-in page when a sign-in code doesn't arrive or someone forgot their password, and by outside signers who ask for an account after signing. Fix the problem on the <a href="#/users">Users</a> page (correct the email, unlock, set a new password, or click <strong>Create account</strong>), then resolve the ticket with a note: the person is emailed. Creating the account resolves an account request by itself. ${open.length} open.</p>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Case</th><th>Opened</th><th>Person</th><th>Problem</th><th>Status</th><th></th></tr></thead>
          <tbody>${tickets.length ? tickets.map((t) => `
            <tr data-id="${t.id}">
              <td style="white-space:nowrap"><strong>${esc(t.caseNo)}</strong></td>
              <td class="small muted">${when(t.createdAt)}</td>
              <td class="small">${t.name ? `<strong>${esc(t.name)}</strong><br>` : ''}${esc(t.email)}<br>${accountState(t)}</td>
              <td class="small">${esc(t.kindLabel)}${t.message ? `<br><span class="muted">"${esc(t.message)}"</span>` : ''}<br><span class="muted">${esc(t.ip || '')} · ${esc(t.device || '')}</span></td>
              <td class="small">${t.status === 'open' ? '<span class="badge sent">open</span>' : `<span class="badge completed">resolved</span><br><span class="muted">${when(t.resolvedAt)} by ${esc(t.resolvedBy)}<br>${esc(t.resolution)}</span>`}</td>
              <td style="white-space:nowrap">${t.status === 'open' ? `${t.kind === 'account' && !t.account ? '<button class="small" data-create>Create account</button> ' : ''}<button class="primary small" data-resolve>Resolve</button>` : ''}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">No support tickets.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  app.querySelectorAll('[data-create]').forEach((b) => (b.onclick = () => {
    const t = tickets.find((x) => x.id === b.closest('tr').dataset.id);
    createAccountFor(t.name, t.email);
  }));
  app.querySelectorAll('[data-resolve]').forEach((b) => (b.onclick = async () => {
    const t = tickets.find((x) => x.id === b.closest('tr').dataset.id);
    const note = prompt(`Resolve ${t.caseNo} for ${t.email}.\n\nWhat was done? (emailed to the person and kept in the system log)`, { code: 'Email address corrected; please sign in again.', password: 'New password set; I will give it to you privately.', account: 'No account needed: please keep signing with the temporary password emailed to you.' }[t.kind] || '');
    if (note === null) return;
    try {
      await api(`/api/tickets/${t.id}/resolve`, { method: 'POST', body: { note } });
      toast(`${t.caseNo} resolved`);
      showTickets();
    } catch (e) { toast(e.message, 4000); }
  }));
}

// ---------------- My profile ----------------
// Name, ID and email come from the account (administrators change them). The person sets their title,
// company and a default signature, which the signing page offers them to confirm when they sign.
async function showProfile() {
  const p = await api('/api/profile');
  let signature = p.signature;
  const companyOptions = p.companies.length
    ? `<select id="pfCompanySel"><option value="">Choose…</option>${p.companies.map((c) => `<option ${c === p.company ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="__other" ${p.company && !p.companies.includes(p.company) ? 'selected' : ''}>Other (type the company name)</option></select>
       <input id="pfCompany" maxlength="120" placeholder="Type the company name" style="margin-top:6px" value="${esc(p.companies.includes(p.company) ? '' : p.company)}">`
    : `<input id="pfCompany" maxlength="120" value="${esc(p.company)}">`;
  app.innerHTML = `
    <div class="wrap" style="max-width:760px">
      <div class="card" style="margin-bottom:16px">
        <h1>My profile</h1>
        <table class="sign-summary" style="max-width:560px">
          <tr><th>User name</th><td>${esc(p.name)}</td></tr>
          <tr><th>User ID</th><td>${esc(p.id)}</td></tr>
          <tr><th>Email (sign-in ID)</th><td>${esc(p.email)}</td></tr>
          <tr><th>Access</th><td>${p.role === 'admin' ? 'Administrator (full access)' : 'Sender'}</td></tr>
          <tr><th>Member since</th><td>${when(p.createdAt)}</td></tr>
        </table>
        <p class="small muted" style="margin:0">Your name and email are set by an administrator. ${p.role === 'admin' ? '' : 'To change them or your password, ask your administrator.'}</p>
        ${p.role === 'admin' ? '<button id="pfPassword" style="margin-top:12px">Change my password</button>' : ''}
      </div>
      <div class="card">
        <h2>Signing details</h2>
        <p class="small muted">Used when you sign: they appear with your signature, and the signing page fills them in for you to check.</p>
        <label for="pfTitle">Title</label>
        <input id="pfTitle" maxlength="120" placeholder="e.g. QA Manager" value="${esc(p.title)}">
        <label for="${p.companies.length ? 'pfCompanySel' : 'pfCompany'}">Company name</label>
        ${companyOptions}
        <label style="margin-top:16px">Default signature</label>
        <div id="pfSigCurrent"></div>
        <canvas id="pfPad" class="profile-pad hidden"></canvas>
        <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap" id="pfSigTools"></div>
        <div class="row end" style="margin-top:18px"><button id="pfSave" class="primary">Save profile</button></div>
      </div>
    </div>`;
  if ($('#pfPassword')) $('#pfPassword').onclick = changeOwnPassword;

  // Company: the administrators' list, or "Other" to type a name.
  const sel = $('#pfCompanySel');
  const other = $('#pfCompany');
  const syncCompany = () => { if (sel) other.hidden = sel.value !== '__other'; };
  if (sel) { sel.onchange = () => { syncCompany(); if (!other.hidden) other.focus(); }; syncCompany(); }
  const companyValue = () => (sel ? (sel.value === '__other' ? other.value.trim() : sel.value) : other.value.trim());

  // Default signature: shown when saved; "Draw a new signature" opens the pad.
  const pad = $('#pfPad');
  let inked = false;
  const showSig = () => {
    $('#pfSigCurrent').innerHTML = signature
      ? `<div style="padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff;max-width:520px"><img class="profile-sig" src="${signature}" alt="Your default signature"></div>`
      : '<p class="small muted" style="margin:0">No default signature yet.</p>';
    pad.classList.add('hidden');
    $('#pfSigTools').innerHTML = `<button id="pfDraw">${signature ? 'Draw a new signature' : 'Draw my signature'}</button>${signature ? '<button id="pfRemove" class="ghost danger">Remove</button>' : ''}`;
    $('#pfDraw').onclick = startDrawing;
    if ($('#pfRemove')) $('#pfRemove').onclick = () => { signature = null; showSig(); toast('Removed. Save your profile to keep this change.'); };
  };
  const startDrawing = () => {
    pad.classList.remove('hidden');
    const ratio = window.devicePixelRatio || 1;
    pad.width = pad.clientWidth * ratio;
    pad.height = pad.clientHeight * ratio;
    const g = pad.getContext('2d');
    g.scale(ratio, ratio);
    Object.assign(g, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0b1a4d' });
    inked = false;
    let drawing = false;
    const at = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    pad.onpointerdown = (e) => { drawing = true; pad.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...at(e)); };
    pad.onpointermove = (e) => { if (!drawing) return; g.lineTo(...at(e)); g.stroke(); inked = true; };
    pad.onpointerup = () => { drawing = false; };
    $('#pfSigTools').innerHTML = '<span class="small muted" style="align-self:center">Sign in the box with your mouse, finger or stylus.</span><button id="pfClear" class="ghost">Clear</button><button id="pfUse" class="primary">Use this signature</button><button id="pfCancel" class="ghost">Cancel</button>';
    $('#pfClear').onclick = () => { g.clearRect(0, 0, pad.width, pad.height); inked = false; };
    $('#pfCancel').onclick = showSig;
    $('#pfUse').onclick = () => {
      if (!inked) return toast('Please draw your signature first');
      signature = trimCanvas(pad);
      showSig();
      toast('Signature ready. Save your profile to keep it.');
    };
  };
  showSig();

  $('#pfSave').onclick = async () => {
    try {
      await api('/api/profile', { method: 'PUT', body: { title: $('#pfTitle').value, company: companyValue(), signature } });
      toast('Profile saved');
    } catch (e) { toast(e.message, 4000); }
  };
}

// Crops a drawn signature to its ink, so it fills a signature field.
function trimCanvas(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
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

// ---------------- Company list (administrators) ----------------
// Signers pick their company from this list, or choose "Other" and type it.
async function showCompanies() {
  const list = await api('/api/companies');
  app.innerHTML = `
    <div class="wrap" style="max-width:760px">
      <div class="card" style="margin-bottom:16px">
        <h1>Companies</h1>
        <p class="muted small">When a signer fills in their company (a Company field, or the details asked before signing), they choose from this list. If theirs isn't listed, they pick <strong>Other</strong> and type it. With an empty list, signers simply type their company.</p>
        <form id="addCompany" class="row" style="align-items:flex-end">
          <div style="flex:1"><label for="coName">Company name</label><input id="coName" maxlength="120" required placeholder="e.g. Jupiter Research Services Inc"></div>
          <button class="primary">Add company</button>
        </form>
      </div>
      <div class="card" style="padding:0">
        <table>
          <thead><tr><th>Company</th><th>Added</th><th></th></tr></thead>
          <tbody>${list.length ? list.map((c) => `
            <tr data-id="${c.id}">
              <td><strong>${esc(c.name)}</strong></td>
              <td class="small muted">${when(c.createdAt)}</td>
              <td class="small" style="white-space:nowrap;text-align:right">
                <button class="ghost small" data-act="rename">Edit</button>
                <button class="ghost small danger" data-act="remove">Delete</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="3" class="muted" style="text-align:center;padding:24px">No companies yet. Signers will type their company name.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  $('#coName').focus();
  $('#addCompany').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const c = await api('/api/companies', { method: 'POST', body: { name: $('#coName').value } });
      await showCompanies();
      toast(`${c.name} added`);
    } catch (err) { toast(err.message, 4000); }
  };
  app.querySelectorAll('tr[data-id]').forEach((tr) => {
    const c = list.find((x) => x.id === tr.dataset.id);
    tr.querySelector('[data-act=rename]').onclick = async () => {
      const name = prompt('Company name:', c.name);
      if (name === null || name.trim() === c.name) return;
      try {
        await api(`/api/companies/${c.id}`, { method: 'PUT', body: { name } });
        await showCompanies();
        toast('Company updated');
      } catch (err) { toast(err.message, 4000); }
    };
    tr.querySelector('[data-act=remove]').onclick = async () => {
      if (!confirm(`Delete "${c.name}" from the list?\n\nAgreements already signed keep the company name entered at the time.`)) return;
      try {
        await api(`/api/companies/${c.id}`, { method: 'DELETE' });
        await showCompanies();
        toast('Company deleted');
      } catch (err) { toast(err.message, 4000); }
    };
  });
}

// ---------------- Backup and restore (administrators) ----------------
async function showBackup() {
  const b = await api('/api/backups');
  const sch = b.schedule;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const st = b.state || {};
  app.innerHTML = `
    <div class="wrap" style="max-width:900px">
      <div class="card" style="margin-bottom:16px">
        <h1>Backup</h1>
        <p class="muted small">One file with everything: agreements and their PDFs, users, companies, saved signer details, the certificate keys for digital signatures, and the system log. Keep backups somewhere safe and private: they contain confidential documents and the keys that sign them.</p>
        <div class="row" style="flex-wrap:wrap"><a class="btn primary" href="/api/backup" id="dlBackup">⬇ Download backup to this computer</a><button id="runBackup">Save a backup on the server now</button></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h2>Automatic backups</h2>
        <p class="muted small">Saved in the backups folder on the server (<code style="word-break:break-all">${esc(b.folder)}</code>) and listed below to download. Times are the server's time (${esc(b.timeZone)}, now ${esc(new Date(b.serverTime).toLocaleString([], { timeZone: b.timeZone, dateStyle: 'medium', timeStyle: 'short' }))}). Only administrators can change this.</p>
        <div class="row" style="flex-wrap:wrap;align-items:flex-end">
          <div><label for="bkFreq">How often</label><select id="bkFreq">
            <option value="off">Off</option><option value="hours">Every few hours</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></div>
          <div data-for="hours"><label for="bkHours">Every</label><select id="bkHours">${[1, 2, 3, 4, 6, 8, 12].map((h) => `<option value="${h}" ${sch.hours === h ? 'selected' : ''}>${h} hour${h > 1 ? 's' : ''}</option>`).join('')}</select></div>
          <div data-for="weekly"><label for="bkDay">On</label><select id="bkDay">${days.map((d, i) => `<option value="${i}" ${sch.day === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
          <div data-for="daily weekly"><label for="bkTime">At (server time)</label><input id="bkTime" type="time" value="${esc(sch.time || '02:00')}"></div>
          <div data-for="hours daily weekly"><label for="bkKeep">Keep the newest</label><input id="bkKeep" type="number" min="1" max="365" value="${sch.keep || 14}" style="width:90px"></div>
          <button class="primary" id="bkSave">Save schedule</button>
        </div>
        <p class="small" style="margin-top:10px">${sch.frequency === 'off' ? '<span class="badge voided">off</span> No automatic backups.' : `<span class="badge completed">on</span> Next backup: <strong>${when(b.nextAt)}</strong>.`}
          ${st.lastAutoAt ? ` Last automatic backup: ${when(st.lastAutoAt)} ${st.lastResult === 'ok' ? '✓' : `<span style="color:var(--danger)">FAILED: ${esc(st.lastError || '')}</span>`}` : ''}
          ${sch.updatedBy ? `<br><span class="muted">Schedule set by ${esc(sch.updatedBy)}, ${when(sch.updatedAt)}.</span>` : sch.custom ? '' : '<br><span class="muted">Default schedule (not changed yet).</span>'}</p>
      </div>
      <div class="card" style="margin-bottom:16px;padding:0;overflow-x:auto">
        <h2 style="padding:16px 16px 0">Backups on the server</h2>
        <table>
          <thead><tr><th>When</th><th>Type</th><th>File</th><th>Size</th><th></th></tr></thead>
          <tbody>${b.files.length ? b.files.map((f) => `<tr><td class="small">${when(f.at)}</td><td class="small">${esc(f.kind)}</td><td class="small">${esc(f.name)}</td><td class="small">${mb(f.size)}</td><td><a class="btn small" href="/api/backups/file/${encodeURIComponent(f.name)}">⬇ Download</a></td></tr>`).join('')
            : '<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">No backups saved on the server yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h2>Backup log</h2>
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>${b.log.map((e) => `<tr><td class="small">${when(e.at)}</td><td class="small">${esc(e.actor || '')}</td><td class="small">${esc(e.text)}${e.detail ? `<br><span class="muted">${esc(e.detail)}</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No backup activity yet.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="card">
        <h2>Restore from a backup</h2>
        <p class="muted small">Replaces <strong>all</strong> current data with the backup. Before restoring, the current data is saved automatically as a restore point in the <code>backups</code> folder on the server. Everyone is signed out afterwards and signs in with the accounts in the backup.</p>
        <label for="rsFile">Backup file (.esbackup)</label>
        <input id="rsFile" type="file" accept=".esbackup">
        <div id="rsInfo"></div>
      </div>
    </div>`;
  $('#dlBackup').onclick = () => setTimeout(() => { toast('Backup downloading'); setTimeout(showBackup, 1500); }, 300);
  $('#runBackup').onclick = async () => {
    $('#runBackup').disabled = true;
    try {
      const r = await api('/api/backups/run', { method: 'POST' });
      toast(`Backup saved: ${r.name}`, 4000);
      showBackup();
    } catch (e) { $('#runBackup').disabled = false; toast(e.message, 5000); }
  };
  $('#bkFreq').value = sch.frequency;
  const showFor = () => app.querySelectorAll('[data-for]').forEach((el) => el.classList.toggle('hidden', !el.dataset.for.split(' ').includes($('#bkFreq').value)));
  $('#bkFreq').onchange = showFor;
  showFor();
  $('#bkSave').onclick = async () => {
    try {
      await api('/api/backups/schedule', { method: 'PUT', body: { frequency: $('#bkFreq').value, hours: Number($('#bkHours').value), day: Number($('#bkDay').value), time: $('#bkTime').value, keep: Number($('#bkKeep').value) } });
      toast('Backup schedule saved');
      showBackup();
    } catch (e) { toast(e.message, 5000); }
  };
  $('#rsFile').onchange = async () => {
    const file = $('#rsFile').files[0];
    $('#rsInfo').innerHTML = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    let info;
    try {
      info = await api('/api/restore/check', { method: 'POST', body: fd });
    } catch (err) {
      $('#rsInfo').innerHTML = `<p class="small" style="color:var(--danger)">${esc(err.message)}</p>`;
      return;
    }
    $('#rsInfo').innerHTML = `
      <div class="card" style="margin-top:12px;border-color:#fde68a;background:#fffbeb">
        <strong>Backup of ${esc(info.company)}</strong>
        <p class="small" style="margin:6px 0">Made ${when(info.createdAt)} by ${esc(info.createdBy)}<br>
        ${info.counts.agreements} agreements · ${info.counts.users} users · ${info.counts.companies} companies</p>
        <label for="rsPw">Your password, to confirm</label>
        <input id="rsPw" type="password" autocomplete="current-password">
        <div class="row end" style="margin-top:10px"><button class="primary danger" id="rsGo">Replace all data with this backup</button></div>
      </div>`;
    $('#rsGo').onclick = async () => {
      if (!$('#rsPw').value) return toast('Please enter your password');
      if (!confirm('Replace ALL current data with this backup?\n\nThe current data is saved as a restore point first. Everyone will be signed out.')) return;
      const body = new FormData();
      body.append('file', file);
      body.append('password', $('#rsPw').value);
      $('#rsGo').disabled = true;
      try {
        const r = await api('/api/restore', { method: 'POST', body });
        alert(`Restore complete: ${r.counts.agreements} agreements, ${r.counts.users} users, ${r.counts.companies} companies.\n\nThe previous data was saved as ${r.restorePoint}.\n\nPlease sign in again.`);
        location.hash = '';
        location.reload();
      } catch (err) {
        $('#rsGo').disabled = false;
        toast(err.message, 5000);
      }
    };
  };
}

// ---------------- Users (administrators) ----------------
// Administrators add people, set their passwords (shown once, only to the administrator), activate or
// deactivate accounts and decide who may view or download audit trails.
async function showUsers(notice = '') {
  const users = await api('/api/users');
  const statusBadge = (u) => {
    if (u.lockedUntil && Date.parse(u.lockedUntil) > Date.now()) return '<span class="badge declined">locked</span>';
    return { active: '<span class="badge completed">active</span>', invited: '<span class="badge sent">no password</span>', disabled: '<span class="badge voided">deactivated</span>' }[u.status];
  };
  const permBox = (u, p, label) => u.role === 'admin'
    ? `<label class="check" style="margin:0" title="Administrators always have this"><input type="checkbox" checked disabled> ${label}</label>`
    : `<label class="check" style="margin:0"><input type="checkbox" data-perm="${p}" ${u.permissions?.[p] ? 'checked' : ''}> ${label}</label>`;
  app.innerHTML = `
    <div class="wrap" style="max-width:1200px">
      <div class="card" style="margin-bottom:16px">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap"><h1 style="margin:0">Users</h1><a class="btn" href="#/outside-signers">👥 Outside signers (temporary password)</a></div>
        <p class="muted small">Only administrators add users and set passwords. When you add someone, we email them their sign-in ID (their email) and password. They sign in with both, plus a code emailed to them each time. Users can't change their own password; they ask you. Users are never deleted, only deactivated, so the audit trail always shows who did what. To give someone every administrator right, set their access to <strong>Administrator (full access)</strong>.</p>
        <form id="addUser">
          <div class="row" style="flex-wrap:wrap;align-items:flex-end">
            <div style="flex:1;min-width:160px"><label for="uName">Full name</label><input id="uName" required></div>
            <div style="flex:1;min-width:200px"><label for="uEmail">Email (sign-in ID)</label><input id="uEmail" type="email" required></div>
            <div><label for="uRole">Access</label><select id="uRole"><option value="sender">Sender</option><option value="admin">Administrator (full access)</option></select></div>
          </div>
          <div class="row" style="flex-wrap:wrap;align-items:flex-end;margin-top:4px">
            <div style="flex:1;min-width:220px"><label for="uPw">Password</label><input id="uPw" type="text" autocomplete="off" spellcheck="false" placeholder="Type one, or click Generate"></div>
            <button type="button" id="genPw">Generate</button>
            <label class="check" style="margin:0 8px"><input type="checkbox" id="uView"> Can view audit trail</label>
            <label class="check" style="margin:0 8px"><input type="checkbox" id="uDownload"> Can download audit trail</label>
            <button class="primary">Add user</button>
          </div>
        </form>
        <div id="pwResult">${notice}</div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Status</th><th>Audit trail access</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr data-id="${u.id}">
              <td><strong>${esc(u.name)}</strong>${u.id === me.user.id ? ' <span class="small muted">(you)</span>' : ''}${u.systemAdmin ? '<br><span class="badge completed" title="The only person who can restart the server or erase its data">system administrator</span>' : ''}</td>
              <td class="small">${esc(u.email)}</td>
              <td><select data-role ${u.id === me.user.id || u.systemAdmin ? 'disabled' : ''}><option value="sender" ${u.role === 'sender' ? 'selected' : ''}>Sender</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator (full access)</option></select></td>
              <td>${statusBadge(u)}</td>
              <td class="small">${permBox(u, 'viewAudit', 'View')}${permBox(u, 'downloadAudit', 'Download')}</td>
              <td class="small muted">${u.lastLoginAt ? when(u.lastLoginAt) : '—'}</td>
              <td class="small" style="white-space:nowrap">
                <button class="ghost small" data-edit>Edit</button>
                <button class="ghost small" data-act="set-password">Set new password</button>
                ${u.lockedUntil && Date.parse(u.lockedUntil) > Date.now() ? '<button class="ghost small" data-act="unlock">Unlock</button>' : ''}
                ${u.id === me.user.id || u.systemAdmin ? '' : u.status === 'disabled' ? '<button class="ghost small" data-act="enable">Reactivate</button>' : '<button class="ghost small danger" data-act="disable">Deactivate</button>'}
              </td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;

  // A password is shown once, only here. New users also get it in their welcome email.
  const showPassword = (user, password, emailed) => `
    <div class="card" style="margin-top:14px;border-color:#fde68a;background:#fffbeb">
      <strong>Password for ${esc(user.name)} (${esc(user.email)})</strong>
      <div class="linkbox"><input readonly value="${esc(password)}" style="font-family:var(--font);font-size:15px"><button data-copy-pw>Copy</button></div>
      <p class="small muted" style="margin:6px 0 0">${emailed ? `We've emailed the sign-in ID and this password to ${esc(user.email)}. ` : 'Give it to the person privately. '}Shown only now: it is stored scrambled and can't be displayed again. If it's lost, set a new one.</p>
    </div>`;
  const bindCopy = (password) => $('[data-copy-pw]')?.addEventListener('click', () => navigator.clipboard.writeText(password).then(() => toast('Password copied')));

  // Generate fills in a strong password, so the administrator sees it before adding the user.
  $('#genPw').onclick = async () => {
    try {
      $('#uPw').value = (await api('/api/password/generate')).password;
      toast('Strong password generated');
    } catch (err) { toast(err.message, 4000); }
  };
  if (pendingNewUser) {
    $('#uName').value = pendingNewUser.name || '';
    $('#uEmail').value = pendingNewUser.email || '';
    pendingNewUser = null;
    $('#genPw').click();
    $('#addUser').scrollIntoView({ block: 'center' });
    toast('Check the details, then click Add user');
  }
  $('#addUser').onsubmit = async (e) => {
    e.preventDefault();
    const generate = !$('#uPw').value;
    try {
      const r = await api('/api/users', { method: 'POST', body: {
        name: $('#uName').value, email: $('#uEmail').value, role: $('#uRole').value,
        password: $('#uPw').value, generate, permissions: { viewAudit: $('#uView').checked, downloadAudit: $('#uDownload').checked },
      } });
      await showUsers(showPassword(r.user, r.password, true));
      bindCopy(r.password);
      toast(`${r.user.name} added and emailed their sign-in details`);
    } catch (err) { toast(err.message, 5000); }
  };

  app.querySelectorAll('tr[data-id]').forEach((tr) => {
    const uid = tr.dataset.id;
    const u = users.find((x) => x.id === uid);
    tr.querySelector('[data-role]').onchange = async (e) => {
      if (e.target.value === 'admin' && !confirm(`Give ${u.name} full administrator access?\n\nThey will be able to add and edit users, set passwords, grant access, see and download all audit trails and the system log, manage the company list, and download or restore backups.`)) return showUsers();
      try {
        await api(`/api/users/${uid}/role`, { method: 'POST', body: { role: e.target.value } });
        toast('Role changed');
        showUsers();
      } catch (err) { toast(err.message, 4000); showUsers(); }
    };
    tr.querySelectorAll('[data-perm]').forEach((box) => (box.onchange = async () => {
      const body = Object.fromEntries([...tr.querySelectorAll('[data-perm]')].map((b) => [b.dataset.perm, b.checked]));
      try {
        await api(`/api/users/${uid}/permissions`, { method: 'POST', body });
        toast('Access updated');
      } catch (err) { toast(err.message, 4000); showUsers(); }
    }));
    tr.querySelector('[data-edit]').onclick = () => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `
        <div class="modal" style="max-width:420px">
          <h2>Edit user</h2>
          <label for="euName">Full name</label>
          <input id="euName" value="${esc(u.name)}">
          <label for="euEmail">Email (sign-in ID)</label>
          <input id="euEmail" type="email" value="${esc(u.email)}">
          <p class="small muted">If you change the email, they sign in with the new one from now on, keeping the same password. We email both the old and new address. Agreements already sent keep the details recorded at the time.</p>
          <div class="row end" style="margin-top:12px"><button id="euCancel">Cancel</button><button id="euSave" class="primary">Save</button></div>
        </div>`;
      document.body.append(bg);
      $('#euName').focus();
      $('#euCancel').onclick = () => bg.remove();
      $('#euSave').onclick = async () => {
        try {
          const r = await api(`/api/users/${uid}/details`, { method: 'POST', body: { name: $('#euName').value, email: $('#euEmail').value } });
          bg.remove();
          if (uid === me.user.id) {
            me.user = { ...me.user, name: r.user.name, email: r.user.email };
            $('#account').textContent = `👤 ${me.user.name}`;
          }
          await showUsers();
          toast('User details saved');
        } catch (err) { toast(err.message, 5000); }
      };
    };
    tr.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      const act = b.dataset.act;
      let body = {};
      if (act === 'disable' && !confirm(`Deactivate ${u.name}? They are signed out immediately and can't sign in until reactivated.`)) return;
      if (act === 'set-password') {
        const typed = prompt(`New password for ${u.name}.\nType one (at least 10 characters, letters and numbers), or leave empty to generate a strong one:`, '');
        if (typed === null) return;
        body = typed ? { password: typed } : { generate: true };
      }
      try {
        const r = await api(`/api/users/${uid}/${act}`, { method: 'POST', body });
        if (r.password) {
          await showUsers(showPassword(r.user, r.password, true));
          toast(`New password set and emailed to ${r.user.email}`, 4000);
          bindCopy(r.password);
        } else {
          await showUsers();
          toast({ enable: 'User reactivated', disable: 'User deactivated', unlock: 'User unlocked' }[act] || 'Done');
        }
      } catch (err) { toast(err.message, 5000); }
    }));
  });
}

// Opens the Users page with the add-user form filled in (from an account request or an outside signer).
let pendingNewUser = null;
function createAccountFor(name, email) {
  pendingNewUser = { name, email };
  if (location.hash === '#/users') showUsers();
  else location.hash = '#/users';
}

// ---------------- Outside signers (administrators) ----------------
// People who signed, or were asked to sign, without an account: they use a temporary password emailed
// for each agreement. An administrator can give any of them an account.
async function showOutsideSigners() {
  const people = await api('/api/outside-signers');
  const badge = (st) => `<span class="badge ${{ signed: 'completed', declined: 'declined', viewed: 'sent', pending: 'draft' }[st] || 'draft'}">${esc(st)}</span>`;
  app.innerHTML = `
    <div class="wrap" style="max-width:1200px">
      <div class="card" style="margin-bottom:16px">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap"><h1 style="margin:0">Outside signers</h1><a class="btn" href="#/users">← Users</a></div>
        <p class="muted small">People who sign without an account: each time, a temporary password is emailed to them for that agreement only. Their activity is in each agreement's audit trail and in the <a href="#/system-log">system log</a>. If they asked for an account, the request is also under <a href="#/tickets">Support tickets</a>. Click <strong>Create account</strong> to add them as a user. ${people.length} ${people.length === 1 ? 'person' : 'people'}.</p>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Agreements</th><th>Last activity</th><th>Account request</th><th></th></tr></thead>
          <tbody>${people.length ? people.map((p, i) => `
            <tr>
              <td><strong>${esc(p.name)}</strong></td>
              <td class="small">${esc(p.email)}</td>
              <td class="small">${esc(p.company || '—')}</td>
              <td class="small">${p.agreements.map((a) => `<a href="#/doc/${esc(a.id)}">${esc(a.agreementId || a.title)}</a> ${badge(a.status)}`).join('<br>')}<br><span class="muted">${p.signed} signed of ${p.agreements.length}</span></td>
              <td class="small muted">${p.lastActivity ? when(p.lastActivity) : '—'}</td>
              <td class="small">${p.request ? `<span class="badge sent">open</span> <a href="#/tickets">${esc(p.request)}</a>` : p.accountRequestedAt ? `requested ${when(p.accountRequestedAt)}` : '—'}</td>
              <td><button class="small" data-create="${i}">Create account</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No outside signers yet.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  app.querySelectorAll('[data-create]').forEach((b) => (b.onclick = () => {
    const p = people[Number(b.dataset.create)];
    createAccountFor(p.name, p.email);
  }));
}

// ---------------- Server restart (system administrator only) ----------------
// Both kinds save a backup first. The server restarts by stopping; the Windows service starts it again.
async function showServer() {
  // Only the start time is needed: it tells when the restart has finished.
  const info = await api('/api/server');
  app.innerHTML = `
    <div class="wrap" style="max-width:820px">
      <h1>Server restart</h1>
      <div class="card" style="margin-bottom:16px">
        <h2>1. Update and restart</h2>
        <p class="small muted">Saves a backup, gets the newest code from GitHub, checks it and restarts. All data stays. If the update fails, nothing is restarted and the current version keeps running. Everyone stays signed in; pages reconnect within a minute.</p>
        <label for="rsPw1">Your password, to confirm</label>
        <input id="rsPw1" type="password" autocomplete="current-password">
        <div class="row end" style="margin-top:10px"><button class="primary" id="restart1">Back up, update and restart</button></div>
      </div>
      <div class="card" style="border-color:#fecaca">
        <h2 style="color:var(--danger)">2. Erase all data, update and restart</h2>
        <p class="small muted">Saves a backup, then <strong>deletes everything</strong>: all agreements and their PDFs, users (including you), companies, tickets, saved signatures, signing keys and logs. Then gets the newest code and restarts empty, with the first-time setup page (it needs the setup password, ADMIN_PASSWORD in the server's .env). To undo it, restore the backup it saved.</p>
        <label for="rsPw2">Your password, to confirm</label>
        <input id="rsPw2" type="password" autocomplete="current-password">
        <label for="rsConfirm">Type ERASE to confirm</label>
        <input id="rsConfirm" autocomplete="off" spellcheck="false">
        <div class="row end" style="margin-top:10px"><button class="primary danger" id="restart2">Back up, erase all data and restart</button></div>
      </div>
    </div>`;
  const go = async (mode) => {
    const password = $(mode === 'erase' ? '#rsPw2' : '#rsPw1').value;
    if (!password) return toast('Please enter your password');
    if (mode === 'erase') {
      if ($('#rsConfirm').value !== 'ERASE') return toast('Type ERASE to confirm');
      if (!confirm('Erase ALL data and restart?\n\nA backup is saved first. Everyone, including you, is removed; the server starts empty.')) return;
    } else if (!confirm('Back up, update and restart the server now?\n\nThe site is unavailable for about a minute.')) return;
    app.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const r = await api('/api/server/restart', { method: 'POST', body: { mode, password, confirm: $('#rsConfirm').value } });
      waitForRestart(r, info.startedAt);
    } catch (e) {
      app.querySelectorAll('button').forEach((b) => (b.disabled = false));
      toast(e.message, 6000);
    }
  };
  $('#restart1').onclick = () => go('update');
  $('#restart2').onclick = () => go('erase');
}

// Waits until the server answers again with a new start time, then reloads.
function waitForRestart(r, startedBefore) {
  app.innerHTML = `
    <div class="wrap card" style="max-width:640px">
      <h1>Restarting…</h1>
      <ul class="small">${r.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p id="rsWait" class="muted">Waiting for the server to start again…</p>
    </div>`;
  const t0 = Date.now();
  const poll = async () => {
    try {
      const h = await (await fetch('/healthz', { cache: 'no-store' })).json();
      if (h.started && h.started !== startedBefore) {
        $('#rsWait').textContent = 'The server is running again. Reloading…';
        setTimeout(() => { location.hash = '#/'; location.reload(); }, 1200);
        return;
      }
    } catch {}
    if (Date.now() - t0 > 3 * 60000) {
      $('#rsWait').innerHTML = 'The server has not come back after 3 minutes. On the server PC, check the <strong>Method365</strong> service (Services, or <code>nssm status Method365</code>) and its log in <code>logs\\method365.log</code>.';
      return;
    }
    setTimeout(poll, 2000);
  };
  setTimeout(poll, 2000);
}

// Sign-ins, failed logins, discarded drafts and test emails, with the hash-chain check.
// A "From / To" time window for audit trails and the system log. Times are picked in local time and
// sent to the server as ISO timestamps; leaving one empty means "from the beginning" / "until now".
const timeRangeHtml = (id, range = {}) => `
  <div class="row time-range" id="${id}" style="flex-wrap:wrap;align-items:flex-end;gap:8px;margin:10px 0">
    <div><label for="${id}From">From</label><input type="datetime-local" id="${id}From" value="${range.fromLocal || ''}"></div>
    <div><label for="${id}To">To</label><input type="datetime-local" id="${id}To" value="${range.toLocal || ''}"></div>
    <button type="button" data-range-apply>Show</button>
    <button type="button" class="ghost" data-range-clear>Clear</button>
  </div>`;
function readTimeRange(id) {
  const iso = (v, extraMs = 0) => (v ? new Date(new Date(v).getTime() + extraMs).toISOString() : '');
  const fromLocal = $(`#${id}From`).value;
  const toLocal = $(`#${id}To`).value;
  if (fromLocal && toLocal && fromLocal > toLocal) throw new Error('The start time must be before the end time.');
  // "To 14:30" includes everything up to 14:30:59.
  return { fromLocal, toLocal, from: iso(fromLocal), to: iso(toLocal, 59999) };
}
const rangeQuery = (r) => new URLSearchParams(Object.entries({ from: r.from, to: r.to }).filter(([, v]) => v)).toString();
const inRange = (r) => (e) => (!r.from || e.at >= r.from) && (!r.to || e.at <= r.to);

async function showSystemLog(range = {}) {
  app.innerHTML = '<div class="wrap card">Loading…</div>';
  const q = rangeQuery(range);
  const { integrity, entries, total, matching } = await api(`/api/system-log${q ? `?${q}` : ''}`);
  app.innerHTML = `
    <div class="wrap">
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap"><h1 style="margin:0">System audit log</h1><a class="btn" href="/api/system-log.pdf${q ? `?${q}` : ''}">⬇ Download PDF${q ? ' (this period)' : ''}</a></div>
        <p class="muted small">Actions not tied to one agreement: sign-ins, failed sign-in attempts, users, passwords and access changes, discarded drafts, downloads. Each agreement's own audit trail is on its page.</p>
        ${timeRangeHtml('logRange', range)}
        ${q ? `<p class="small muted">Showing ${matching} of ${total} entries in this period${matching > 500 ? ' (newest 500 on screen; the PDF has all)' : ''}.</p>` : ''}
        ${integrityHtml(integrity)}
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>IP / details</th></tr></thead>
          <tbody>${entries.map((e) => `<tr><td class="small">${when(e.at)}</td><td class="small">${esc(e.actor || '')}</td><td>${esc(e.text)}</td><td class="small muted">${esc(e.ip || '')}${e.detail ? `<br>${esc(e.detail)}` : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${q ? 'No entries in this period.' : 'No entries yet.'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  $('#logRange [data-range-apply]').onclick = () => {
    try { showSystemLog(readTimeRange('logRange')); } catch (e) { toast(e.message, 4000); }
  };
  $('#logRange [data-range-clear]').onclick = () => showSystemLog();
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
      ${me.mail ? '' : `
        <div class="card row" style="margin-bottom:16px;padding:12px 16px;background:#fffbeb;border-color:#fde68a">
          <span>⚠️ <strong>Email is off</strong>: signers and sign-in codes can't be emailed. Ask your administrator to check the email settings.</span>
        </div>`}
      ${me.loginCode === false && me.user.role === 'admin' ? `
        <div class="card row" style="margin-bottom:16px;padding:12px 16px;background:#fef2f2;border-color:#fecaca">
          <span>⚠️ <strong>Sign-in codes are turned off</strong> (testing): everyone signs in with their password only. Remove <code>LOGIN_CODE=off</code> from <code>.env</code> and restart before real use.</span>
        </div>` : ''}
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
      <div class="row list-tools" style="margin-top:20px;flex-wrap:wrap;gap:12px;align-items:flex-end">
        <div><label for="fStatus">Status</label><select id="fStatus">
          <option value="">All statuses</option><option value="draft">Draft</option><option value="sent">Out for signature</option>
          <option value="completed">Completed</option><option value="declined">Declined</option><option value="voided">Cancelled</option>
        </select></div>
        <div><label for="fSort">Sort by created</label><select id="fSort">
          <option value="new">Newest first</option><option value="old">Oldest first</option>
        </select></div>
        <span class="small muted" id="listCount" style="padding-bottom:9px"></span>
      </div>
      <div class="card" style="margin-top:10px;padding:0">
        <table>
          <thead><tr><th>Agreement ID</th><th>Document</th><th>Status</th><th>Recipients</th><th>Created</th></tr></thead>
          <tbody id="rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>`;
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

  const allDocs = await api('/api/documents');
  // Filter by status and sort by created date; the choice is remembered on this browser.
  const saved = (() => { try { return JSON.parse(localStorage.getItem('m365-list') || '{}'); } catch { return {}; } })();
  $('#fStatus').value = saved.status || '';
  $('#fSort').value = saved.sort || 'new';
  const render = () => {
    const status = $('#fStatus').value;
    const sort = $('#fSort').value;
    try { localStorage.setItem('m365-list', JSON.stringify({ status, sort })); } catch {}
    const docs = allDocs.filter((d) => !status || d.status === status)
      .sort((a, b) => (sort === 'old' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
    $('#listCount').textContent = status ? `${docs.length} of ${allDocs.length} agreements` : `${allDocs.length} agreement${allDocs.length === 1 ? '' : 's'}`;
    renderRows(docs, !!status);
  };
  $('#fStatus').onchange = render;
  $('#fSort').onchange = render;
  render();
}

function renderRows(docs, filtered) {
  $('#rows').innerHTML = docs.length
    ? docs.map((d) => `
      <tr class="click" data-id="${d.id}">
        <td class="small" style="font-family:var(--font);white-space:nowrap">${d.agreementId ? esc(d.agreementId) : '<span class="muted">Draft</span>'}</td>
        <td><strong>${esc(d.title)}</strong>${d.senderName ? `<div class="small muted">${d.access === 'recipient' ? 'Sent to you by' : 'Sent by'} ${esc(d.senderName)}</div>` : ''}</td>
        <td><span class="badge ${d.status}">${statusLabel(d.status)}</span></td>
        <td class="small">${d.signers.map((s, i) => `${i + 1}. ${esc(s.name)} <span class="badge ${s.status}">${s.status}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="small muted">${when(d.createdAt)}</td>
      </tr>`).join('')
    : filtered
      ? '<tr><td colspan="5" class="muted">No agreements with this status.</td></tr>'
      : `<tr><td colspan="5" class="muted">No documents yet. Upload a PDF to get started.${me.user.role === 'admin' ? '' : ' You see the agreements you sent and the ones sent to you.'}</td></tr>`;
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

// The last copied field, kept for this browser tab so it can be pasted into another agreement too.
const fieldClipboard = {
  get() {
    try { return JSON.parse(sessionStorage.getItem('esign-field-clipboard') || 'null') || this.mem || null; } catch { return this.mem || null; }
  },
  set(f) {
    this.mem = structuredClone(f);
    try { sessionStorage.setItem('esign-field-clipboard', JSON.stringify(f)); } catch {}
  },
};

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
        <p class="small muted" style="margin:10px 0 0">Commenting as <strong>${esc(me.user.name)}</strong></p>
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
    $('#cPin').onclick = () => {
      pinning = !pinning && !pendingPin;
      pendingPin = null;
      $('#viewer').classList.toggle('placing', pinning);
      renderSidebar();
      if (pinning) toast('Now click the spot on the document to pin your comment');
    };
    $('#cAdd').onclick = async () => {
      const text = $('#cText').value.trim();
      try {
        const c = await api(`/api/documents/${doc.id}/comments`, { method: 'POST', body: { text, ...(pendingPin || {}) } });
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
        Object.assign(c, await api(`/api/documents/${doc.id}/comments/${c.id}/resolve`, { method: 'POST', body: { resolved: !c.resolved } }));
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
        <input id="cfFormula" value="${esc(f.formula)}" placeholder="{Qty} * {Price}" style="font-family:var(--font)">
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
        <button class="ghost" id="cfClip" title="Ctrl+C, then Ctrl+V on any page or agreement">📋 Copy (Ctrl+C)</button>
        <button class="ghost" id="cfCopy">⧉ Duplicate field</button>
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
    $('#cfClip').onclick = () => copyToClipboard(f);
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
  // Copy / paste: the copied field stays available in this browser tab, so it can be pasted on another
  // page or into another agreement. Pasted fields keep their size, label and style.
  function copyToClipboard(f) {
    fieldClipboard.set(f);
    toast('Field copied. Click a page and press Ctrl+V to paste it.', 3000);
  }
  function pasteField(page, at) {
    const src = fieldClipboard.get();
    if (!src) return toast('Copy a field first (select it and press Ctrl+C)');
    if (!doc.signers.length) return toast('Add a recipient first');
    const p = pages[page];
    if (!p) return;
    const c = { ...structuredClone(src), id: rid(), page };
    // Keep the recipient when they're on this agreement; otherwise give it to the selected recipient.
    if (!doc.signers.some((s) => s.id === c.signerId)) c.signerId = activeSigner || doc.signers[0].id;
    c.w = Math.min(c.w, 1);
    c.h = Math.min(c.h, 1);
    if (at) {
      c.x = at.x - c.w / 2;
      c.y = at.y - c.h / 2;
    } else {
      // Same spot as the original; step down a little if a field is already there.
      while (doc.fields.some((o) => o.page === page && Math.abs(o.x - c.x) < 0.005 && Math.abs(o.y - c.y) < 0.005)) c.y += 0.02;
    }
    c.x = Math.min(1 - c.w, Math.max(0, c.x));
    c.y = Math.min(1 - c.h, Math.max(0, c.y));
    doc.fields.push(c);
    selected = c.id;
    renderFields();
    renderSidebar();
    scheduleSave();
    toast(`Field pasted on page ${page + 1}`);
  }
  // The page you last clicked, else the one most in view.
  let currentPage = 0;
  function visiblePage() {
    const mid = window.innerHeight / 2;
    let best = currentPage;
    let bestDist = Infinity;
    pages.forEach((p, pi) => {
      const r = p.layer.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bestDist) { best = pi; bestDist = d; }
    });
    return best;
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
    ctx.innerHTML = `<button data-a="clip">📋 Copy (Ctrl+C)</button><button data-a="copy">⧉ Duplicate field</button><button data-a="del">🗑 Delete field</button><button data-a="all">⎘ Copy field to all pages</button>`;
    Object.assign(ctx.style, { left: `${x}px`, top: `${y}px` });
    ctx.classList.remove('hidden');
    ctx.querySelector('[data-a=clip]').onclick = () => copyToClipboard(f);
    ctx.querySelector('[data-a=copy]').onclick = () => copyField(f);
    ctx.querySelector('[data-a=del]').onclick = () => deleteField(f);
    ctx.querySelector('[data-a=all]').onclick = () => copyToAllPages(f);
  }
  // Right-click on an empty part of a page: paste the copied field there.
  function showPasteCtx(page, at, x, y) {
    if (!fieldClipboard.get()) return false;
    ctx.innerHTML = '<button data-a="paste">📋 Paste field here (Ctrl+V)</button>';
    Object.assign(ctx.style, { left: `${x}px`, top: `${y}px` });
    ctx.classList.remove('hidden');
    ctx.querySelector('[data-a=paste]').onclick = () => pasteField(page, at);
    return true;
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
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) deleteField(selField());
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !typing && e.key.toLowerCase() === 'c' && selField() && !window.getSelection()?.toString()) {
      e.preventDefault();
      copyToClipboard(selField());
    }
    if (mod && !typing && e.key.toLowerCase() === 'v' && pages.length) {
      e.preventDefault();
      pasteField(selField() ? selField().page : visiblePage());
    }
    if (mod && !typing && e.key.toLowerCase() === 'd' && selField()) {
      e.preventDefault();
      copyField(selField());
    }
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
      p.layer.oncontextmenu = (e) => {
        if (e.target !== p.layer) return;
        const rect = p.layer.getBoundingClientRect();
        if (showPasteCtx(pi, { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }, e.clientX, e.clientY)) e.preventDefault();
      };
      p.layer.onpointerdown = (e) => {
        if (e.button === 2) return;
        currentPage = pi;
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

// A ready-written email with a signer's link, sent from the sender's own mailbox (Outlook or the
// default mail app). Useful when Method 365's own emails are held by the recipient's mail filter.
function outlookMailto(doc, s) {
  const subject = `Please sign "${doc.title}"${doc.agreementId ? ` [${doc.agreementId}]` : ''}`;
  const body = [
    `Hello ${s.name},`,
    `${me.user.name} has sent you "${doc.title}"${doc.agreementId ? ` (agreement ${doc.agreementId})` : ''} to sign in ${me.app}.`,
    doc.message || '',
    `Open this link to review and sign:\n${s.link}`,
    'If you have a Method 365 account, sign in with your email and password when asked. Otherwise a temporary password is emailed to you when you open the link.',
    `Thank you,\n${me.user.name}`,
  ].filter(Boolean).join('\n\n');
  return `mailto:${encodeURIComponent(s.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ---------------- Sent / completed view ----------------
function showDetail(doc) {
  document.onkeydown = null;
  location.hash = `#/doc/${doc.id}`;
  const done = doc.status === 'completed';
  // Agreements are never deleted; while out for signature they can only be cancelled.
  actions.innerHTML = `
    ${done ? `<a class="btn" href="/api/documents/${doc.id}/print.pdf?tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}" target="_blank" title="A copy stamped PRINTED COPY with your name and the time on every page">🖨 Print copy</a>` : ''}
    ${me.user.can.downloadAudit ? `<a class="btn" id="auditPdf" href="/api/documents/${doc.id}/audit.pdf" title="Download this agreement's audit trail as a PDF (choose a period under Audit trail)">⬇ Audit trail (PDF)</a>` : ''}
    ${done ? `<a class="btn primary" href="/api/documents/${doc.id}/signed">Download signed PDF</a>` : ''}
    ${doc.status === 'sent' && doc.access !== 'recipient' ? '<button id="voidBtn" class="danger">Cancel agreement</button>' : ''}`;
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
          ${done && doc.locked ? `<div class="locked">🔒 <strong>Locked.</strong> Certified by ${esc(me.company)} ${esc(me.app)}: no changes allowed. Any edit breaks the signatures.${doc.protected ? ' The PDF can be printed, but its text can\'t be copied or edited.' : ''}</div>` : ''}
          ${doc.access === 'recipient' ? `<p class="small muted">Sent to you by ${esc(doc.senderName || 'the sender')}. ${doc.status === 'sent' ? 'Use the signing link in your email to sign.' : ''}</p>` : ''}
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
                  <a class="btn ghost small" style="padding:4px 0" href="${esc(outlookMailto(doc, s))}" title="Opens a ready-written email in Outlook (or your mail app) from your own mailbox">✉ Email from Outlook</a>
                  ${me.mail ? `<button class="ghost small" data-remind="${s.id}" style="padding:4px 0">Send reminder</button>` : ''}` : ''}
                ${doc.status === 'sent' && s.status !== 'signed' && !s.link ? `
                  <div class="small muted" style="margin-top:4px">🔒 Waiting for signer ${current.join(', ')}. Their link is sent automatically after that.</div>` : ''}
              </div>
            </div>`).join('')}
        </section>
        <section style="border:none">
          <h3>Audit trail</h3>
          ${doc.auditHidden ? '<p class="small muted">🔒 You don\'t have access to view audit trails. An administrator can grant it.</p>' : `${integrityHtml(doc.auditIntegrity)}${timeRangeHtml('auditRange')}<p class="small muted" id="auditCount"></p>`}
          <ul class="events" id="auditEvents"></ul>
        </section>
        ${doc.comments?.length ? `<section style="border:none">
          <h3>Comments before sending (${doc.comments.length})</h3>
          ${doc.comments.map((c) => commentHtml(c, true)).join('')}
        </section>` : ''}
      </aside>
      <div class="viewer"><div class="pages" id="pages"></div></div>
    </div>`;

  // Audit trail for a chosen period; the PDF button downloads the same period.
  const showEvents = (range = {}) => {
    const list = doc.events.filter(inRange(range)).reverse();
    $('#auditEvents').innerHTML = list.map((e) => `<li><span class="muted small">${when(e.at)}${e.actor ? ` · ${esc(e.actor)}` : ''}</span><br>${esc(e.text)}${e.detail ? `<br><span class="small muted">${esc(e.detail)}</span>` : ''}</li>`).join('')
      || (doc.events.length ? '<li class="small muted">No events in this period.</li>' : '');
    if ($('#auditCount')) $('#auditCount').textContent = range.from || range.to ? `Showing ${list.length} of ${doc.events.length} events in this period.` : '';
    const q = rangeQuery(range);
    if ($('#auditPdf')) {
      $('#auditPdf').href = `/api/documents/${doc.id}/audit.pdf${q ? `?${q}` : ''}`;
      $('#auditPdf').textContent = q ? '⬇ Audit trail (PDF, this period)' : '⬇ Audit trail (PDF)';
    }
  };
  showEvents();
  if ($('#auditRange')) {
    $('#auditRange [data-range-apply]').onclick = () => {
      try { showEvents(readTimeRange('auditRange')); } catch (e) { toast(e.message, 4000); }
    };
    $('#auditRange [data-range-clear]').onclick = () => {
      $('#auditRangeFrom').value = '';
      $('#auditRangeTo').value = '';
      showEvents();
    };
  }

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
