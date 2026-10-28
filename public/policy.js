// Fills the policy page with this installation's app name, company, contact address and policy version.
fetch('/api/policy-info')
  .then((r) => r.json())
  .then((p) => {
    const fill = (attr, value) => value && document.querySelectorAll(`[${attr}]`).forEach((el) => { el.textContent = value; });
    fill('data-app', p.app);
    fill('data-company', p.company);
    fill('data-version', p.version);
    fill('data-effective', p.effective);
    if (p.contact) {
      fill('data-contact', p.contact);
      document.querySelectorAll('[data-contact-link]').forEach((a) => { a.href = `mailto:${p.contact}`; });
    }
    document.title = `Policies – ${p.app}`;
  })
  .catch(() => {});

// Company logo in the header, as on the other pages.
const logo = new Image();
logo.onload = () => {
  logo.alt = 'Logo';
  logo.style.height = '32px';
  document.querySelector('.logo svg')?.replaceWith(logo);
};
logo.src = '/logo.png';
