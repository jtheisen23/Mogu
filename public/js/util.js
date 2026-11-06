// Shared helpers: safe DOM building, formatting, date math, tables, CSV.

/** h('div', {class: 'x', onclick}, child, 'text') — text is always inserted as text, never HTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svgIcon(path, size = 10) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.append(p);
  return svg;
}
export const ICON_UP = 'M5 1l4 6H1z';
export const ICON_DOWN = 'M5 9L1 3h8z';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const dec1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
export const fmt = {
  money: (v) => (ok(v) ? money0.format(v) : '—'),
  money2: (v) => (ok(v) ? money2.format(v) : '—'),
  moneyShort: (v) => {
    if (!ok(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e6) return `$${dec1.format(v / 1e6)}M`;
    if (a >= 1e4) return `$${int.format(v / 1e3)}K`;
    if (a >= 1e3) return `$${dec1.format(v / 1e3)}K`;
    return money0.format(v);
  },
  int: (v) => (ok(v) ? int.format(v) : '—'),
  dec1: (v) => (ok(v) ? dec1.format(v) : '—'),
  pct: (v) => (ok(v) ? `${dec1.format(v * 100)}%` : '—'),
  signedPct: (v) => (ok(v) ? `${v > 0 ? '+' : ''}${dec1.format(v * 100)}%` : '—'),
  pts: (v) => (ok(v) ? `${v > 0 ? '+' : ''}${dec1.format(v * 100)} pts` : '—'),
};

export const div = (a, b) => (b ? a / b : null);
export const change = (cur, prev) => (ok(cur) && ok(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : null);

// ---------------------------------------------------------------------------
// Dates ('YYYY-MM-DD' strings, UTC arithmetic)
// ---------------------------------------------------------------------------
export const toDate = (s) => new Date(`${s}T00:00:00Z`);
export const iso = (d) => d.toISOString().slice(0, 10);
export function addDays(s, n) {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function addYears(s, n) {
  const d = toDate(s);
  const m = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + n);
  if (d.getUTCMonth() !== m) d.setUTCDate(0); // Feb 29 -> Feb 28
  return iso(d);
}
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function eachDate(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const weekdayName = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
export const fmtDate = (s) => shortDate.format(toDate(s));
export const fmtDateLong = (s) => longDate.format(toDate(s));
export const fmtWeekday = (s) => weekdayName.format(toDate(s));
export function fmtRange(p) {
  if (!p) return '';
  if (p.start === p.end) return `${fmtWeekday(p.start)} ${fmtDateLong(p.start)}`;
  return `${fmtDateLong(p.start)} – ${fmtDateLong(p.end)}`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const PRESETS = [
  ['today', 'Today (so far)'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 days'],
  ['wtd', 'Week to date'],
  ['lastweek', 'Last week'],
  ['last30', 'Last 30 days'],
  ['mtd', 'Month to date'],
  ['lastmonth', 'Last month'],
  ['qtd', 'Quarter to date'],
  ['lastquarter', 'Last quarter'],
  ['ytd', 'Year to date'],
  ['lastyear', 'Last year'],
  ['last90', 'Last 90 days'],
  ['last365', 'Last 365 days'],
  ['custom', 'Custom range…'],
];

export const COMPARES = [
  ['yoy364', 'Same period last year (by weekday)'],
  ['yoy', 'Same dates last year'],
  ['prev', 'Previous period'],
  ['custom', 'Custom range…'],
  ['none', 'No comparison'],
];

/** Resolves a preset to {start, end}. "To date" ranges end yesterday (complete days) except "today". */
export function presetRange(preset, today = localToday()) {
  const y = addDays(today, -1);
  const d = toDate(today);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const month0 = `${today.slice(0, 8)}01`;
  const q = Math.floor(d.getUTCMonth() / 3);
  const quarter0 = `${today.slice(0, 4)}-${String(q * 3 + 1).padStart(2, '0')}-01`;
  const year0 = `${today.slice(0, 4)}-01-01`;
  // "To date" presets include today once there's no complete day yet in the period.
  const toDate_ = (start) => ({ start, end: start > y ? today : y });
  switch (preset) {
    case 'today': return { start: today, end: today };
    case 'yesterday': return { start: y, end: y };
    case 'last7': return { start: addDays(y, -6), end: y };
    case 'last30': return { start: addDays(y, -29), end: y };
    case 'last90': return { start: addDays(y, -89), end: y };
    case 'last365': return { start: addDays(y, -364), end: y };
    case 'wtd': return toDate_(addDays(today, -dow));
    case 'lastweek': { const s = addDays(today, -dow - 7); return { start: s, end: addDays(s, 6) }; }
    case 'mtd': return toDate_(month0);
    case 'lastmonth': { const end = addDays(month0, -1); return { start: `${end.slice(0, 8)}01`, end }; }
    case 'qtd': return toDate_(quarter0);
    case 'lastquarter': {
      const end = addDays(quarter0, -1);
      const eq = Math.floor((Number(end.slice(5, 7)) - 1) / 3);
      return { start: `${end.slice(0, 4)}-${String(eq * 3 + 1).padStart(2, '0')}-01`, end };
    }
    case 'ytd': return toDate_(year0);
    case 'lastyear': { const yr = Number(today.slice(0, 4)) - 1; return { start: `${yr}-01-01`, end: `${yr}-12-31` }; }
    default: return null;
  }
}

