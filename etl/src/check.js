#!/usr/bin/env node
// Toast connection check: signs in, then for each configured location reads
// the restaurant record, lookup tables, and one day of orders and time entries.
// Nothing is written anywhere and no Cloudflare settings are needed.
//
//   node etl/src/check.js [--date YYYY-MM-DD]      (default: yesterday)
//
// Environment: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, [TOAST_API_HOST], LOCATIONS_JSON
// In GitHub Actions a Markdown report is also written to the job summary.

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addDays, parseDate, todayIn, toToastDate } from './dates.js';
import { loadLocations } from './config.js';
import { ToastClient } from './toast.js';
import { aggregateLabor, aggregateOrders } from './transform.js';

const { values: args } = parseArgs({
  options: {
    date: { type: 'string' },
    config: { type: 'string', default: 'config/locations.json' },
  },
});

const lines = [];
const out = (s = '') => {
  console.log(s);
  lines.push(s);
};

// Which Toast permission each endpoint needs, so failures say what to enable.
const LOOKUPS = [
  ['/config/v2/diningOptions', 'Configuration', 'dining option names'],
  ['/config/v2/revenueCenters', 'Configuration', 'revenue center names'],
  ['/config/v2/salesCategories', 'Configuration', 'sales category names'],
  ['/labor/v1/jobs', 'Labor', 'job titles'],
  ['/labor/v1/employees', 'Labor (employees)', 'manager names on comps'],
];

function reason(err) {
  const m = /failed: (\d{3})/.exec(err.message);
  const status = m ? Number(m[1]) : null;
  if (status === 401 || status === 403) return `HTTP ${status}: not allowed; the credential is probably missing this permission or location`;
  if (status === 404) return 'HTTP 404: not found';
  return err.message.slice(0, 200);
}

// Orders whose revenue center Toast doesn't name (none on the order, or one
// missing from the lookup), by order source and dining option, with where the
// dashboard files them, so they can be matched to Toast's reports.
function ordersWithoutRevenueCenter(orders, ctx) {
  const { revenueCenters, diningOptions } = ctx.lookups;
  const groups = new Map();
  for (const order of orders) {
    const guid = order.revenueCenter?.guid;
    if (guid && revenueCenters.has(guid)) continue;
    const { daily, mix } = aggregateOrders([order], ctx);
    if (!daily.orders) continue;
    const key = [
      guid ? `revenue center ${guid} not in lookup` : 'no revenue center',
      `source "${order.source || 'none'}"`,
      `dining option "${(order.diningOption?.guid && diningOptions.get(order.diningOption.guid)) || 'none'}"`,
    ].join(', ') + ` → ${mix.find((m) => m.dimension === 'revenue_center')?.label}`;
    const g = groups.get(key) ?? { orders: 0, net: 0 };
    g.orders += 1;
    g.net += daily.net_sales;
    groups.set(key, g);
  }
  if (!groups.size) return [];
  return [
    'Orders with no revenue center in Toast (→ where the dashboard files them):',
    ...[...groups].sort((a, b) => b[1].net - a[1].net).map(([k, g]) => `  - ${k}: ${g.orders} orders, $${g.net.toFixed(2)}`),
  ];
}

