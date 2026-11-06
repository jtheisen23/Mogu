// App shell: loads the signed-in user, builds filters and tabs, keeps state in
// the URL hash (so any view can be bookmarked or shared), and renders views.

import { disposeCharts, rethemeCharts } from './js/charts.js';
import { adminView } from './js/admin.js';
import * as views from './js/views.js';
import { compareRange, COMPARES, daysBetween, fmtDateLong, fmtRange, h, localToday, PRESETS, presetRange } from './js/util.js';

const TABS = [
  { id: 'overview', label: 'Overview', section: 'sales', render: views.overview },
  { id: 'locations', label: 'Compare locations', section: 'sales', render: views.locations },
  { id: 'mix', label: 'Sales mix', section: 'sales', render: views.mix },
  { id: 'discounts', label: 'Discounts & comps', section: 'discounts', render: views.discounts },
  { id: 'labor', label: 'Labor', section: 'labor', render: views.labor },
  { id: 'items', label: 'Menu items', section: 'items', render: views.items },
  { id: 'sevenshifts', label: '7shifts', section: 'sevenshifts', render: views.sevenShifts },
  { id: 'admin', label: 'Admin', admin: true, render: adminView },
];

const $ = (id) => document.getElementById(id);
let user;
let allLocations = [];
let state;
let renderSeq = 0;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function request(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON (e.g. Access login page) */ }
  if (!res.ok) {
    const err = new Error(body?.error || (res.status === 401 ? 'Your session expired — reload the page to sign in again.' : `Request failed (${res.status})`));
    err.status = res.status;
    throw err;
  }
  if (!body) throw new Error('Unexpected response — reload the page to sign in again.');
  return body;
}

function queryParams(extra) {
  const q = resolvedPeriods();
  const p = new URLSearchParams({ start: q.current.start, end: q.current.end, locations: state.locs.join(',') });
  if (q.compare) { p.set('cstart', q.compare.start); p.set('cend', q.compare.end); }
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p;
}

// ---------------------------------------------------------------------------
// State <-> URL hash
// ---------------------------------------------------------------------------
function defaultGrain(period) {
  const days = daysBetween(period.start, period.end) + 1;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}

function readState() {
  const p = new URLSearchParams(location.hash.slice(1));
  const allowedTabs = visibleTabs().map((t) => t.id);
  const ids = allLocations.map((l) => l.id);
  const s = {
    tab: allowedTabs.includes(p.get('tab')) ? p.get('tab') : allowedTabs[0],
    preset: PRESETS.some(([k]) => k === p.get('preset')) ? p.get('preset') : 'last7',
    start: p.get('start') || '',
    end: p.get('end') || '',
    cmp: COMPARES.some(([k]) => k === p.get('cmp')) ? p.get('cmp') : 'yoy364',
    cstart: p.get('cstart') || '',
    cend: p.get('cend') || '',
    grain: ['day', 'week', 'month'].includes(p.get('grain')) ? p.get('grain') : null,
    locs: (p.get('loc') || '').split(',').filter((x) => ids.includes(x)),
  };
  if (!s.locs.length) s.locs = ids;
  if (s.preset === 'custom' && !(s.start && s.end)) {
    Object.assign(s, presetRange('last7'));
  }
  if (!s.grain) s.grain = defaultGrain(s.preset === 'custom' ? s : presetRange(s.preset));
  return s;
}

function writeState() {
  const p = new URLSearchParams({ tab: state.tab, preset: state.preset, cmp: state.cmp, grain: state.grain });
  if (state.preset === 'custom') { p.set('start', state.start); p.set('end', state.end); }
  if (state.cmp === 'custom') { p.set('cstart', state.cstart); p.set('cend', state.cend); }
  if (state.locs.length !== allLocations.length) p.set('loc', state.locs.join(','));
  history.replaceState(null, '', `#${p}`);
}

function resolvedPeriods() {
  const current = state.preset === 'custom' ? { start: state.start, end: state.end } : presetRange(state.preset);
  let compare = null;
  if (state.cmp === 'custom') compare = state.cstart && state.cend ? { start: state.cstart, end: state.cend } : null;
  else if (state.cmp !== 'none') compare = compareRange(state.cmp, current);
  return { current, compare };
}

// ---------------------------------------------------------------------------
// Filters, tabs
// ---------------------------------------------------------------------------
function visibleTabs() {
  return TABS.filter((t) => (t.admin ? user.isAdmin : user.sections[t.section]));
}