export function compareRange(mode, cur) {
  if (!cur) return null;
  const len = daysBetween(cur.start, cur.end);
  switch (mode) {
    case 'prev': { const end = addDays(cur.start, -1); return { start: addDays(end, -len), end }; }
    case 'yoy364': return { start: addDays(cur.start, -364), end: addDays(cur.end, -364) };
    case 'yoy': return { start: addYears(cur.start, -1), end: addYears(cur.end, -1) };
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Time bucketing for trend charts
// ---------------------------------------------------------------------------
export function bucketKey(date, grain) {
  if (grain === 'month') return `${date.slice(0, 7)}-01`;
  if (grain === 'week') {
    const d = toDate(date);
    return addDays(date, -((d.getUTCDay() + 6) % 7)); // Monday
  }
  return date;
}
export function bucketLabel(key, grain) {
  if (grain === 'month') return monthName.format(toDate(key));
  if (grain === 'week') return `Wk of ${fmtDate(key)}`;
  return `${fmtWeekday(key)} ${fmtDate(key)}`;
}
/** All bucket keys spanning a period, so gaps show as zero rather than disappearing. */
export function bucketsFor(period, grain) {
  const keys = [];
  for (const d of eachDate(period.start, period.end)) {
    const k = bucketKey(d, grain);
    if (keys[keys.length - 1] !== k) keys.push(k);
  }
  return keys;
}

/**
 * Sums numeric fields of rows into buckets: returns Map(bucket -> Map(groupKey -> totals)).
 */
export function bucketize(rows, grain, groupBy, fields) {
  const out = new Map();
  for (const r of rows || []) {
    const b = bucketKey(r.business_date, grain);
    if (!out.has(b)) out.set(b, new Map());
    const g = groupBy ? r[groupBy] : '_all';
    const m = out.get(b);
    if (!m.has(g)) m.set(g, Object.fromEntries(fields.map((f) => [f, 0])));
    const t = m.get(g);
    for (const f of fields) t[f] += Number(r[f]) || 0;
  }
  return out;
}

export function sumBy(rows, key, fields) {
  const out = new Map();
  for (const r of rows || []) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!out.has(k)) out.set(k, Object.fromEntries(fields.map((f) => [f, 0])));
    const t = out.get(k);
    for (const f of fields) t[f] += Number(r[f]) || 0;
  }
  return out;
}

export function totals(rows, fields) {
  const t = Object.fromEntries(fields.map((f) => [f, 0]));
  for (const r of rows || []) for (const f of fields) t[f] += Number(r[f]) || 0;
  return t;
}

// ---------------------------------------------------------------------------
// Sortable table with CSV export
// ---------------------------------------------------------------------------
/**
 * columns: [{ key, label, fmt?, text?: bool, value?: row => sortable value, render?: row => Node|string, csv?: row => value }]
 * A row may have `children` (rows with the same columns). Such rows get a
 * toggle in the first column and start collapsed; `expander` is an
 * Expand all / Collapse all button (null when no row has children).
 */