async function main() {
  const locations = loadLocations(args.config);
  const toast = new ToastClient({
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    host: process.env.TOAST_API_HOST || undefined,
    log: () => {}, // keep retries out of the report
  });

  out('# Toast connection check');
  out();
  try {
    await toast.authenticate();
    out('✅ **Sign-in** succeeded with the client ID and secret.');
  } catch (err) {
    out(`❌ **Sign-in failed**: ${err.message.slice(0, 300)}`);
    out();
    out('Check the TOAST_CLIENT_ID and TOAST_CLIENT_SECRET secrets. Nothing else can be tested until sign-in works.');
    return false;
  }
  out();

  let ok = true;
  for (const loc of locations) {
    const tz = loc.timezone || 'America/New_York';
    const date = args.date || addDays(todayIn(tz), -1);
    parseDate(date);
    const guid = loc.toastGuid;
    out(`## ${loc.id}: ${loc.name}`);
    out();
    if (!guid) {
      out('❌ No toastGuid configured for this location.');
      ok = false;
      out();
      continue;
    }

    try {
      const r = await toast.get(`/restaurants/v1/restaurants/${guid}`, guid);
      const name = [r?.general?.name, r?.general?.locationName].filter(Boolean).join(' – ');
      out(`✅ **Restaurant**: Toast calls this location "${name || 'unnamed'}"${r?.general?.timeZone ? `, time zone ${r.general.timeZone}` : ''}.`);
      if (r?.general?.timeZone && r.general.timeZone !== tz) {
        out(`   ⚠️ Toast's time zone differs from the configured "${tz}".`);
      }
    } catch (err) {
      out(`⚠️ **Restaurant details** unavailable (${reason(err)}). This isn't needed for the dashboard.`);
    }

    const lookups = { diningOptions: new Map(), revenueCenters: new Map(), salesCategories: new Map(), jobs: new Map(), employees: new Map() };
    const keyFor = { '/config/v2/diningOptions': 'diningOptions', '/config/v2/revenueCenters': 'revenueCenters', '/config/v2/salesCategories': 'salesCategories', '/labor/v1/jobs': 'jobs', '/labor/v1/employees': 'employees' };
    for (const [path, perm, what] of LOOKUPS) {
      try {
        const rows = await toast.get(path, guid);
        const list = Array.isArray(rows) ? rows : [];
        for (const x of list) {
          if (!x?.guid) continue;
          const label = path.endsWith('jobs') ? x.title : path.endsWith('employees')
            ? [x.chosenName || x.firstName, x.lastName].filter(Boolean).join(' ')
            : x.name;
          lookups[keyFor[path]].set(x.guid, label);
        }
        const names = path.endsWith('revenueCenters') || path.endsWith('diningOptions')
          ? ` (${list.map((x) => x?.name).filter(Boolean).join(', ')})`
          : '';
        out(`✅ ${what}: ${list.length} found${names}`);
      } catch (err) {
        out(`⚠️ ${what}: ${reason(err)}. Enable **${perm}** read access, or these will show as "Unspecified".`);
      }
    }

    let sales = null;
    try {
      const orders = await toast.ordersForBusinessDate(guid, toToastDate(date));
      sales = aggregateOrders(orders, { timezone: tz, lookups });
      const d = sales.daily;
      out(`✅ **Orders** for ${date}: ${orders.length} orders read. Net sales $${d.net_sales.toFixed(2)}, gross $${d.gross_sales.toFixed(2)}, discounts $${d.discounts.toFixed(2)}, ${d.guests} guests, tax $${d.tax.toFixed(2)}, tips $${d.tips.toFixed(2)}.`);
      const cats = sales.mix.filter((m) => m.dimension === 'sales_category').map((m) => `${m.label} $${m.net_sales.toFixed(0)}`);
      if (cats.length) out(`   Sales categories: ${cats.join(', ')}`);
      const dos = sales.mix.filter((m) => m.dimension === 'dining_option').map((m) => `${m.label} (${m.orders})`);
      if (dos.length) out(`   Dining options: ${dos.join(', ')}`);
      const rcs = sales.mix.filter((m) => m.dimension === 'revenue_center').map((m) => `${m.label} $${m.net_sales.toFixed(0)} (${m.orders})`);
      if (rcs.length) out(`   Revenue centers: ${rcs.join(', ')}`);
      for (const line of ordersWithoutRevenueCenter(orders, { timezone: tz, lookups })) out(`   ${line}`);
      if (!orders.length) out("   ⚠️ No orders that day. That's expected if the location was closed; otherwise check the GUID.");
    } catch (err) {
      ok = false;
      out(`❌ **Orders**: ${reason(err)}. Enable **Orders** read access for this location. The dashboard can't work without it.`);
    }

    try {
      const entries = await toast.timeEntriesForBusinessDate(guid, toToastDate(date));
      const labor = aggregateLabor(entries, { lookups, salariedLaborPerDay: loc.salariedLaborPerDay });
      const cost = labor.reduce((a, r) => a + r.regular_cost + r.overtime_cost, 0);
      const hours = labor.reduce((a, r) => a + r.regular_hours + r.overtime_hours, 0);
      out(`✅ **Labor** for ${date}: ${entries.length} time entries, ${hours.toFixed(1)} hours, $${cost.toFixed(2)} labor cost.`);
      if (entries.length && cost === 0) out('   ⚠️ Hours were found but cost is $0. Wages may not be entered in Toast, so labor % will be empty.');
      if (sales?.daily.net_sales > 0 && cost > 0) out(`   Labor % that day: ${((cost / sales.daily.net_sales) * 100).toFixed(1)}%`);
    } catch (err) {
      out(`⚠️ **Labor**: ${reason(err)}. Enable **Labor** read access to see labor in the dashboard.`);
    }
    out();
  }

  out(ok
    ? '**Result:** Toast is ready. Compare the net sales above against Toast\'s Sales Summary report for the same day.'
    : '**Result:** some required checks failed; see ❌ above.');
  return ok;
}

main()
  .then((ok) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(err.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `❌ ${err.message}\n`);
    process.exit(1);
  });
