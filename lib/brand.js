// Names shown to people: the app's own name, and the company using it (full and short).
const APP_NAME = process.env.APP_NAME || 'Method 365';
const COMPANY = process.env.COMPANY_NAME || 'Our Company';
const COMPANY_SHORT = process.env.COMPANY_SHORT || COMPANY;
// "Jupiter Research Services (JRS)", or just the name when there is no separate short form.
const COMPANY_FULL = COMPANY_SHORT && COMPANY_SHORT !== COMPANY ? `${COMPANY} (${COMPANY_SHORT})` : COMPANY;

module.exports = { APP_NAME, COMPANY, COMPANY_SHORT, COMPANY_FULL };