export function dataTable({ columns, rows, total, sortKey, sortDir = 'desc', filename = 'export' }) {
  let key = sortKey ?? null;
  let dir = sortDir;
  const expanded = new Set();
  const expandable = rows.filter((r) => r.children?.length);
  const tbody = h('tbody');
  const tfoot = h('tfoot');
  const headers = columns.map((c) =>
    h('th', {
      class: c.text ? 'text' : null,
      scope: 'col',
      tabindex: 0,
      onclick: () => sortOn(c.key),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), sortOn(c.key)),
    }, c.label),
  );
  const valueOf = (c, r) => (c.value ? c.value(r) : r[c.key]);

  function sortOn(k) {
    if (key === k) dir = dir === 'asc' ? 'desc' : 'asc';
    else { key = k; dir = columns.find((c) => c.key === k)?.text ? 'asc' : 'desc'; }
    render();
  }

  function content(c, r) {
    if (c.render) return c.render(r);
    const v = valueOf(c, r);
    return c.fmt ? c.fmt(v, r) : v ?? '—';
  }

  function cell(c, r, i, { parent, child } = {}) {
    const cls = [c.text ? 'text' : null, child && i === 0 ? 'child-cell' : null].filter(Boolean).join(' ') || null;
    if (i === 0 && parent) {
      const open = expanded.has(r);
      return h('td', { class: cls },
        h('button', {
          type: 'button',
          class: 'row-toggle',
          'aria-expanded': String(open),
          title: open ? 'Hide details' : `Show ${r.children.length} item${r.children.length === 1 ? '' : 's'}`,
          onclick: () => { open ? expanded.delete(r) : expanded.add(r); render(); },
        }, h('span', { class: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'), content(c, r)));
    }
    return h('td', { class: cls }, content(c, r));
  }

  function sortRows(list) {
    const col = columns.find((c) => c.key === key);
    const sorted = [...list];
    if (col) {
      sorted.sort((a, b) => {
        const va = valueOf(col, a);
        const vb = valueOf(col, b);
        if (va === vb) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
        return dir === 'asc' ? cmp : -cmp;
      });
    }
    return sorted;
  }

  function render() {
    headers.forEach((th, i) => {
      if (columns[i].key === key) th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
    const trs = [];
    for (const r of sortRows(rows)) {
      const parent = !!r.children?.length;
      trs.push(h('tr', { class: parent ? 'parent-row' : null }, columns.map((c, i) => cell(c, r, i, { parent }))));
      if (parent && expanded.has(r)) {
        for (const ch of sortRows(r.children)) trs.push(h('tr', { class: 'child-row' }, columns.map((c, i) => cell(c, ch, i, { child: true }))));
      }
    }
    tbody.replaceChildren(...trs);
    tfoot.replaceChildren(...(total ? [h('tr', { class: 'total' }, columns.map((c, i) => cell(c, total, i)))] : []));
    if (expander) expander.textContent = expanded.size === expandable.length ? 'Collapse all' : 'Expand all';
  }

  const expander = expandable.length
    ? h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => {
          if (expanded.size === expandable.length) expanded.clear();
          else expandable.forEach((r) => expanded.add(r));
          render();
        },
      })
    : null;
  render();

  const table = h('table', {}, h('thead', {}, h('tr', {}, headers)), tbody, tfoot);
  const exportCsv = () => {
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : '';
      let s = String(v);
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheets treating names as formulas
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const line = (r, child) => columns.map((c, i) => {
      const v = c.csv ? c.csv(r) : valueOf(c, r);
      return esc(child && i === 0 ? `   ${v ?? ''}` : v);
    }).join(',');
    // Export includes every detail row, indented under its group.
    const lines = [columns.map((c) => esc(c.label)).join(',')];
    for (const r of sortRows(rows)) {
      lines.push(line(r));
      for (const ch of r.children ? sortRows(r.children) : []) lines.push(line(ch, true));
    }
    if (total) lines.push(line(total));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${filename}.csv` });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  };
  return { el: h('div', { class: 'table-wrap' }, table), exportCsv, expander };
}

/** Delta cell: coloured +/-% with an arrow icon so it's never colour alone. */
export function deltaNode(value, { invert = false, formatter = fmt.signedPct } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return h('span', { class: 'muted' }, '—');
  const good = invert ? value < 0 : value > 0;
  const cls = Math.abs(value) < 0.0005 ? '' : good ? 'pos' : 'neg';
  return h('span', { class: cls }, formatter(value));
}
