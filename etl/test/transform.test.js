import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLabor, aggregateOrders } from '../src/transform.js';
import { dayStatements, lit, mixStatements } from '../src/sql.js';
import { hourIn } from '../src/dates.js';

const lookups = {
  diningOptions: new Map([['do-1', 'Dine In'], ['do-2', 'Take Out']]),
  revenueCenters: new Map([['rc-1', 'Bar']]),
  salesCategories: new Map([['sc-food', 'Food'], ['sc-bev', 'Beverage']]),
  employees: new Map([['emp-1', 'Alex R.']]),
  jobs: new Map([['job-cook', 'Line Cook'], ['job-cash', 'Cashier']]),
};

const sel = (o) => ({ quantity: 1, appliedDiscounts: [], selectionType: 'NONE', ...o });

const orders = [
  {
    guid: 'o1',
    openedDate: '2026-09-24T19:15:00.000+0000', // 12:15 PDT
    numberOfGuests: 2,
    diningOption: { guid: 'do-1' },
    revenueCenter: { guid: 'rc-1' },
    checks: [
      {
        taxAmount: 3.1,
        appliedDiscounts: [{ name: 'Manager Comp', discountAmount: 4, approver: { guid: 'emp-1' } }],
        appliedServiceCharges: [{ chargeAmount: 1.5 }],
        payments: [{ tipAmount: 6, paymentStatus: 'CAPTURED' }, { tipAmount: 99, paymentStatus: 'VOIDED' }],
        selections: [
          sel({ displayName: 'Pork Bao', salesCategory: { guid: 'sc-food' }, quantity: 2, preDiscountPrice: 12, price: 10,
            appliedDiscounts: [{ name: 'Happy Hour', discountAmount: 2 }] }),
          sel({ displayName: 'Soda', salesCategory: { guid: 'sc-bev' }, preDiscountPrice: 10, price: 10 }),
          sel({ displayName: 'Lobster Roll', salesCategory: { guid: 'sc-food' }, preDiscountPrice: 26, price: 26, voided: true }),
          sel({ displayName: 'Gift Card', preDiscountPrice: 50, price: 50, selectionType: 'TOAST_CARD_SELL' }),
        ],
      },
    ],
  },
  { guid: 'o2', voided: true, openedDate: '2026-09-24T20:00:00.000+0000', checks: [{ selections: [sel({ preDiscountPrice: 8, price: 8 })] }] },
  { guid: 'o3', deleted: true, checks: [{ selections: [sel({ preDiscountPrice: 100, price: 100 })] }] },
];

test('aggregateOrders computes gross, discounts and net like Toast', () => {
  const r = aggregateOrders(orders, { timezone: 'America/Los_Angeles', lookups });
  assert.equal(r.daily.orders, 1);
  assert.equal(r.daily.guests, 2);
  assert.equal(r.daily.gross_sales, 22); // 12 + 10, voided and gift card excluded
  assert.equal(r.daily.discounts, 6); // 2 item-level + 4 check-level
  assert.equal(r.daily.net_sales, 16);
  assert.equal(r.daily.voids, 34); // voided lobster roll + voided order
  assert.equal(r.daily.tax, 3.1);
  assert.equal(r.daily.tips, 6);
  assert.equal(r.daily.service_charges, 1.5);
});

test('check-level discounts are prorated across items so item and mix totals reconcile', () => {
  const r = aggregateOrders(orders, { timezone: 'America/Los_Angeles', lookups });
  const itemNet = r.items.reduce((a, i) => a + i.net_sales, 0);
  assert.equal(Math.round(itemNet * 100) / 100, r.daily.net_sales);
  const taco = r.items.find((i) => i.item_name === 'Pork Bao');
  assert.equal(taco.quantity, 2);
  assert.equal(taco.net_sales, 8); // 10 after item discount, minus 4 * 10/20 of check comp
  const food = r.mix.find((m) => m.dimension === 'sales_category' && m.label === 'Food');
  assert.equal(food.net_sales, 8);
  const dineIn = r.mix.find((m) => m.dimension === 'dining_option');
  assert.deepEqual([dineIn.label, dineIn.orders, dineIn.net_sales], ['Dine In', 1, 16]);
});

