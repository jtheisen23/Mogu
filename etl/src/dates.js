// Date helpers. Business dates are handled as 'YYYY-MM-DD' strings and all
// arithmetic is done in UTC so it never drifts across DST changes.

export function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date "${s}", expected YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${s}"`);
  return d;
}

export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDate(d);
}

export function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Today's date in the given IANA time zone, as YYYY-MM-DD. */
export function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Toast business dates are integers like 20260924. */
export function toToastDate(s) {
  return s.replaceAll('-', '');
}

export function fromToastDate(v) {
  const s = String(v);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

const hourFormatters = new Map();
/** Hour of day (0-23) of an ISO timestamp in the given time zone. */
export function hourIn(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let f = hourFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
    hourFormatters.set(timeZone, f);
  }
  return Number(f.format(d)) % 24;
}
