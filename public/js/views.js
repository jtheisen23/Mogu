// Dashboard tabs. Each view receives a context:
//   { q: {current, compare, locations, grain}, user, api(path, params), loc(id) -> {id,name,colorIndex} }
// and returns a DOM node.

import { barChart, lineChart } from './charts.js';
import {
  bucketLabel, bucketize, bucketsFor, change, dataTable, deltaNode, div, eachDate, fmt, fmtDate, fmtRange, fmtWeekday, h,
  ICON_DOWN, ICON_UP, sumBy, svgIcon, toDate, totals, WEEKDAYS,
} from './util.js';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
function card(title, sub, tools, ...body) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null),
      tools ? h('div', { class: 'card-tools' }, tools) : null),
    ...body);
}

function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  const buttons = options.map(([v, label]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btnFor(v))));
      onChange(v);
    } }, label));
  const btnFor = (v) => buttons[options.findIndex(([o]) => o === v)];
  wrap.append(...buttons);
  return wrap;
}

function csvButton(getTable) {
  return h('button', { class: 'btn', type: 'button', onclick: () => getTable().exportCsv() }, 'Export CSV');
}

/** KPI tile. `better`: 'up' (default), 'down' (e.g. labor %), or 'none'. `mode`: 'pct' change or 'pts' for rates. */
function kpi(label, value, prev, { format, better = 'up', mode = 'pct', hasCompare }) {
  let delta = null;
  if (hasCompare) {
    const d = mode === 'pts' ? (value !== null && prev !== null ? value - prev : null) : change(value, prev);
    if (d === null || !Number.isFinite(d)) {
      delta = h('div', { class: 'delta' }, h('span', { class: 'muted' }, 'no comparison data'));
    } else {
      const flat = Math.abs(d) < 0.0005;
      const good = better === 'none' || flat ? null : better === 'up' ? d > 0 : d < 0;
      const cls = good === null ? 'flat' : good ? 'good' : 'bad';
      delta = h('div', { class: 'delta' },
        h('span', { class: `chg ${cls}` }, flat ? null : svgIcon(d > 0 ? ICON_UP : ICON_DOWN), mode === 'pts' ? fmt.pts(d) : fmt.signedPct(d)),
        h('span', {}, `vs ${format(prev)}`));
    }
  }
  return h('div', { class: 'card kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, format(value)), delta);
}

function locCell(ctx, id) {
  const l = ctx.loc(id);
  return h('span', {}, h('span', { class: 'swatch', style: { background: `var(--s${(l.colorIndex % 8) + 1})` } }), l.name);
}

function chartBox(tall) {
  return h('div', { class: tall ? 'chart tall' : 'chart' });
}

/** Mount a chart after the node is in the document (ECharts needs a sized element). */
function later(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

const SALES_FIELDS = ['orders', 'guests', 'gross_sales', 'discounts', 'net_sales', 'voids', 'void_count', 'checks', 'tips'];
const LABOR_FIELDS = ['hours', 'overtime_hours', 'cost'];

/** Joins daily sales and labor rows on (date, location). */
function mergeDaily(sales, labor) {
  const map = new Map();
  const key = (r) => `${r.business_date}|${r.location_id}`;
  for (const r of sales || []) map.set(key(r), { ...r });
  for (const r of labor || []) {
    const k = key(r);
    if (!map.has(k)) map.set(k, { business_date: r.business_date, location_id: r.location_id });
    Object.assign(map.get(k), { hours: r.hours, cost: r.cost, overtime_hours: r.overtime_hours });
  }
  return [...map.values()];
}

const METRICS = {
  net_sales: { label: 'Net sales', calc: (t) => t.net_sales, fmt: fmt.money, axis: fmt.moneyShort },
  orders: { label: 'Orders', calc: (t) => t.orders, fmt: fmt.int },
  avg_check: { label: 'Avg check', calc: (t) => div(t.net_sales, t.orders), fmt: fmt.money2, rate: true },
  guests: { label: 'Guests', calc: (t) => t.guests, fmt: fmt.int },
  discount_pct: { label: 'Discount %', calc: (t) => div(t.discounts, t.gross_sales), fmt: fmt.pct, rate: true, needs: 'discounts' },
  labor_pct: { label: 'Labor %', calc: (t) => div(t.cost, t.net_sales), fmt: fmt.pct, rate: true, needs: 'labor' },
  splh: { label: 'Sales / labor hr', calc: (t) => div(t.net_sales, t.hours), fmt: fmt.money2, rate: true, needs: 'labor' },
};
const availableMetrics = (user) => Object.entries(METRICS).filter(([, m]) => !m.needs || user.sections[m.needs]);

/**
 * Current-vs-compare series for a metric over time buckets. Comparison
 * buckets are aligned by position (1st week vs 1st week, etc.).
 */
function trendSeries(ctx, rowsCur, rowsCmp, m, byLocation) {
  const { grain, current, compare } = ctx.q;
  const fields = [...SALES_FIELDS, ...LABOR_FIELDS];
  const keys = bucketsFor(current, grain);
  const categories = keys.map((k) => bucketLabel(k, grain));

  if (byLocation) {
    const b = bucketize(rowsCur, grain, 'location_id', fields);
    return {
      categories,
      series: ctx.q.locations.map((id) => ({
        name: ctx.loc(id).name,
        colorIndex: ctx.loc(id).colorIndex,
        data: keys.map((k) => {
          const t = b.get(k)?.get(id);
          return t ? m.calc(t) : null;
        }),
      })),
    };
  }
  const b = bucketize(rowsCur, grain, null, fields);
  const series = [{
    name: 'Current',
    colorIndex: 0,
    data: keys.map((k) => { const t = b.get(k)?.get('_all'); return t ? m.calc(t) : null; }),
  }];
  if (compare && rowsCmp) {
    const ckeys = bucketsFor(compare, grain);
    const cb = bucketize(rowsCmp, grain, null, fields);
    series.push({
      name: 'Comparison',
      color: 'compare',
      dashed: true,
      labels: keys.map((_, i) => (ckeys[i] ? bucketLabel(ckeys[i], grain) : '')),
      data: keys.map((_, i) => { const t = ckeys[i] && cb.get(ckeys[i])?.get('_all'); return t ? m.calc(t) : null; }),
    });
  }
  return { categories, series };
}

function subtitle(ctx) {
  return ctx.q.compare ? `${fmtRange(ctx.q.current)} vs ${fmtRange(ctx.q.compare)}` : fmtRange(ctx.q.current);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const overviewState = { metric: 'net_sales', split: 'total' };

export async function overview(ctx) {
  const data = await ctx.api('/api/overview');
  const hasCmp = !!ctx.q.compare;
  const { user } = ctx;
  const T = totals(data.totals.current, SALES_FIELDS);
  const C = hasCmp ? totals(data.totals.compare, SALES_FIELDS) : null;
  const L = data.labor ? totals(data.labor.current, LABOR_FIELDS) : null;
  const LC = data.labor && hasCmp ? totals(data.labor.compare, LABOR_FIELDS) : null;
  const o = { hasCompare: hasCmp };

  const tiles = [
    kpi('Net sales', T.net_sales, C?.net_sales, { ...o, format: fmt.money }),
    kpi('Orders', T.orders, C?.orders, { ...o, format: fmt.int }),
    kpi('Avg check', div(T.net_sales, T.orders), C && div(C.net_sales, C.orders), { ...o, format: fmt.money2 }),
    kpi('Guests', T.guests, C?.guests, { ...o, format: fmt.int }),
  ];
  if (user.sections.discounts) {
    tiles.push(kpi('Discounts & comps', T.discounts, C?.discounts, { ...o, format: fmt.money, better: 'down' }));
    tiles.push(kpi('Discount % of gross', div(T.discounts, T.gross_sales), C && div(C.discounts, C.gross_sales), { ...o, format: fmt.pct, better: 'down', mode: 'pts' }));
  }
  if (L) {
    tiles.push(kpi('Labor cost', L.cost, LC?.cost, { ...o, format: fmt.money, better: 'down' }));
    tiles.push(kpi('Labor % of net sales', div(L.cost, T.net_sales), LC && div(LC.cost, C.net_sales), { ...o, format: fmt.pct, better: 'down', mode: 'pts' }));
    tiles.push(kpi('Sales per labor hour', div(T.net_sales, L.hours), LC && div(C.net_sales, LC.hours), { ...o, format: fmt.money2 }));
  }

  // Trend chart
  const rowsCur = mergeDaily(data.daily.current, data.laborDaily?.current);
  const rowsCmp = hasCmp ? mergeDaily(data.daily.compare, data.laborDaily?.compare) : null;
  const chartEl = chartBox(true);
  const draw = () => {
    chartEl.replaceChildren();
    window.echarts.getInstanceByDom(chartEl)?.dispose();
    const m = METRICS[overviewState.metric];
    const { categories, series } = trendSeries(ctx, rowsCur, rowsCmp, m, overviewState.split === 'location');
    lineChart(chartEl, { categories, series, format: m.fmt, axisFormat: m.axis || m.fmt, area: overviewState.split === 'total' && !m.rate, zeroBased: !m.rate });
  };
  if (!METRICS[overviewState.metric] || (METRICS[overviewState.metric].needs && !user.sections[METRICS[overviewState.metric].needs])) {
    overviewState.metric = 'net_sales';
  }
  const metricSelect = h('select', { 'aria-label': 'Metric', onchange: (e) => { overviewState.metric = e.target.value; draw(); } },
    availableMetrics(user).map(([k, m]) => h('option', { value: k, selected: k === overviewState.metric }, m.label)));
  const splitSeg = seg([['total', 'Total vs comparison'], ['location', 'By location']], overviewState.split, (v) => { overviewState.split = v; draw(); });

  // Location table
  const table = locationTable(ctx, data, { compact: true });

  const node = h('div', {},
    h('div', { class: 'grid kpis' }, tiles),
    card('Trend', `${subtitle(ctx)} · by ${ctx.q.grain}`, [metricSelect, splitSeg], chartEl),
    card('Locations', subtitle(ctx), csvButton(() => table), table.el),
  );
  later(draw);
  return node;
}

/** Per-location scorecard used by Overview and Locations. */
function locationTable(ctx, data, { compact = false } = {}) {
  const { user } = ctx;
  const hasCmp = !!ctx.q.compare;
  const cur = new Map((data.totals.current || []).map((r) => [r.location_id, r]));
  const cmp = new Map((data.totals.compare || []).map((r) => [r.location_id, r]));
  const lab = new Map((data.labor?.current || []).map((r) => [r.location_id, r]));
  const labC = new Map((data.labor?.compare || []).map((r) => [r.location_id, r]));

  const build = (id, c, p, l, lp) => ({
    id,
    name: id ? ctx.loc(id).name : 'All selected',
    net: c?.net_sales ?? 0,
    netCmp: p?.net_sales ?? null,
    days: c?.days ?? null,
    orders: c?.orders ?? 0,
    guests: c?.guests ?? 0,
    avgCheck: div(c?.net_sales, c?.orders),
    avgCheckCmp: p ? div(p.net_sales, p.orders) : null,
    perGuest: div(c?.net_sales, c?.guests),
    discPct: div(c?.discounts, c?.gross_sales),
    discPctCmp: p ? div(p.discounts, p.gross_sales) : null,
    voids: c?.voids ?? null,
    laborCost: l?.cost ?? null,
    laborPct: div(l?.cost, c?.net_sales),
    laborPctCmp: lp && p ? div(lp.cost, p.net_sales) : null,
    splh: div(c?.net_sales, l?.hours),
    otHours: l?.overtime_hours ?? null,
  });
  const rows = ctx.q.locations.map((id) => build(id, cur.get(id), cmp.get(id), lab.get(id), labC.get(id)));
  const sum = (m, f) => [...m.values()].reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const agg = (m, fields) => (m.size ? Object.fromEntries(fields.map((f) => [f, sum(m, f)])) : null);
  const total = build(null, agg(cur, SALES_FIELDS), hasCmp ? agg(cmp, SALES_FIELDS) : null, agg(lab, LABOR_FIELDS), hasCmp ? agg(labC, LABOR_FIELDS) : null);
  total.days = null;
  const totalNet = total.net || 0;

  const cols = [
    { key: 'name', label: 'Location', text: true, render: (r) => (r.id ? locCell(ctx, r.id) : r.name) },
    { key: 'net', label: 'Net sales', fmt: fmt.money },
  ];
  if (hasCmp) {
    cols.push({ key: 'netCmp', label: 'Comparison', fmt: fmt.money });
    cols.push({ key: 'netChg', label: 'Change', value: (r) => change(r.net, r.netCmp), render: (r) => deltaNode(change(r.net, r.netCmp)) });
  }
  cols.push({ key: 'share', label: 'Share', value: (r) => div(r.net, totalNet), fmt: fmt.pct });
  if (!compact) cols.push({ key: 'perDay', label: 'Net / day', value: (r) => div(r.net, r.days), fmt: fmt.money });
  cols.push({ key: 'orders', label: 'Orders', fmt: fmt.int });
  cols.push({ key: 'avgCheck', label: 'Avg check', fmt: fmt.money2 });
  if (hasCmp && !compact) cols.push({ key: 'avgCheckChg', label: 'Avg check chg', value: (r) => change(r.avgCheck, r.avgCheckCmp), render: (r) => deltaNode(change(r.avgCheck, r.avgCheckCmp)) });
  if (!compact) {
    cols.push({ key: 'guests', label: 'Guests', fmt: fmt.int });
    cols.push({ key: 'perGuest', label: 'Per guest', fmt: fmt.money2 });
  }
  if (user.sections.discounts) {
    cols.push({ key: 'discPct', label: 'Discount %', fmt: fmt.pct });
    if (!compact) cols.push({ key: 'voids', label: 'Voids', fmt: fmt.money });
  }
  if (user.sections.labor) {
    if (!compact) cols.push({ key: 'laborCost', label: 'Labor $', fmt: fmt.money });
    cols.push({ key: 'laborPct', label: 'Labor %', fmt: fmt.pct });
    if (hasCmp) cols.push({ key: 'laborPctChg', label: 'Labor % chg', value: (r) => (r.laborPct !== null && r.laborPctCmp !== null ? r.laborPct - r.laborPctCmp : null), render: (r) => deltaNode(r.laborPct !== null && r.laborPctCmp !== null ? r.laborPct - r.laborPctCmp : null, { invert: true, formatter: fmt.pts }) });
    cols.push({ key: 'splh', label: 'SPLH', fmt: fmt.money2 });
    if (!compact) cols.push({ key: 'otHours', label: 'OT hrs', fmt: fmt.dec1 });
  }
  return dataTable({ columns: cols, rows, total: rows.length > 1 ? total : null, sortKey: 'net', filename: 'locations' });
}

// ---------------------------------------------------------------------------
// Compare locations
// ---------------------------------------------------------------------------
const locationsState = { metric: 'net_sales', daypart: 'avg' };

export async function locations(ctx) {
  const [data, weekday, hourly] = await Promise.all([
    ctx.api('/api/overview'),
    ctx.api('/api/mix', { dimension: 'weekday' }),
    ctx.api('/api/mix', { dimension: 'hour' }),
  ]);
  const { user } = ctx;
  const hasCmp = !!ctx.q.compare;
  const ids = ctx.q.locations;

  // Metric by location: current vs comparison
  const perLoc = (tot, lab) => {
    const s = new Map((tot || []).map((r) => [r.location_id, r]));
    const l = new Map((lab || []).map((r) => [r.location_id, r]));
    return (id) => ({ ...(s.get(id) || {}), ...(l.get(id) ? { hours: l.get(id).hours, cost: l.get(id).cost } : {}) });
  };
  const cur = perLoc(data.totals.current, data.labor?.current);
  const cmp = hasCmp ? perLoc(data.totals.compare, data.labor?.compare) : null;

  const barEl = chartBox();
  const drawBars = () => {
    window.echarts.getInstanceByDom(barEl)?.dispose();
    const m = METRICS[locationsState.metric];
    const val = (t) => (t && Object.keys(t).length ? m.calc(t) : null);
    const series = [{ name: 'Current', colorIndex: 0, data: ids.map((id) => val(cur(id))) }];
    if (cmp) series.push({ name: 'Comparison', color: 'compare', data: ids.map((id) => val(cmp(id))) });
    barChart(barEl, { categories: ids.map((id) => ctx.loc(id).name), series, horizontal: true, format: m.fmt, axisFormat: m.axis || m.fmt });
  };
  const metricSelect = h('select', { 'aria-label': 'Metric', onchange: (e) => { locationsState.metric = e.target.value; drawBars(); } },
    availableMetrics(user).map(([k, m]) => h('option', { value: k, selected: k === locationsState.metric }, m.label)));

  // Average net sales by weekday, one bar series per location
  const wdEl = chartBox();
  const wd = new Map((weekday.current || []).map((r) => [`${r.location_id}|${r.label}`, r]));
  const order = [1, 2, 3, 4, 5, 6, 0];
  const wdSeries = ids.map((id) => ({
    name: ctx.loc(id).name,
    colorIndex: ctx.loc(id).colorIndex,
    data: order.map((d) => { const r = wd.get(`${id}|${d}`); return r ? div(r.net_sales, r.days) : null; }),
  }));

  // Average net sales by hour of day
  const hrEl = chartBox();
  const days = Math.max(1, (Date.parse(ctx.q.current.end) - Date.parse(ctx.q.current.start)) / 86400000 + 1);
  const hr = new Map((hourly.current || []).map((r) => [`${r.location_id}|${r.label}`, r]));
  const hoursPresent = [...new Set((hourly.current || []).map((r) => r.label))].sort((a, b) => a - b);
  const hourLabel = (x) => `${x % 12 || 12}${x < 12 ? 'a' : 'p'}`;
  const hrSeries = ids.map((id) => ({
    name: ctx.loc(id).name,
    colorIndex: ctx.loc(id).colorIndex,
    data: hoursPresent.map((x) => { const r = hr.get(`${id}|${x}`); return r ? r.net_sales / days : 0; }),
  }));

  const table = locationTable(ctx, data);
  const node = h('div', {},
    card('Scorecard', subtitle(ctx), csvButton(() => table), table.el),
    h('div', { class: 'grid two' },
      card('Location vs location', subtitle(ctx), metricSelect, barEl),
      card('Average day by weekday', `Net sales per ${ctx.q.current.start === ctx.q.current.end ? 'day' : 'weekday'} · ${fmtRange(ctx.q.current)}`, null, wdEl)),
    card('Average net sales by hour', `Per day, by hour the order was opened · ${fmtRange(ctx.q.current)}`, null, hrEl),
  );
  later(() => {
    drawBars();
    barChart(wdEl, { categories: order.map((d) => WEEKDAYS[d]), series: wdSeries, format: fmt.money, axisFormat: fmt.moneyShort });
    lineChart(hrEl, { categories: hoursPresent.map(hourLabel), series: hrSeries, format: fmt.money, axisFormat: fmt.moneyShort });
  });
  return node;
}

// ---------------------------------------------------------------------------
// Sales mix
// ---------------------------------------------------------------------------
const mixState = { dimension: 'sales_category' };

export async function mix(ctx) {
  const holder = h('div');
  const load = async () => {
    const data = await ctx.api('/api/mix', { dimension: mixState.dimension });
    holder.replaceChildren(renderMix(ctx, data));
  };
  const dimSeg = seg([['sales_category', 'Sales category'], ['dining_option', 'Dining option'], ['revenue_center', 'Revenue center']],
    mixState.dimension, async (v) => { mixState.dimension = v; holder.style.opacity = 0.55; await load(); holder.style.opacity = 1; });
  await load();
  return h('div', {}, h('div', { class: 'card-tools', style: { marginBottom: '12px' } }, dimSeg), holder);
}

function renderMix(ctx, data) {
  const hasCmp = !!ctx.q.compare;
  const ids = ctx.q.locations;
  const fields = ['net_sales', 'orders', 'quantity'];
  const cur = sumBy(data.current, 'label', fields);
  const cmp = hasCmp ? sumBy(data.compare, 'label', fields) : new Map();
  const curTotal = totals(data.current, fields).net_sales;
  const cmpTotal = hasCmp ? totals(data.compare, fields).net_sales : null;
  // Rows arrive per (location, group, Toast name). Charts use group totals;
  // the table expands a group into the Toast names inside it.
  const byLoc = sumBy(data.current, (r) => `${r.location_id}|${r.label}`, fields);
  const locTotals = sumBy(data.current, 'location_id', ['net_sales']);
  const srcKey = (r) => `${r.label}|${r.source_label ?? r.label}`;
  const curSrc = sumBy(data.current, srcKey, fields);
  const cmpSrc = hasCmp ? sumBy(data.compare, srcKey, fields) : new Map();
  const locSrc = sumBy(data.current, (r) => `${r.location_id}|${srcKey(r)}`, fields);
  const sourcesOf = new Map();
  for (const r of [...(data.current || []), ...(data.compare || [])]) {
    if (!sourcesOf.has(r.label)) sourcesOf.set(r.label, new Set());
    sourcesOf.get(r.label).add(r.source_label ?? r.label);
  }

  const labels = [...new Set([...cur.keys(), ...cmp.keys()])].sort((a, b) => (cur.get(b)?.net_sales || 0) - (cur.get(a)?.net_sales || 0));
  const makeRow = (label, c, p, locOf) => ({
    label,
    net: c?.net_sales ?? 0,
    share: div(c?.net_sales ?? 0, curTotal),
    netCmp: hasCmp ? p?.net_sales ?? 0 : null,
    shareCmp: hasCmp ? div(p?.net_sales ?? 0, cmpTotal) : null,
    orders: c?.orders ?? 0,
    ...Object.fromEntries(ids.map((id) => [`loc_${id}`, div(locOf(id)?.net_sales ?? 0, locTotals.get(id)?.net_sales)])),
  });
  const rows = labels.map((label) => {
    const row = makeRow(label, cur.get(label), cmp.get(label), (id) => byLoc.get(`${id}|${label}`));
    const sources = [...(sourcesOf.get(label) || [])];
    // Only groups (several Toast names, or a renamed one) get detail rows.
    if (sources.length > 1 || (sources.length === 1 && sources[0] !== label)) {
      row.children = sources.map((src) => {
        const k = `${label}|${src}`;
        return makeRow(src, curSrc.get(k), cmpSrc.get(k), (id) => locSrc.get(`${id}|${k}`));
      });
    }
    return row;
  });
  const dimLabel = { sales_category: 'Sales category', dining_option: 'Dining option', revenue_center: 'Revenue center' }[data.dimension];
  const cols = [
    { key: 'label', label: dimLabel, text: true },
    { key: 'net', label: 'Net sales', fmt: fmt.money },
    { key: 'share', label: 'Share', fmt: fmt.pct },
  ];
  if (hasCmp) {
    cols.push({ key: 'netCmp', label: 'Comparison', fmt: fmt.money });
    cols.push({ key: 'chg', label: 'Change', value: (r) => change(r.net, r.netCmp), render: (r) => deltaNode(change(r.net, r.netCmp)) });
    cols.push({ key: 'shareChg', label: 'Share chg', value: (r) => (r.shareCmp === null ? null : r.share - r.shareCmp), render: (r) => deltaNode(r.shareCmp === null ? null : r.share - r.shareCmp, { formatter: fmt.pts }) });
  }
  if (data.dimension !== 'sales_category') cols.push({ key: 'orders', label: 'Orders', fmt: fmt.int });
  if (ids.length > 1) for (const id of ids) cols.push({ key: `loc_${id}`, label: `${ctx.loc(id).name} share`, fmt: fmt.pct });
  const table = dataTable({ columns: cols, rows, sortKey: 'net', filename: `mix-${data.dimension}` });

  // Share of each location's sales, stacked to 100%
  const stackEl = chartBox();
  const top = labels.slice(0, 7);
  const rest = labels.slice(7);
  const stackSeries = top.map((label, i) => ({
    name: label,
    colorIndex: i,
    data: ids.map((id) => div(byLoc.get(`${id}|${label}`)?.net_sales ?? 0, locTotals.get(id)?.net_sales)),
  }));
  if (rest.length) {
    stackSeries.push({
      name: 'Other',
      color: 'compare',
      data: ids.map((id) => div(rest.reduce((a, l) => a + (byLoc.get(`${id}|${l}`)?.net_sales ?? 0), 0), locTotals.get(id)?.net_sales)),
    });
  }
  const barEl = chartBox();
  const barSeries = [{ name: 'Current', colorIndex: 0, data: labels.slice(0, 12).map((l) => cur.get(l)?.net_sales ?? 0) }];
  if (hasCmp) barSeries.push({ name: 'Comparison', color: 'compare', data: labels.slice(0, 12).map((l) => cmp.get(l)?.net_sales ?? 0) });

  const node = h('div', {},
    h('div', { class: 'grid two' },
      card(`Net sales by ${dimLabel.toLowerCase()}`, subtitle(ctx), null, barEl),
      card('Mix by location', `Share of each location's net sales · ${fmtRange(ctx.q.current)}`, null, stackEl)),
    card(dimLabel, `${subtitle(ctx)}${table.expander ? ' · click a group to see the Toast names in it' : ''}`, [table.expander, csvButton(() => table)], table.el),
  );
  later(() => {
    barChart(barEl, { categories: labels.slice(0, 12), series: barSeries, horizontal: true, format: fmt.money, axisFormat: fmt.moneyShort });
    barChart(stackEl, { categories: ids.map((id) => ctx.loc(id).name), series: stackSeries, horizontal: true, stack: true, max: 1, format: fmt.pct, axisFormat: (v) => `${Math.round(v * 100)}%` });
  });
  return node;
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------
const approverState = { view: 'discount' };

export async function discounts(ctx) {
  const data = await ctx.api('/api/discounts');
  const hasCmp = !!ctx.q.compare;
  const ids = ctx.q.locations;
  const f = ['gross_sales', 'discounts', 'net_sales'];
  const T = totals(data.daily.current, f);
  const C = hasCmp ? totals(data.daily.compare, f) : null;
  const U = totals(data.byName.current, ['uses', 'amount']);
  const UC = hasCmp ? totals(data.byName.compare, ['uses', 'amount']) : null;
  const o = { hasCompare: hasCmp };

  const tiles = h('div', { class: 'grid kpis' },
    kpi('Discounts & comps', T.discounts, C?.discounts, { ...o, format: fmt.money, better: 'down' }),
    kpi('% of gross sales', div(T.discounts, T.gross_sales), C && div(C.discounts, C.gross_sales), { ...o, format: fmt.pct, better: 'down', mode: 'pts' }),
    kpi('Times applied', U.uses, UC?.uses, { ...o, format: fmt.int, better: 'none' }),
    kpi('Avg discount', div(U.amount, U.uses), UC && div(UC.amount, UC.uses), { ...o, format: fmt.money2, better: 'none' }),
  );

  // By discount name. Rows arrive per (group, Toast name); the table shows one
  // row per group that expands into its Toast names, and charts use groups only.
  const nf = ['uses', 'amount'];
  const srcKey = (r) => `${r.discount_name}|${r.source_name ?? r.discount_name}`;
  const byGroup = sumBy(data.byName.current, 'discount_name', nf);
  const cmpByName = sumBy(data.byName.compare, 'discount_name', nf);
  const locByName = sumBy(data.byLocation.current, (r) => `${r.location_id}|${r.discount_name}`, nf);
  const bySrc = sumBy(data.byName.current, srcKey, nf);
  const cmpBySrc = sumBy(data.byName.compare, srcKey, nf);
  const locBySrc = sumBy(data.byLocation.current, (r) => `${r.location_id}|${srcKey(r)}`, nf);
  const sourcesOf = new Map();
  for (const r of [...(data.byName.current || []), ...(data.byName.compare || [])]) {
    if (!sourcesOf.has(r.discount_name)) sourcesOf.set(r.discount_name, new Set());
    sourcesOf.get(r.discount_name).add(r.source_name ?? r.discount_name);
  }
  // Approvers per Toast discount and per group, biggest amount first.
  const apprBySrc = new Map();
  const apprByGroup = new Map();
  const addAppr = (map, k, r) => {
    if (!map.has(k)) map.set(k, new Map());
    const m = map.get(k);
    const e = m.get(r.approver) || { name: r.approver, uses: 0, amount: 0 };
    e.uses += r.uses;
    e.amount += r.amount;
    m.set(r.approver, e);
  };
  for (const r of data.approvals || []) {
    addAppr(apprBySrc, srcKey(r), r);
    addAppr(apprByGroup, r.discount_name, r);
  }
  const approversOf = (m) => [...(m?.values() || [])].sort((a, b) => b.amount - a.amount);
  const apprText = (list) => list.map((a) => (a.uses > 1 ? `${a.name} (${a.uses})` : a.name)).join(', ');
  const apprCell = (list) => {
    if (!list.length) return h('span', { class: 'muted' }, '—');
    const shown = list.slice(0, 3);
    const more = list.length - shown.length;
    return h('span', { title: apprText(list), style: { whiteSpace: 'normal' } }, apprText(shown), more ? h('span', { class: 'muted' }, ` +${more} more`) : null);
  };
  const discountRow = (name, c, p, locOf, appr = []) => ({
    name,
    approvers: appr,
    uses: c?.uses ?? 0,
    amount: c?.amount ?? 0,
    share: div(c?.amount ?? 0, T.discounts),
    pctGross: div(c?.amount ?? 0, T.gross_sales),
    amountCmp: hasCmp ? p?.amount ?? 0 : null,
    ...Object.fromEntries(ids.map((id) => [`loc_${id}`, locOf(id)?.amount ?? 0])),
  });
  const rows = [...byGroup.keys()]
    .map((name) => {
      const row = discountRow(name, byGroup.get(name), cmpByName.get(name), (id) => locByName.get(`${id}|${name}`), approversOf(apprByGroup.get(name)));
      const sources = [...(sourcesOf.get(name) || [])];
      if (sources.length > 1 || (sources.length === 1 && sources[0] !== name)) {
        row.children = sources.map((src) => {
          const k = `${name}|${src}`;
          return discountRow(src, bySrc.get(k), cmpBySrc.get(k), (id) => locBySrc.get(`${id}|${k}`), approversOf(apprBySrc.get(k)));
        });
      }
      return row;
    })
    .sort((a, b) => b.amount - a.amount);
  const cols = [
    { key: 'name', label: 'Discount', text: true },
    { key: 'approvedBy', label: 'Approved by', text: true, value: (r) => apprText(r.approvers), render: (r) => apprCell(r.approvers) },
    { key: 'uses', label: 'Uses', fmt: fmt.int },
    { key: 'amount', label: 'Amount', fmt: fmt.money },
    { key: 'share', label: 'Share', fmt: fmt.pct },
    { key: 'pctGross', label: '% of gross', fmt: fmt.pct },
  ];
  if (hasCmp) {
    cols.push({ key: 'amountCmp', label: 'Comparison', fmt: fmt.money });
    cols.push({ key: 'chg', label: 'Change', value: (r) => change(r.amount, r.amountCmp), render: (r) => deltaNode(change(r.amount, r.amountCmp), { invert: true }) });
  }
  if (ids.length > 1) for (const id of ids) cols.push({ key: `loc_${id}`, label: ctx.loc(id).name, fmt: fmt.money });
  const nameTable = dataTable({ columns: cols, rows, sortKey: 'amount', filename: 'discounts' });

  // By approver (manager comps): one row per manager, expanding into the
  // discount groups they approved.
  const apprRows = [];
  for (const r of data.byApprover.current || []) {
    let row = apprRows.find((a) => a.label === r.approver);
    if (!row) apprRows.push((row = { label: r.approver, uses: 0, amount: 0, children: [] }));
    row.uses += r.uses;
    row.amount += r.amount;
    row.children.push({ label: r.discount_name, uses: r.uses, amount: r.amount });
  }
  const apprTotal = apprRows.reduce((a, r) => a + r.amount, 0);
  const apprTable = dataTable({
    columns: [
      { key: 'label', label: 'Approved by', text: true },
      { key: 'uses', label: 'Uses', fmt: fmt.int },
      { key: 'amount', label: 'Amount', fmt: fmt.money },
      { key: 'share', label: 'Share of comps', value: (r) => div(r.amount, apprTotal), fmt: fmt.pct },
    ],
    rows: apprRows,
    sortKey: 'amount',
    filename: 'discounts-by-approver',
  });

  // Comps by approver chart: one bar per approver (top 15 by amount), either
  // split by discount type or compared with the comparison period.
  const apprTotals = sumBy(data.byApprover.current, 'approver', ['amount', 'uses']);
  const apprCmp = hasCmp ? sumBy(data.byApprover.compare, 'approver', ['amount']) : null;
  const approvers = [...apprTotals.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 15).map(([name]) => name);
  const apprEl = chartBox();
  apprEl.style.height = `${Math.max(220, approvers.length * 34 + 70)}px`;
  const drawApprovers = () => {
    window.echarts.getInstanceByDom(apprEl)?.dispose();
    if (approverState.view === 'compare' && hasCmp) {
      barChart(apprEl, {
        categories: approvers,
        series: [
          { name: 'Current', colorIndex: 0, data: approvers.map((a) => apprTotals.get(a)?.amount ?? 0) },
          { name: 'Comparison', color: 'compare', data: approvers.map((a) => apprCmp.get(a)?.amount ?? 0) },
        ],
        horizontal: true, format: fmt.money, axisFormat: fmt.moneyShort,
      });
      return;
    }
    // Stack by discount type: the 5 biggest types get their own colour, the rest fold into Other.
    const types = [...sumBy(data.byApprover.current, 'discount_name', ['amount']).entries()]
      .sort((a, b) => b[1].amount - a[1].amount).map(([t]) => t);
    const shown = types.slice(0, 5);
    const cell = new Map((data.byApprover.current || []).map((r) => [`${r.approver}|${r.discount_name}`, r.amount]));
    const series = shown.map((t, i) => ({ name: t, colorIndex: i, data: approvers.map((a) => cell.get(`${a}|${t}`) ?? 0) }));
    if (types.length > shown.length) {
      const rest = types.slice(5);
      series.push({ name: 'Other', color: 'compare', data: approvers.map((a) => rest.reduce((sum, t) => sum + (cell.get(`${a}|${t}`) ?? 0), 0)) });
    }
    barChart(apprEl, { categories: approvers, series, horizontal: true, stack: true, format: fmt.money, axisFormat: fmt.moneyShort });
  };
  const apprTools = [
    hasCmp ? seg([['discount', 'By discount'], ['compare', 'vs comparison']], approverState.view, (v) => { approverState.view = v; drawApprovers(); }) : null,
    apprTable.expander,
    csvButton(() => apprTable),
  ];

  const barEl = chartBox();
  const top = rows.slice(0, 10);
  const barSeries = [{ name: 'Current', colorIndex: 0, data: top.map((r) => r.amount) }];
  if (hasCmp) barSeries.push({ name: 'Comparison', color: 'compare', data: top.map((r) => r.amountCmp) });

  const trendEl = chartBox();
  const trend = trendSeries(ctx, data.daily.current, data.daily.compare, METRICS.discount_pct, false);

  const locEl = chartBox();
  const locT = sumBy(data.daily.current, 'location_id', f);
  const locC = hasCmp ? sumBy(data.daily.compare, 'location_id', f) : null;
  const locSeries = [{ name: 'Current', colorIndex: 0, data: ids.map((id) => div(locT.get(id)?.discounts, locT.get(id)?.gross_sales)) }];
  if (locC) locSeries.push({ name: 'Comparison', color: 'compare', data: ids.map((id) => div(locC.get(id)?.discounts, locC.get(id)?.gross_sales)) });

  const node = h('div', {},
    tiles,
    h('div', { class: 'grid two' },
      card('Top discounts', subtitle(ctx), null, barEl),
      card('Discount % of gross by location', subtitle(ctx), null, locEl)),
    card('Discount % trend', `${subtitle(ctx)} · by ${ctx.q.grain}`, null, trendEl),
    card('All discounts', `${subtitle(ctx)}${nameTable.expander ? ' · click a group to see the Toast discounts in it' : ''}`, [nameTable.expander, csvButton(() => nameTable)],
      rows.length ? nameTable.el : h('div', { class: 'empty' }, 'No discounts in this period')),
    card('Comps by approver', `Discounts that required a manager approval · ${subtitle(ctx)}${approvers.length === 15 && apprTotals.size > 15 ? ' · top 15 shown' : ''}`, apprTools,
      apprRows.length ? [apprEl, apprTable.el] : h('div', { class: 'empty' }, 'No approved comps in this period')),
  );
  later(() => {
    barChart(barEl, { categories: top.map((r) => r.name), series: barSeries, horizontal: true, format: fmt.money, axisFormat: fmt.moneyShort });
    barChart(locEl, { categories: ids.map((id) => ctx.loc(id).name), series: locSeries, horizontal: true, format: fmt.pct, axisFormat: fmt.pct });
    lineChart(trendEl, { ...trend, format: fmt.pct, zeroBased: false });
    if (apprRows.length) drawApprovers();
  });
  return node;
}

// ---------------------------------------------------------------------------
// Labor
// ---------------------------------------------------------------------------
const laborState = { metric: 'labor_pct' };

export async function labor(ctx) {
  const data = await ctx.api('/api/labor');
  const hasCmp = !!ctx.q.compare;
  const ids = ctx.q.locations;
  const hasSales = !!data.sales;
  const lf = ['hours', 'overtime_hours', 'cost'];
  const L = totals(data.daily.current, lf);
  const LC = hasCmp ? totals(data.daily.compare, lf) : null;
  const S = hasSales ? totals(data.sales.current, ['net_sales', 'guests']) : null;
  const SC = hasSales && hasCmp ? totals(data.sales.compare, ['net_sales', 'guests']) : null;
  const o = { hasCompare: hasCmp };

  const tiles = [
    kpi('Labor cost', L.cost, LC?.cost, { ...o, format: fmt.money, better: 'down' }),
    kpi('Hours', L.hours, LC?.hours, { ...o, format: fmt.int, better: 'none' }),
    kpi('Overtime hours', L.overtime_hours, LC?.overtime_hours, { ...o, format: fmt.dec1, better: 'down' }),
  ];
  if (hasSales) {
    tiles.unshift(kpi('Labor % of net sales', div(L.cost, S.net_sales), SC && div(LC.cost, SC.net_sales), { ...o, format: fmt.pct, better: 'down', mode: 'pts' }));
    tiles.push(kpi('Sales per labor hour', div(S.net_sales, L.hours), SC && div(SC.net_sales, LC.hours), { ...o, format: fmt.money2 }));
    tiles.push(kpi('Labor $ per guest', div(L.cost, S.guests), SC && div(LC.cost, SC.guests), { ...o, format: fmt.money2, better: 'down' }));
  }

  // Trend by location (labor %, cost, hours or SPLH)
  const rowsCur = mergeDaily(data.sales?.current, data.daily.current);
  const rowsCmp = hasCmp ? mergeDaily(data.sales?.compare, data.daily.compare) : null;
  const trendMetrics = [
    ...(hasSales ? [['labor_pct', 'Labor %'], ['splh', 'SPLH']] : []),
    ['cost', 'Labor $'],
    ['hours', 'Hours'],
  ];
  if (!trendMetrics.some(([k]) => k === laborState.metric)) laborState.metric = trendMetrics[0][0];
  const extra = {
    cost: { label: 'Labor $', calc: (t) => t.cost, fmt: fmt.money, axis: fmt.moneyShort },
    hours: { label: 'Hours', calc: (t) => t.hours, fmt: fmt.int },
  };
  const trendEl = chartBox(true);
  const split = { v: 'location' };
  const drawTrend = () => {
    window.echarts.getInstanceByDom(trendEl)?.dispose();
    const m = METRICS[laborState.metric] || extra[laborState.metric];
    const t = trendSeries(ctx, rowsCur, rowsCmp, m, split.v === 'location');
    lineChart(trendEl, { ...t, format: m.fmt, axisFormat: m.axis || m.fmt, zeroBased: !m.rate });
  };
  const metricSeg = seg(trendMetrics, laborState.metric, (v) => { laborState.metric = v; drawTrend(); });
  const splitSeg = seg([['location', 'By location'], ['total', 'Total vs comparison']], split.v, (v) => { split.v = v; drawTrend(); });

  // Location table
  const lt = sumBy(data.daily.current, 'location_id', lf);
  const ltc = hasCmp ? sumBy(data.daily.compare, 'location_id', lf) : null;
  const st = hasSales ? sumBy(data.sales.current, 'location_id', ['net_sales', 'guests']) : null;
  const stc = hasSales && hasCmp ? sumBy(data.sales.compare, 'location_id', ['net_sales', 'guests']) : null;
  const locRow = (id, l, lc, s, sc) => ({
    id,
    cost: l?.cost ?? 0,
    costCmp: lc?.cost ?? null,
    hours: l?.hours ?? 0,
    ot: l?.overtime_hours ?? 0,
    laborPct: div(l?.cost, s?.net_sales),
    laborPctCmp: lc && sc ? div(lc.cost, sc.net_sales) : null,
    splh: div(s?.net_sales, l?.hours),
    perGuest: div(l?.cost, s?.guests),
  });
  const locRows = ids.map((id) => locRow(id, lt.get(id), ltc?.get(id), st?.get(id), stc?.get(id)));
  const locTotal = { ...locRow(null, L, LC, S, SC), id: null };
  const locCols = [
    { key: 'id', label: 'Location', text: true, value: (r) => (r.id ? ctx.loc(r.id).name : 'All selected'), render: (r) => (r.id ? locCell(ctx, r.id) : 'All selected') },
    { key: 'cost', label: 'Labor $', fmt: fmt.money },
  ];
  if (hasCmp) locCols.push({ key: 'costChg', label: 'Change', value: (r) => change(r.cost, r.costCmp), render: (r) => deltaNode(change(r.cost, r.costCmp), { invert: true }) });
  locCols.push({ key: 'hours', label: 'Hours', fmt: fmt.int }, { key: 'ot', label: 'OT hours', fmt: fmt.dec1 });
  if (hasSales) {
    locCols.push({ key: 'laborPct', label: 'Labor %', fmt: fmt.pct });
    if (hasCmp) locCols.push({ key: 'laborPctChg', label: 'Labor % chg', value: (r) => (r.laborPct !== null && r.laborPctCmp !== null ? r.laborPct - r.laborPctCmp : null), render: (r) => deltaNode(r.laborPct !== null && r.laborPctCmp !== null ? r.laborPct - r.laborPctCmp : null, { invert: true, formatter: fmt.pts }) });
    locCols.push({ key: 'splh', label: 'SPLH', fmt: fmt.money2 }, { key: 'perGuest', label: 'Labor $/guest', fmt: fmt.money2 });
  }
  const locTable = dataTable({ columns: locCols, rows: locRows, total: locRows.length > 1 ? locTotal : null, sortKey: 'cost', filename: 'labor-by-location' });

  // Job table + chart. Rows arrive per (group, Toast job); jobs mapped to a
  // 7shifts role in Admin > Category groups roll up under it and expand.
  const jf = ['regular_hours', 'overtime_hours', 'regular_cost', 'overtime_cost'];
  const byGroup = sumBy(data.byJob.current, 'job_title', jf);
  const cmpByGroup = sumBy(data.byJob.compare, 'job_title', jf);
  const srcKey = (r) => `${r.job_title}|${r.source_name ?? r.job_title}`;
  const bySrc = sumBy(data.byJob.current, srcKey, jf);
  const cmpBySrc = sumBy(data.byJob.compare, srcKey, jf);
  const locByGroup = sumBy(data.byLocationJob.current, (r) => `${r.location_id}|${r.job_title}`, ['cost']);
  const locBySrc = sumBy(data.byLocationJob.current, (r) => `${r.location_id}|${srcKey(r)}`, ['cost']);
  const sourcesOf = new Map();
  for (const r of data.byJob.current || []) {
    if (!sourcesOf.has(r.job_title)) sourcesOf.set(r.job_title, new Set());
    sourcesOf.get(r.job_title).add(r.source_name ?? r.job_title);
  }
  const jobRow = (job, r, c, locOf) => {
    const cost = (r?.regular_cost ?? 0) + (r?.overtime_cost ?? 0);
    const hours = (r?.regular_hours ?? 0) + (r?.overtime_hours ?? 0);
    return {
      job,
      cost,
      costCmp: c ? c.regular_cost + c.overtime_cost : hasCmp ? 0 : null,
      hours,
      ot: r?.overtime_hours ?? 0,
      otCost: r?.overtime_cost ?? 0,
      avgRate: div(cost, hours),
      pctSales: hasSales ? div(cost, S.net_sales) : null,
      ...Object.fromEntries(ids.map((id) => [`loc_${id}`, locOf(id)?.cost ?? 0])),
    };
  };
  const jobRows = [...byGroup.keys()]
    .map((g) => {
      const row = jobRow(g, byGroup.get(g), cmpByGroup.get(g), (id) => locByGroup.get(`${id}|${g}`));
      const sources = [...(sourcesOf.get(g) || [])];
      if (sources.length > 1 || (sources.length === 1 && sources[0] !== g)) {
        row.children = sources
          .map((src) => {
            const k = `${g}|${src}`;
            return jobRow(src, bySrc.get(k), cmpBySrc.get(k), (id) => locBySrc.get(`${id}|${k}`));
          })
          .sort((a, b) => b.cost - a.cost);
      }
      return row;
    })
    .sort((a, b) => b.cost - a.cost);
  const jobCols = [
    { key: 'job', label: 'Job / role', text: true },
    { key: 'cost', label: 'Labor $', fmt: fmt.money },
  ];
  if (hasCmp) jobCols.push({ key: 'chg', label: 'Change', value: (r) => change(r.cost, r.costCmp), render: (r) => deltaNode(change(r.cost, r.costCmp), { invert: true }) });
  jobCols.push(
    { key: 'hours', label: 'Hours', fmt: fmt.int },
    { key: 'ot', label: 'OT hours', fmt: fmt.dec1 },
    { key: 'otCost', label: 'OT $', fmt: fmt.money },
    { key: 'avgRate', label: 'Avg $/hr', fmt: fmt.money2 },
  );
  if (hasSales) jobCols.push({ key: 'pctSales', label: '% of sales', fmt: fmt.pct });
  if (ids.length > 1) for (const id of ids) jobCols.push({ key: `loc_${id}`, label: ctx.loc(id).name, fmt: fmt.money });
  const jobTable = dataTable({ columns: jobCols, rows: jobRows, sortKey: 'cost', filename: 'labor-by-job' });

  const jobEl = chartBox();
  const jobSeries = [{ name: 'Current', colorIndex: 0, data: jobRows.map((r) => r.cost) }];
  if (hasCmp) jobSeries.push({ name: 'Comparison', color: 'compare', data: jobRows.map((r) => r.costCmp) });

  const node = h('div', {},
    hasSales ? null : h('div', { class: 'notice' }, 'Labor % and sales per labor hour are hidden because your account does not include sales access.'),
    h('div', { class: 'grid kpis' }, tiles),
    card('Labor trend', `${subtitle(ctx)} · by ${ctx.q.grain}`, [metricSeg, splitSeg], trendEl),
    card('Labor by location', subtitle(ctx), csvButton(() => locTable), locTable.el),
    card('Labor cost by job', subtitle(ctx), null, jobEl),
    card('Jobs', subtitle(ctx), csvButton(() => jobTable), jobTable.el),
  );
  later(() => {
    drawTrend();
    barChart(jobEl, { categories: jobRows.map((r) => r.job), series: jobSeries, horizontal: true, format: fmt.money, axisFormat: fmt.moneyShort });
  });
  return node;
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------
const itemsState = { limit: 50 };

export async function items(ctx) {
  const holder = h('div');
  const load = async () => {
    const data = await ctx.api('/api/items', { limit: itemsState.limit });
    holder.replaceChildren(renderItems(ctx, data));
  };
  const limitSeg = seg([[25, 'Top 25'], [50, 'Top 50'], [200, 'Top 200']], itemsState.limit, async (v) => {
    itemsState.limit = v; holder.style.opacity = 0.55; await load(); holder.style.opacity = 1;
  });
  await load();
  return h('div', {}, h('div', { class: 'card-tools', style: { marginBottom: '12px' } }, limitSeg), holder);
}

function renderItems(ctx, data) {
  const hasCmp = !!ctx.q.compare;
  const key = (r) => `${r.item_name}|${r.sales_category}`;
  const cmp = new Map((data.compare || []).map((r) => [key(r), r]));
  const total = totals(data.current, ['net_sales']).net_sales;
  const rows = (data.current || []).map((r, i) => ({
    rank: i + 1,
    item: r.item_name,
    category: r.sales_category,
    qty: r.quantity,
    net: r.net_sales,
    avgPrice: div(r.gross_sales, r.quantity),
    share: div(r.net_sales, total),
    netCmp: hasCmp ? cmp.get(key(r))?.net_sales ?? null : null,
    qtyCmp: hasCmp ? cmp.get(key(r))?.quantity ?? null : null,
  }));
  const cols = [
    { key: 'rank', label: '#', fmt: fmt.int },
    { key: 'item', label: 'Item', text: true },
    { key: 'category', label: 'Category', text: true },
    { key: 'qty', label: 'Qty', fmt: fmt.int },
  ];
  if (hasCmp) cols.push({ key: 'qtyChg', label: 'Qty chg', value: (r) => change(r.qty, r.qtyCmp), render: (r) => deltaNode(change(r.qty, r.qtyCmp)) });
  cols.push({ key: 'net', label: 'Net sales', fmt: fmt.money });
  if (hasCmp) {
    cols.push({ key: 'netCmp', label: 'Comparison', fmt: fmt.money });
    cols.push({ key: 'chg', label: 'Change', value: (r) => change(r.net, r.netCmp), render: (r) => deltaNode(change(r.net, r.netCmp)) });
  }
  cols.push({ key: 'avgPrice', label: 'Avg price', fmt: fmt.money2 }, { key: 'share', label: 'Share of top', fmt: fmt.pct });
  const table = dataTable({ columns: cols, rows, sortKey: 'net', filename: 'items' });

  const barEl = chartBox(true);
  const top = rows.slice(0, 15);
  const series = [{ name: 'Current', colorIndex: 0, data: top.map((r) => r.net) }];
  if (hasCmp) series.push({ name: 'Comparison', color: 'compare', data: top.map((r) => r.netCmp ?? 0) });

  const node = h('div', {},
    card('Top items by net sales', subtitle(ctx), null, barEl),
    card(`Top ${data.limit} items`, `${subtitle(ctx)} · check-level discounts are spread across the items on the check`, csvButton(() => table),
      rows.length ? table.el : h('div', { class: 'empty' }, 'No item sales in this period')),
  );
  later(() => barChart(barEl, { categories: top.map((r) => r.item), series, horizontal: true, format: fmt.money, axisFormat: fmt.moneyShort }));
  return node;
}

// ---------------------------------------------------------------------------
// 7shifts (users with the 7shifts permission): scheduled vs actual labor, upcoming schedule.
// Toast labor needs labor access and sales figures sales access.
// ---------------------------------------------------------------------------
const shiftsState = { metric: 'hours' };

export async function sevenShifts(ctx) {
  const data = await ctx.api('/api/sevenshifts');
  const ids = ctx.q.locations;
  const sf = ['hours', 'cost', 'shifts', 'open_shifts', 'open_hours'];
  const hasActual = !!data.actual;
  const hasSales = !!data.sales;
  const S = totals(data.scheduled, sf);
  const A = hasActual ? totals(data.actual, ['hours', 'cost']) : null;
  const N = hasSales ? totals(data.sales, ['net_sales']) : null;
  const variance = (a, s) => (a !== null && s !== null ? a - s : null);

  if (!data.sync.length) {
    return h('div', { class: 'notice' }, 'No 7shifts schedule has been loaded for these locations yet.');
  }

  const tiles = [
    kpi('Scheduled hours', S.hours, null, { format: fmt.int }),
    hasActual && kpi('Actual hours (Toast)', A.hours, null, { format: fmt.int }),
    hasActual && kpi('Hours over schedule', variance(A.hours, S.hours), null, { format: (v) => (v === null ? '—' : `${v > 0 ? '+' : ''}${fmt.int(v)}`) }),
    kpi('Scheduled labor $', S.cost, null, { format: fmt.money }),
    hasActual && kpi('Actual labor $', A.cost, null, { format: fmt.money }),
    hasSales && kpi('Scheduled labor %', div(S.cost, N.net_sales), null, { format: fmt.pct }),
    hasSales && hasActual && kpi('Actual labor %', div(A.cost, N.net_sales), null, { format: fmt.pct }),
  ].filter(Boolean);

  // Daily scheduled vs actual
  const days = eachDate(ctx.q.current.start, ctx.q.current.end);
  const sumDay = (rows, field) => {
    const m = new Map();
    for (const r of rows) m.set(r.business_date, (m.get(r.business_date) || 0) + (r[field] || 0));
    return m;
  };
  const dailyEl = chartBox(true);
  const drawDaily = () => {
    window.echarts.getInstanceByDom(dailyEl)?.dispose();
    const f = shiftsState.metric;
    const sm = sumDay(data.scheduled, f);
    const am = hasActual ? sumDay(data.actual, f) : null;
    const money = f === 'cost';
    barChart(dailyEl, {
      categories: days.map((d) => `${fmtWeekday(d)} ${fmtDate(d)}`),
      series: [
        { name: 'Scheduled (7shifts)', color: 'compare', data: days.map((d) => sm.get(d) ?? null) },
        ...(am ? [{ name: 'Actual (Toast)', colorIndex: 0, data: days.map((d) => am.get(d) ?? null) }] : []),
      ],
      format: money ? fmt.money : fmt.dec1,
      axisFormat: money ? fmt.moneyShort : fmt.int,
    });
  };
  const metricSeg = seg([['hours', 'Hours'], ['cost', 'Labor $']], shiftsState.metric, (v) => { shiftsState.metric = v; drawDaily(); });

  // By location
  const sl = sumBy(data.scheduled, 'location_id', sf);
  const al = hasActual ? sumBy(data.actual, 'location_id', ['hours', 'cost']) : new Map();
  const nl = hasSales ? sumBy(data.sales, 'location_id', ['net_sales']) : new Map();
  const locRow = (id, s, a, n) => ({
    id,
    sHours: s?.hours ?? 0,
    aHours: a?.hours ?? 0,
    vHours: (a?.hours ?? 0) - (s?.hours ?? 0),
    vPct: div((a?.hours ?? 0) - (s?.hours ?? 0), s?.hours),
    sCost: s?.cost ?? 0,
    aCost: a?.cost ?? 0,
    vCost: (a?.cost ?? 0) - (s?.cost ?? 0),
    sPct: div(s?.cost, n?.net_sales),
    aPct: div(a?.cost, n?.net_sales),
    open: s?.open_shifts ?? 0,
  });
  const signed = (f) => (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${f(v)}`);
  const overCls = (v) => h('span', { class: v > 0.5 ? 'neg' : v < -0.5 ? 'pos' : '' }, signed(fmt.dec1)(v));
  const locRows = ids.map((id) => locRow(id, sl.get(id), al.get(id), nl.get(id)));
  const locCols = [
    { key: 'id', label: 'Location', text: true, value: (r) => (r.id ? ctx.loc(r.id).name : 'All selected'), render: (r) => (r.id ? locCell(ctx, r.id) : 'All selected') },
    { key: 'sHours', label: 'Sched hrs', fmt: fmt.int },
    hasActual && { key: 'aHours', label: 'Actual hrs', fmt: fmt.int },
    hasActual && { key: 'vHours', label: 'Hrs over', render: (r) => overCls(r.vHours) },
    hasActual && { key: 'vPct', label: '% over', fmt: (v) => (v === null ? '—' : fmt.signedPct(v)) },
    { key: 'sCost', label: 'Sched $', fmt: fmt.money },
    hasActual && { key: 'aCost', label: 'Actual $', fmt: fmt.money },
    hasActual && { key: 'vCost', label: '$ over', fmt: signed(fmt.money) },
    hasSales && { key: 'sPct', label: 'Sched labor %', fmt: fmt.pct },
    hasSales && hasActual && { key: 'aPct', label: 'Actual labor %', fmt: fmt.pct },
    { key: 'open', label: 'Open shifts', fmt: fmt.int },
  ].filter(Boolean);
  const locTable = dataTable({
    columns: locCols,
    rows: locRows,
    total: locRows.length > 1 ? { ...locRow(null, S, A, N), id: null } : null,
    sortKey: hasActual ? 'aHours' : 'sHours',
    filename: 'scheduled-vs-actual-by-location',
  });

  // By role. Toast jobs count toward the 7shifts role they're mapped to in
  // Admin > Category groups > Labor jobs (else matched by name) and expand.
  const key = (n) => String(n || '').trim().toLowerCase();
  const roles = new Map();
  for (const r of data.schedRoles) roles.set(key(r.name), { name: r.name, sHours: r.hours, sCost: r.cost, aHours: null, aCost: null, jobs: [] });
  for (const j of data.actualJobs || []) {
    let e = roles.get(key(j.name));
    if (!e) roles.set(key(j.name), (e = { name: j.name, sHours: null, sCost: null, aHours: null, aCost: null, jobs: [] }));
    e.aHours = (e.aHours ?? 0) + j.hours;
    e.aCost = (e.aCost ?? 0) + j.cost;
    e.jobs.push(j);
  }
  const roleRows = [...roles.values()].map(({ jobs, ...r }) => {
    const row = {
      ...r,
      vHours: r.sHours !== null && r.aHours !== null ? r.aHours - r.sHours : null,
      source: r.sHours === null ? 'Toast only' : r.aHours === null ? '7shifts only' : 'Both',
    };
    if (jobs.length > 1 || (jobs.length === 1 && key(jobs[0].source_name) !== key(r.name))) {
      row.children = jobs
        .map((j) => ({ name: j.source_name, sHours: null, sCost: null, aHours: j.hours, aCost: j.cost, vHours: null, source: 'Toast job' }))
        .sort((a, b) => b.aHours - a.aHours);
    }
    return row;
  });
  const unmapped = hasActual ? roleRows.filter((r) => r.source === 'Toast only').length : 0;
  const roleTable = dataTable({
    columns: [
      { key: 'name', label: 'Role / job', text: true },
      { key: 'sHours', label: 'Sched hrs', fmt: fmt.int },
      hasActual && { key: 'aHours', label: 'Actual hrs', fmt: fmt.int },
      hasActual && { key: 'vHours', label: 'Hrs over', render: (r) => (r.vHours === null ? '—' : overCls(r.vHours)) },
      { key: 'sCost', label: 'Sched $', fmt: fmt.money },
      hasActual && { key: 'aCost', label: 'Actual $', fmt: fmt.money },
      hasActual && { key: 'source', label: 'In', text: true },
    ].filter(Boolean),
    rows: roleRows,
    sortKey: hasActual ? 'aHours' : 'sHours',
    filename: 'scheduled-vs-actual-by-role',
  });

  // Upcoming two weeks
  const upDays = eachDate(data.today, data.upcomingEnd);
  const upMap = new Map(data.upcoming.map((r) => [`${r.business_date}|${r.location_id}`, r]));
  const wk = new Map((data.weekdaySales || []).map((r) => [`${r.location_id}|${r.weekday}`, r.net_sales]));
  const upRows = upDays.map((d) => {
    const wd = toDate(d).getUTCDay();
    const row = { date: d, hours: 0, cost: 0, open: 0, sales: 0, hasSales: false };
    for (const id of ids) {
      const u = upMap.get(`${d}|${id}`);
      row[`h_${id}`] = u?.hours ?? 0;
      row.hours += u?.hours ?? 0;
      row.cost += u?.cost ?? 0;
      row.open += u?.open_shifts ?? 0;
      const f = wk.get(`${id}|${wd}`);
      if (f) { row.sales += f; row.hasSales = true; }
    }
    row.sales = row.hasSales ? row.sales : null;
    row.laborPct = div(row.cost, row.sales);
    return row;
  });
  const upCols = [
    { key: 'date', label: 'Day', text: true, value: (r) => r.date, render: (r) => (/^\d{4}-/.test(r.date) ? `${fmtWeekday(r.date)} ${fmtDate(r.date)}` : r.date) },
  ];
  if (ids.length > 1) for (const id of ids) upCols.push({ key: `h_${id}`, label: `${ctx.loc(id).name} hrs`, fmt: fmt.int });
  upCols.push(
    { key: 'hours', label: 'Sched hrs', fmt: fmt.int },
    { key: 'cost', label: 'Sched $', fmt: fmt.money },
    hasSales && { key: 'sales', label: 'Projected sales', fmt: fmt.money },
    hasSales && { key: 'laborPct', label: 'Projected labor %', fmt: fmt.pct },
    { key: 'open', label: 'Open shifts', fmt: fmt.int },
  );
  upCols.splice(0, upCols.length, ...upCols.filter(Boolean));
  const upTot = totals(upRows, ['hours', 'cost', 'open', 'sales']);
  const upTable = dataTable({
    columns: upCols,
    rows: upRows,
    total: { date: 'Next 14 days', ...upTot, laborPct: div(upTot.cost, upTot.sales), ...Object.fromEntries(ids.map((id) => [`h_${id}`, upRows.reduce((s, r) => s + r[`h_${id}`], 0)])) },
    sortKey: 'date',
    sortDir: 'asc',
    filename: 'upcoming-schedule',
  });
  const upEl = chartBox();

  const synced = data.sync.map((r) => r.synced_at).sort().pop();
  const node = h('div', {},
    h('div', { class: 'notice' },
      `Scheduled = published 7shifts shifts (open shifts counted separately).${hasActual ? ' Actual = Toast time entries. Register is left out of both.' : ''} Last 7shifts sync ${new Date(synced).toLocaleString()}.`),
    h('div', { class: 'grid kpis' }, tiles),
    card(hasActual ? 'Scheduled vs actual by day' : 'Scheduled by day', fmtRange(ctx.q.current), metricSeg, dailyEl),
    card('By location', fmtRange(ctx.q.current), csvButton(() => locTable), locTable.el),
    card('By role', hasActual ? `${fmtRange(ctx.q.current)} · Toast jobs roll up under the 7shifts role they're mapped to` : fmtRange(ctx.q.current), csvButton(() => roleTable), 
      unmapped && ctx.user.isAdmin ? h('div', { class: 'notice' }, `${unmapped} Toast job${unmapped === 1 ? ' isn\'t' : 's aren\'t'} mapped to a 7shifts role yet. Map them in Admin → Category groups → Labor jobs.`) : null,
      roleTable.el),
    await logBookCard(ctx),
    card('Upcoming schedule', hasSales ? 'Next 14 days · projected sales = average of the same weekday over the last 4 weeks' : 'Next 14 days', csvButton(() => upTable), upEl, upTable.el),
  );
  later(() => {
    drawDaily();
    barChart(upEl, {
      categories: upDays.map((d) => `${fmtWeekday(d)} ${fmtDate(d)}`),
      series: ids.map((id) => ({ name: ctx.loc(id).name, colorIndex: ctx.loc(id).colorIndex, data: upRows.map((r) => r[`h_${id}`]) })),
      stack: true,
      format: fmt.dec1,
      axisFormat: fmt.int,
    });
  });
  return node;
}

// ---------------------------------------------------------------------------
// 7shifts log book (each user's assigned locations)
// ---------------------------------------------------------------------------
const logState = { locs: null, category: '', search: '', files: false, shown: 100 };

/** Thumbnails for images, links for other files; both open the file in a new tab. */
function attachmentsRow(p) {
  return h('div', { class: 'log-files' }, p.attachments.map((a) => {
    const href = `/api/logbook/file?post=${encodeURIComponent(p.id)}&i=${a.i}`;
    return h('a', { href, target: '_blank', rel: 'noopener', title: a.name, class: a.image ? 'log-thumb' : 'log-file' },
      a.image ? h('img', { src: href, alt: a.name, loading: 'lazy' }) : `📎 ${a.name}`);
  }));
}

async function logBookCard(ctx) {
  const body = h('div');
  const status = h('span', { class: 'muted small' });
  const params = (locs) => ({ locations: locs.join(',') });
  let data = await ctx.api('/api/logbook', params(logState.locs || []));
  logState.locs ??= data.locations.map((l) => l.id);

  const chipRow = h('div', { class: 'chips' });
  const drawChips = () => chipRow.replaceChildren(...data.locations.map((l) => {
    const on = logState.locs.includes(l.id);
    return h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(on),
      onclick: async () => {
        logState.locs = on ? logState.locs.filter((x) => x !== l.id) : [...logState.locs, l.id];
        drawChips();
        if (!logState.locs.length) { data = { ...data, posts: [] }; draw(); return; }
        status.textContent = 'Loading…';
        data = await ctx.api('/api/logbook', params(logState.locs));
        status.textContent = '';
        draw();
      },
    }, h('span', { class: 'dot', style: { '--dot': `var(--s${(ctx.loc(l.id).colorIndex % 8) + 1})` } }), l.name);
  }));

  const catSelect = h('select', { 'aria-label': 'Category', onchange: () => { logState.category = catSelect.value; logState.shown = 100; draw(); } });
  const search = h('input', { type: 'text', placeholder: 'Search notes', value: logState.search, 'aria-label': 'Search log book' });
  const filesOnly = h('input', { type: 'checkbox', checked: logState.files, onchange: () => { logState.files = filesOnly.checked; logState.shown = 100; draw(); } });
  const filesLabel = h('label', { class: 'checks small', style: { gap: '6px' } }, filesOnly, 'Has attachments');
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { logState.search = search.value; logState.shown = 100; draw(); }, 200); });

  const nameOf = new Map(data.locations.map((l) => [l.id, l.name]));
  const para = (text) => h('div', { class: 'log-msg' }, text);

  function draw() {
    const cats = [...new Set(data.posts.map((p) => p.category))].sort();
    catSelect.replaceChildren(h('option', { value: '' }, 'All categories'), ...cats.map((c) => h('option', { value: c, selected: c === logState.category }, c)));
    const q = logState.search.trim().toLowerCase();
    const posts = data.posts.filter((p) =>
      (!logState.category || p.category === logState.category) &&
      (!logState.files || p.attachment_count > 0) &&
      (!q || `${p.message} ${p.author} ${p.category} ${p.comments.map((c) => c.message).join(' ')}`.toLowerCase().includes(q)));
    const shown = posts.slice(0, logState.shown);
    const groups = [];
    for (const p of shown) {
      const k = `${p.business_date}|${p.location_id}`;
      if (groups.at(-1)?.k !== k) groups.push({ k, date: p.business_date, loc: p.location_id, posts: [] });
      groups.at(-1).posts.push(p);
    }
    body.replaceChildren(...[
      posts.length ? null : h('div', { class: 'muted', style: { padding: '12px 0' } }, 'No log book entries for these dates and filters.'),
      ...groups.map((g) => h('div', { class: 'log-day' },
        h('div', { class: 'log-day-head' }, h('b', {}, `${fmtWeekday(g.date)} ${fmtDate(g.date)}`), ' · ', nameOf.get(g.loc) || g.loc),
        ...g.posts.map((p) => h('div', { class: 'log-post' },
          h('div', { class: 'log-meta' },
            h('span', { class: 'pill on' }, p.category),
            p.author ? h('span', { class: 'muted small' }, p.author) : null,
            p.attachment_count && !p.attachments?.length ? h('span', { class: 'muted small' }, `📎 ${p.attachment_count}`) : null),
          para(p.message),
          p.attachments?.length ? attachmentsRow(p) : null,
          ...p.comments.map((c) => h('div', { class: 'log-comment' }, h('span', { class: 'muted small' }, `${c.author || 'Comment'}: `), c.message)))))),
      posts.length > shown.length
        ? h('button', { class: 'btn', type: 'button', style: { marginTop: '8px' }, onclick: () => { logState.shown += 200; draw(); } }, `Show more (${posts.length - shown.length} left)`)
        : null,
      data.truncated ? h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'Showing the latest 3,000 entries; pick a shorter date range to see older ones.') : null,
    ].filter(Boolean));
  }
  drawChips();
  draw();
  return card('Log book', `${fmtRange(ctx.q.current)} · from 7shifts`, [filesLabel, catSelect, search, status],
    h('div', { style: { margin: '0 0 12px' } }, chipRow), body);
}
