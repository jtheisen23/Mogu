#!/usr/bin/env node
// Generates realistic-looking DEMO data so the dashboard can be explored
// before Toast credentials are connected. Never run this against production.
//
//   node etl/src/demo.js --out .tmp/demo.sql [--start 2024-07-01] [--end 2026-09-24]
//   npx wrangler d1 execute mogu --local --file .tmp/demo.sql

import { parseArgs } from 'node:util';
import { addDays, eachDate, parseDate, todayIn } from './dates.js';
import { dayStatements, lit, upsertLocationsSql } from './sql.js';
import { FileSink } from './sink.js';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: '.tmp/demo.sql' },
    start: { type: 'string' },
    end: { type: 'string' },
  },
});

const LOCATIONS = [
  { id: 'DT', name: 'Downtown (demo)', base: 9500, tz: 'America/New_York' },
  { id: 'UT', name: 'Uptown (demo)', base: 11500, tz: 'America/New_York' },
  { id: 'WS', name: 'Westside (demo)', base: 7200, tz: 'America/New_York' },
];

const ITEMS = [
  ['Pork Soup Dumplings', 'Food', 12],
  ['Pork Bao', 'Food', 6],
  ['General Tso\'s Chicken', 'Food', 17.5],
  ['Kung Pao Chicken', 'Food', 17],
  ['Beef Chow Fun', 'Food', 18],
  ['Hot & Sour Soup', 'Food', 8.5],
  ['Mapo Tofu', 'Food', 15],
  ['Peking Duck', 'Food', 38],
  ['Kids Lo Mein', 'Food', 9],
  ['Fried Rice', 'Food', 11],
  ['Tsingtao', 'Alcohol', 7],
  ['Lychee Martini', 'Alcohol', 14],
  ['House Wine', 'Alcohol', 11],
  ['Plum Wine', 'Alcohol', 10],
  ['Fountain Soda', 'Beverage', 3.5],
  ['Bubble Tea', 'Beverage', 6.5],
];
const ITEM_WEIGHTS = [16, 10, 7, 8, 6, 5, 3, 3, 3, 9, 9, 5, 3, 2, 8, 4];

const DISCOUNTS = [
  ['Happy Hour', 0.012],
  ['Employee Meal', 0.006],
  ['Manager Comp', 0.005],
  ['Military 10%', 0.004],
  ['Loyalty Reward', 0.003],
];
const MANAGERS = ['Alex R.', 'Jordan M.', 'Sam T.', 'Casey L.'];

const JOBS = [
  // title, share of hours, wage
  ['Wok Cook', 0.32, 22],
  ['Prep Cook', 0.14, 19.5],
  ['Cashier', 0.22, 18],
  ['Server', 0.12, 17],
  ['Bartender', 0.1, 18],
  ['Dishwasher', 0.1, 18],
];

// Deterministic PRNG so the demo looks the same every run.
let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const jitter = (spread) => 1 + (rand() * 2 - 1) * spread;
const round2 = (v) => Math.round(v * 100) / 100;

const DOW = [0.95, 0.78, 0.82, 0.88, 0.98, 1.28, 1.31]; // Sun..Sat
const HOURS = { 11: 0.07, 12: 0.12, 13: 0.11, 14: 0.07, 15: 0.06, 16: 0.08, 17: 0.13, 18: 0.14, 19: 0.11, 20: 0.07, 21: 0.04 };

function seasonal(date) {
  const d = parseDate(date);
  const dayOfYear = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
  return 1 + 0.18 * Math.sin(((dayOfYear - 100) / 365) * 2 * Math.PI);
}

function growth(date) {
  const years = (parseDate(date) - parseDate('2024-07-01')) / (365 * 86400000);
  return 1 + 0.06 * years;
}