function buildFilters() {
  const preset = $('f-preset');
  preset.replaceChildren(...PRESETS.map(([k, label]) => h('option', { value: k }, label)));
  const cmp = $('f-compare');
  cmp.replaceChildren(...COMPARES.map(([k, label]) => h('option', { value: k }, label)));

  preset.addEventListener('change', () => {
    state.preset = preset.value;
    if (state.preset === 'custom') {
      const cur = resolvedPeriods().current;
      state.start = state.start || cur?.start || localToday();
      state.end = state.end || cur?.end || localToday();
    }
    state.grain = defaultGrain(resolvedPeriods().current);
    update();
  });
  cmp.addEventListener('change', () => {
    state.cmp = cmp.value;
    if (state.cmp === 'custom' && !(state.cstart && state.cend)) {
      const guess = compareRange('yoy364', resolvedPeriods().current);
      state.cstart = guess.start;
      state.cend = guess.end;
    }
    update();
  });
  for (const [id, key] of [['f-start', 'start'], ['f-end', 'end'], ['f-cstart', 'cstart'], ['f-cend', 'cend']]) {
    $(id).addEventListener('change', (e) => {
      state[key] = e.target.value;
      const a = key.startsWith('c') ? 'cstart' : 'start';
      const b = key.startsWith('c') ? 'cend' : 'end';
      if (state[a] && state[b] && state[a] > state[b]) state[key === a ? b : a] = state[key];
      update();
    });
  }
  $('f-grain').addEventListener('change', (e) => { state.grain = e.target.value; update(); });

  const chips = $('f-locations');
  if (allLocations.length < 2) chips.parentElement.hidden = true;
  chips.replaceChildren(
    ...allLocations.map((l) =>
      h('button', {
        type: 'button', class: 'chip', dataset: { id: l.id },
        style: { '--dot': `var(--s${(l.colorIndex % 8) + 1})` },
        onclick: (e) => {
          const id = l.id;
          if (e.altKey || e.metaKey) state.locs = [id]; // alt/cmd-click = only this one
          else if (state.locs.includes(id)) { if (state.locs.length > 1) state.locs = state.locs.filter((x) => x !== id); }
          else state.locs = allLocations.map((x) => x.id).filter((x) => x === id || state.locs.includes(x));
          update();
        },
        title: 'Click to toggle · Alt/⌘-click to show only this location',
      }, h('span', { class: 'dot' }), l.name)),
    allLocations.length > 2 ? h('button', { type: 'button', class: 'chip', onclick: () => { state.locs = allLocations.map((l) => l.id); update(); } }, 'All') : null,
  );
}

function syncFilters() {
  $('f-preset').value = state.preset;
  $('f-compare').value = state.cmp;
  $('f-grain').value = state.grain;
  $('f-custom').hidden = state.preset !== 'custom';
  $('f-ccustom').hidden = state.cmp !== 'custom';
  $('f-start').value = state.start;
  $('f-end').value = state.end;
  $('f-cstart').value = state.cstart;
  $('f-cend').value = state.cend;
  for (const chip of $('f-locations').querySelectorAll('.chip[data-id]')) {
    chip.setAttribute('aria-pressed', String(state.locs.includes(chip.dataset.id)));
  }
  const { current, compare } = resolvedPeriods();
  $('period-label').replaceChildren(
    h('div', {}, h('b', {}, fmtRange(current))),
    compare ? h('div', {}, `vs ${fmtRange(compare)}`) : null,
  );
  // Filters don't apply on the admin tab.
  document.querySelector('.filters').hidden = state.tab === 'admin';
}

function buildTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren(...visibleTabs().map((t) =>
    h('button', { class: 'tab', role: 'tab', type: 'button', dataset: { id: t.id }, onclick: () => { state.tab = t.id; update(); } }, t.label)));
}

function syncTabs() {
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.id === state.tab));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function update() {
  writeState();
  syncFilters();
  syncTabs();
  render();
}

/**
 * A period that starts before the earliest loaded day (while the backfill
 * runs, or before its FROM date) would show understated totals and inflated
 * changes, so say so instead of letting the numbers mislead.
 */
