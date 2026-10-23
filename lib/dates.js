// Date formatting shared by signing, finalization and the audit report.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD-Mon-YYYY', 'Mon DD, YYYY', 'DD.MM.YYYY'];

function validTz(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

// Calendar parts of `date` as seen in time zone `tz`.
function parts(date, tz = 'UTC') {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: validTz(tz), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short',
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  return { Y: p.year, M: p.month, D: p.day, h: p.hour === '24' ? '00' : p.hour, m: p.minute, s: p.second, tz: p.timeZoneName };
}

function formatYMD({ Y, M, D }, fmt) {
  const mon = MONTHS[Number(M) - 1];
  switch (fmt) {
    case 'DD/MM/YYYY': return `${D}/${M}/${Y}`;
    case 'YYYY-MM-DD': return `${Y}-${M}-${D}`;
    case 'DD-Mon-YYYY': return `${D}-${mon}-${Y}`;
    case 'Mon DD, YYYY': return `${mon} ${D}, ${Y}`;
    case 'DD.MM.YYYY': return `${D}.${M}.${Y}`;
    default: return `${M}/${D}/${Y}`;
  }
}

// A date in the signer's time zone, e.g. "23-Oct-2026".
const formatDate = (date, fmt, tz) => formatYMD(parts(date, tz), fmt);

// A plain "YYYY-MM-DD" chosen by the signer, reformatted without time zone shifts.
function formatIsoDay(iso, fmt) {
  const [Y, M, D] = iso.split('-');
  return formatYMD({ Y, M, D }, fmt);
}

// Signature caption timestamp, e.g. "Oct 23, 2026 16:10:01 EDT".
function captionStamp(date, tz) {
  const p = parts(date, tz);
  return `${MONTHS[Number(p.M) - 1]} ${Number(p.D)}, ${p.Y} ${p.h}:${p.m}:${p.s} ${p.tz}`;
}

// Audit report timestamp, e.g. "2026-10-23 - 8:05:24 PM GMT".
function auditStamp(iso) {
  const p = parts(new Date(iso), 'UTC');
  const h = Number(p.h);
  return `${p.Y}-${p.M}-${p.D} - ${h % 12 || 12}:${p.m}:${p.s} ${h < 12 ? 'AM' : 'PM'} GMT`;
}

module.exports = { DATE_FORMATS, validTz, formatDate, formatIsoDay, captionStamp, auditStamp };