test('discounts keep names and approvers; hours use the location time zone', () => {
  const r = aggregateOrders(orders, { timezone: 'America/Los_Angeles', lookups });
  const comp = r.discounts.find((d) => d.discount_name === 'Manager Comp');
  assert.equal(comp.approver, 'Alex R.');
  assert.equal(comp.amount, 4);
  assert.deepEqual(r.hourly.map((h) => h.hour), [12]);
  assert.equal(hourIn('2026-01-15T03:30:00.000Z', 'America/Los_Angeles'), 19);
});

test('orders without a revenue center go to the one that starts their dining option', () => {
  const lk = {
    diningOptions: new Map([['dd-del', 'DoorDash - Delivery'], ['dd-old', 'Door Dash'], ['dine', 'Dine In']]),
    revenueCenters: new Map([['rc-dd', 'DoorDash'], ['rc-d', 'Door'], ['rc-dr', 'Dining Room']]),
  };
  const order = (diningOption, revenueCenter, price) => ({
    diningOption: diningOption && { guid: diningOption },
    revenueCenter: revenueCenter && { guid: revenueCenter },
    checks: [{ selections: [sel({ preDiscountPrice: price, price })] }],
  });
  const r = aggregateOrders([
    order('dd-del', null, 20),
    order('dd-old', null, 5),
    order('dd-del', 'rc-dr', 7), // a named revenue center always wins
    order('dine', null, 3),
    order(null, null, 1),
    order('dd-del', 'rc-deleted', 2), // revenue center missing from the lookup
  ], { lookups: lk });
  const rc = Object.fromEntries(r.mix.filter((m) => m.dimension === 'revenue_center').map((m) => [m.label, m.net_sales]));
  assert.deepEqual(rc, { DoorDash: 27, 'Dining Room': 7, Unspecified: 4 });
  const dining = r.mix.find((m) => m.dimension === 'dining_option' && m.label === 'Unspecified');
  assert.equal(dining.net_sales, 1);
});

test('aggregateLabor costs regular and overtime by job and adds salaried labor', () => {
  const rows = aggregateLabor(
    [
      { employeeReference: { guid: 'e1' }, jobReference: { guid: 'job-cook' }, regularHours: 8, overtimeHours: 2, hourlyWage: 20 },
      { employeeReference: { guid: 'e2' }, jobReference: { guid: 'job-cook' }, regularHours: 6, overtimeHours: 0, hourlyWage: 22 },
      { employeeReference: { guid: 'e3' }, jobReference: { guid: 'job-cash' }, regularHours: 5, hourlyWage: 18 },
      { deleted: true, jobReference: { guid: 'job-cash' }, regularHours: 99, hourlyWage: 99 },
    ],
    { lookups, overtimeMultiplier: 1.5, salariedLaborPerDay: 300 },
  );
  const cook = rows.find((r) => r.job_title === 'Line Cook');
  assert.equal(cook.employees, 2);
  assert.equal(cook.regular_hours, 14);
  assert.equal(cook.regular_cost, 8 * 20 + 6 * 22);
  assert.equal(cook.overtime_cost, 2 * 20 * 1.5);
  assert.equal(rows.find((r) => r.job_title === 'Cashier').regular_cost, 90);
  assert.equal(rows.find((r) => r.job_title === 'Salaried').regular_cost, 300);
});

test('SQL literals are escaped', () => {
  assert.equal(lit("Bob's \u0000Noodles"), "'Bob''s Noodles'");
  assert.equal(lit(NaN), '0');
  const sql = dayStatements('PL', '2026-09-24', aggregateOrders(orders, { lookups }), []).join('\n');
  assert.match(sql, /DELETE FROM daily_sales WHERE location_id='PL' AND business_date='2026-09-24';/);
  assert.match(sql, /INSERT INTO item_sales/);
});

test('mixStatements replaces only one mix dimension for the day', () => {
  const sql = mixStatements('PB', '2026-05-16', aggregateOrders(orders, { lookups }), 'revenue_center').join('\n');
  assert.match(sql, /^DELETE FROM sales_mix WHERE location_id='PB' AND business_date='2026-05-16' AND dimension='revenue_center';/);
  assert.match(sql, /'revenue_center','Bar'/);
  assert.doesNotMatch(sql, /dining_option|sales_category|daily_sales|item_sales/);
});