function historyWarning({ current, compare }) {
  const firsts = allLocations
    .filter((l) => state.locs.includes(l.id))
    .map((l) => l.first_business_date)
    .filter(Boolean)
    .sort();
  const loadedFrom = firsts[firsts.length - 1]; // the location with the least history
  if (!loadedFrom) return null;
  const partial = [];
  if (current.start < loadedFrom) partial.push('the selected dates');
  if (compare && compare.start < loadedFrom) partial.push('the comparison dates');
  if (!partial.length) return null;
  return h('div', { class: 'notice' },
    h('b', {}, `Data starts ${fmtDateLong(loadedFrom)}. `),
    `Totals and changes for ${partial.join(' and ')} are incomplete because earlier days aren't in the dashboard yet.`);
}

async function render() {
  const seq = ++renderSeq;
  const view = $('view');
  const tab = TABS.find((t) => t.id === state.tab);
  const periods = resolvedPeriods();
  view.classList.add('loading');

  if (!periods.current?.start || !periods.current?.end) {
    view.classList.remove('loading');
    view.replaceChildren(h('div', { class: 'empty' }, 'Pick a start and end date.'));
    return;
  }

  const ctx = {
    user,
    q: { ...periods, locations: state.locs, grain: state.grain },
    loc: (id) => allLocations.find((l) => l.id === id) || { id, name: id, colorIndex: 0 },
    api: (path, extra, opts = {}) => request(opts.noQuery ? path : `${path}?${queryParams(extra)}`),
    post: (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    del: (path) => request(path, { method: 'DELETE' }),
    rerender: () => render(),
  };

  try {
    const node = await tab.render(ctx);
    if (seq !== renderSeq) return; // a newer render started
    disposeCharts();
    const warning = tab.id === 'admin' ? null : historyWarning(periods);
    view.replaceChildren(...(warning ? [warning] : []), node);
  } catch (err) {
    if (seq !== renderSeq) return;
    disposeCharts();
    view.replaceChildren(h('div', { class: 'error' }, err.message));
  } finally {
    if (seq === renderSeq) view.classList.remove('loading');
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* storage blocked */ }
  const buttons = [...$('theme-toggle').querySelectorAll('button')];
  const apply = (mode) => {
    // 'auto' removes the override so the page follows the device setting.
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.theme === mode));
    rethemeCharts();
  };
  apply(saved === 'light' || saved === 'dark' ? saved : 'auto');
  for (const b of buttons) {
    b.addEventListener('click', () => {
      try { localStorage.setItem('theme', b.dataset.theme); } catch { /* ignore */ }
      apply(b.dataset.theme);
    });
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => rethemeCharts());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  initTheme();
  try {
    ({ user } = await request('/api/me'));
    const { locations } = await request('/api/locations');
    allLocations = locations.map((l, i) => ({ ...l, colorIndex: i }));
  } catch (err) {
    document.querySelector('.filters').hidden = true;
    $('view').replaceChildren(h('div', { class: 'card error' }, err.message));
    return;
  }

  $('user-badge').replaceChildren(h('b', {}, user.name || user.email), ` · ${user.isAdmin ? 'Admin' : 'Viewer'}`);
  const lastSync = allLocations.map((l) => l.last_synced_at).filter(Boolean).sort().pop();
  const lastDate = allLocations.map((l) => l.last_business_date).filter(Boolean).sort().pop();
  const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (lastDate) {
    // Yesterday is only final once re-synced after the day ended; until then
    // late orders (the dinner rush) may be missing.
    const withYesterday = allLocations.filter((l) => l.yesterday_synced_at);
    const yesterdayNote = !withYesterday.length
      ? ''
      : withYesterday.every((l) => l.yesterday_complete)
        ? ' · yesterday final ✓'
        : ` · yesterday not final yet (updated ${when(withYesterday.map((l) => l.yesterday_synced_at).sort()[0])})`;
    $('freshness').textContent = `Data through ${fmtDateLong(lastDate)}${lastSync ? ` · synced ${when(lastSync)}` : ''}${yesterdayNote}`;
  }

  if (!allLocations.length && !user.isAdmin) {
    document.querySelector('.filters').hidden = true;
    $('view').replaceChildren(h('div', { class: 'card empty' }, 'Your account has no locations assigned yet. Ask an admin to grant access.'));
    return;
  }

  state = readState();
  buildFilters();
  buildTabs();
  window.addEventListener('hashchange', () => {
    state = readState();
    syncFilters();
    syncTabs();
    render();
  });
  await new Promise((r) => (window.echarts ? r() : window.addEventListener('load', r, { once: true })));
  update();
}

boot();