function day(loc, date) {
  const dow = parseDate(date).getUTCDay();
  const gross = loc.base * DOW[dow] * seasonal(date) * growth(date) * jitter(0.12);
  const avgCheck = 31 * jitter(0.06);
  const orders = Math.round(gross / avgCheck);
  const guests = Math.round(orders * 1.9 * jitter(0.05));

  const discounts = DISCOUNTS.map(([name, rate]) => {
    const amount = round2(gross * rate * jitter(0.6));
    const uses = Math.max(1, Math.round(amount / (name === 'Happy Hour' ? 3 : 12)));
    return { discount_name: name, approver: name === 'Manager Comp' ? MANAGERS[Math.floor(rand() * MANAGERS.length)] : '', uses, amount };
  }).filter((d) => d.amount > 0);
  const discTotal = discounts.reduce((a, d) => a + d.amount, 0);
  const net = gross - discTotal;

  const totalWeight = ITEM_WEIGHTS.reduce((a, b) => a + b, 0);
  const items = ITEMS.map(([name, cat, price], i) => {
    const g = (gross * ITEM_WEIGHTS[i]) / totalWeight * jitter(0.15);
    return {
      item_name: name,
      sales_category: cat,
      quantity: Math.max(1, Math.round(g / price)),
      gross_sales: round2(g),
      net_sales: round2(g * (net / gross)),
    };
  });
  const mixFrom = (dimension, parts) =>
    parts.map(([label, share]) => ({
      dimension,
      label,
      orders: Math.round(orders * share),
      quantity: 0,
      gross_sales: round2(gross * share),
      discounts: round2(discTotal * share),
      net_sales: round2(net * share),
    }));
  const catShare = {};
  for (const it of items) catShare[it.sales_category] = (catShare[it.sales_category] || 0) + it.gross_sales / gross;
  const mix = [
    ...mixFrom('dining_option', [['Dine In', 0.46], ['Take Out', 0.3], ['Online Ordering', 0.14], ['DoorDash', 0.1]]),
    ...mixFrom('revenue_center', [['Dining Room', 0.6], ['Bar', 0.15], ['Takeout Counter', 0.25]]),
    ...mixFrom('sales_category', Object.entries(catShare)),
  ];

  const hourly = Object.entries(HOURS).map(([h, share]) => ({
    hour: Number(h),
    orders: Math.round(orders * share),
    guests: Math.round(guests * share),
    net_sales: round2(net * share * jitter(0.1)),
  }));

  const laborCostTarget = net * 0.27 * jitter(0.08);
  const avgWage = JOBS.reduce((a, [, share, wage]) => a + share * wage, 0);
  const hours = laborCostTarget / avgWage;
  const labor = JOBS.map(([title, share, wage]) => {
    const h = hours * share * jitter(0.1);
    const ot = rand() < 0.15 ? round2(h * 0.05) : 0;
    return {
      job_title: title,
      employees: Math.max(1, Math.round(h / 7)),
      shifts: Math.max(1, Math.round(h / 6.5)),
      regular_hours: round2(h - ot),
      overtime_hours: ot,
      regular_cost: round2((h - ot) * wage),
      overtime_cost: round2(ot * wage * 1.5),
    };
  });
  labor.push({ job_title: 'Salaried', employees: 0, shifts: 0, regular_hours: 0, overtime_hours: 0, regular_cost: 420, overtime_cost: 0 });

  const voids = round2(gross * 0.004 * jitter(0.8));
  return {
    sales: {
      daily: {
        orders,
        checks: orders,
        guests,
        gross_sales: round2(gross),
        discounts: round2(discTotal),
        net_sales: round2(net),
        voids,
        void_count: Math.round(voids / 12),
        service_charges: 0,
        tax: round2(net * 0.0775),
        tips: round2(net * 0.12),
      },
      hourly,
      mix,
      items,
      discounts,
    },
    labor,
  };
}

async function main() {
  const end = args.end || addDays(todayIn('America/New_York'), -1);
  const start = args.start || '2024-07-01';
  const sink = new FileSink(args.out);
  await sink.write(upsertLocationsSql(LOCATIONS.map((l) => ({ ...l, toastGuid: null, timezone: l.tz }))));
  for (const date of eachDate(start, end)) {
    for (const loc of LOCATIONS) {
      const { sales, labor } = day(loc, date);
      await sink.write(dayStatements(loc.id, date, sales, labor, { orders: sales.daily.orders, syncedAt: `${end}T12:00:00Z` }));
    }
  }
  // A demo manager who can only see Downtown sales + labor, to try out permissions.
  await sink.write([
    `INSERT INTO users (email,name,role,all_locations,can_sales,can_discounts,can_labor,can_items) VALUES (${lit('dt.manager@example.com')},${lit('DT Manager (demo)')},'viewer',0,1,1,1,1) ON CONFLICT(email) DO NOTHING;`,
    `INSERT INTO user_locations (email,location_id) VALUES ('dt.manager@example.com','DT') ON CONFLICT DO NOTHING;`,
  ]);
  console.error(`Wrote demo data ${start} .. ${end} to ${args.out}`);
}

main();
