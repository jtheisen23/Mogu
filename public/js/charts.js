// Thin wrappers over Apache ECharts (Apache-2.0) that read colours from the
// CSS tokens, so light/dark mode and the location palette stay consistent.

const registry = new Set();

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    surface: v('--surface'),
    text: v('--text'),
    text2: v('--text-2'),
    muted: v('--muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    compare: v('--compare'),
    accent: v('--accent'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--s${i}`)),
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function mount(el, build) {
  const inst = window.echarts.init(el, null, { renderer: 'svg' });
  const entry = { inst, apply: () => inst.setOption(build(theme()), true) };
  entry.apply();
  registry.add(entry);
  return inst;
}

export function disposeCharts() {
  for (const e of registry) e.inst.dispose();
  registry.clear();
}

export function rethemeCharts() {
  for (const e of registry) e.apply();
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => registry.forEach((e) => e.inst.resize()), 120);
});

function baseAxis(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
  };
}
function valueAxis(t, formatter) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, formatter },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}
function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.axis,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.text, fontSize: 12 },
    className: 'ec-tip',
    confine: true,
  };
}
// Legend keys mirror the mark: a short stroke for lines, a small box for bars.
function legend(t, show, bars = false) {
  return show
    ? { top: 0, left: 0, icon: 'roundRect', itemWidth: bars ? 10 : 14, itemHeight: bars ? 10 : 3, textStyle: { color: t.text2, fontSize: 12 } }
    : { show: false };
}

/**
 * Line chart with crosshair tooltip.
 * series: [{ name, data: number[], colorIndex?: number, color?: 'compare', dashed?: bool, labels?: string[] }]
 * `labels` lets a comparison series show its own dates in the tooltip.
 */
export function lineChart(el, { categories, series, format = (v) => v, axisFormat, area = false, zeroBased = true }) {
  return mount(el, (t) => {
    const colorOf = (s) => (s.color === 'compare' ? t.compare : t.series[(s.colorIndex ?? 0) % 8]);
    return {
      animationDuration: 300,
      grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 12, bottom: 8, containLabel: true },
      legend: legend(t, series.length > 1),
      tooltip: {
        ...tooltipBase(t),
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 } },
        formatter: (params) => {
          const idx = params[0]?.dataIndex ?? 0;
          const rows = params
            .map((p) => {
              const s = series[p.seriesIndex];
              const lbl = s.labels?.[idx] ? ` · ${s.labels[idx]}` : '';
              return `<div class="row"><span><span class="key" style="background:${colorOf(s)}"></span>${escapeHtml(s.name)}<span style="color:${t.muted}">${escapeHtml(lbl)}</span></span><b>${escapeHtml(format(p.value))}</b></div>`;
            })
            .join('');
          return `<div style="color:${t.text2};margin-bottom:4px">${escapeHtml(categories[idx])}</div>${rows}`;
        },
      },
      xAxis: { type: 'category', data: categories, boundaryGap: false, ...baseAxis(t) },
      // Rates (labor %, avg check...) read better zoomed to their range.
      yAxis: { ...valueAxis(t, axisFormat || format), scale: !zeroBased },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        data: s.data,
        showSymbol: s.data.length === 1,
        symbol: 'circle',
        symbolSize: 8,
        lineStyle: { width: 2, type: s.dashed ? [5, 4] : 'solid', color: colorOf(s) },
        itemStyle: { color: colorOf(s), borderColor: t.surface, borderWidth: 2 },
        areaStyle: area && !s.dashed ? { color: colorOf(s), opacity: 0.08 } : undefined,
        emphasis: { focus: 'none', scale: true },
        z: s.dashed ? 1 : 2,
        connectNulls: false,
      })),
    };
  });
}

/**
 * Bar chart (vertical or horizontal), grouped or stacked.
 * series: [{ name, data, colorIndex?, color?: 'compare' }]
 */
export function barChart(el, { categories, series, format = (v) => v, axisFormat, horizontal = false, stack = false, max }) {
  return mount(el, (t) => {
    const colorOf = (s) => (s.color === 'compare' ? t.compare : t.series[(s.colorIndex ?? 0) % 8]);
    const cat = { type: 'category', data: categories, ...baseAxis(t), inverse: horizontal };
    if (horizontal) cat.axisLabel = { ...cat.axisLabel, color: t.text2, width: 150, overflow: 'truncate' };
    const val = { ...valueAxis(t, axisFormat || format), max };
    return {
      animationDuration: 300,
      grid: { left: 8, right: 16, top: series.length > 1 ? 34 : 12, bottom: 8, containLabel: true },
      legend: legend(t, series.length > 1, true),
      tooltip: {
        ...tooltipBase(t),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: t.grid, opacity: 0.4 } },
        formatter: (params) => {
          const idx = params[0]?.dataIndex ?? 0;
          const rows = params
            .map((p) => {
              const s = series[p.seriesIndex];
              return `<div class="row"><span><span class="key" style="background:${colorOf(s)}"></span>${escapeHtml(s.name)}</span><b>${escapeHtml(format(p.value))}</b></div>`;
            })
            .join('');
          return `<div style="color:${t.text2};margin-bottom:4px">${escapeHtml(categories[idx])}</div>${rows}`;
        },
      },
      xAxis: horizontal ? val : cat,
      yAxis: horizontal ? cat : val,
      series: series.map((s, i) => ({
        name: s.name,
        type: 'bar',
        data: s.data,
        stack: stack ? 'total' : undefined,
        barMaxWidth: 28,
        barGap: '10%',
        itemStyle: {
          color: colorOf(s),
          borderRadius: stack && i < series.length - 1 ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
          borderColor: stack ? t.surface : undefined,
          borderWidth: stack ? 1 : 0,
        },
        emphasis: { itemStyle: { opacity: 0.85 } },
      })),
    };
  });
}
