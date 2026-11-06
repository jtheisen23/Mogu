import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateShifts, allocateOvertime, effectiveWageCents, hourlyWageCents, isSalaried, laborStatements, localDate, localMidnightUtc,
  matchLocations, punchHours, punchLaborRows, weekStartOf,
} from '../src/sevenshifts.js';
import { migratedDb } from '../../worker/test/d1.js';

const tz = 'America/Los_Angeles';

test('localMidnightUtc handles daylight and standard time', () => {
  assert.equal(localMidnightUtc('2026-07-01', tz).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(localMidnightUtc('2026-12-01', tz).toISOString(), '2026-12-01T08:00:00.000Z');
});

test('matchLocations pairs by contained name or explicit id', () => {
  const remote = [
    { id: 1, name: 'MÓGŪ Modern Chinese Kitchen – Holbrook' },
    { id: 2, name: 'Mogu East Meadow' },
    { id: 3, name: 'Mineola' },
  ];
  const pairs = matchLocations(
    [{ id: 'HB', name: 'Holbrook' }, { id: 'EM', name: 'East Meadow' }, { id: 'MN', name: 'Mineola', sevenShiftsId: 3 }, { id: 'FD', name: 'Farmingdale' }],
    remote,
  );
  assert.deepEqual(pairs.map((p) => p.remote?.id ?? null), [1, 2, 3, null]);
});

test('aggregateShifts sums hours and cost by local date and role', () => {
  const roles = new Map([[10, 'Server'], [11, 'Register']]);
  const shifts = [
    // 5pm-11pm PDT on Oct 1 = 00:00-06:00Z Oct 2; dated Oct 1 locally
    { user_id: 1, role_id: 10, start: '2026-10-02T00:00:00Z', end: '2026-10-02T06:00:00Z', hourly_wage: 1650 },
    { user_id: 2, role_id: 10, start: '2026-10-01T17:00:00Z', end: '2026-10-01T22:30:00Z', hourly_wage: 0, breaks: [{ length: 30, type: 'unpaid' }, { length: 10, type: 'paid' }] },
    { user_id: null, open: true, role_id: 10, start: '2026-10-01T18:00:00Z', end: '2026-10-01T22:00:00Z' },
    { user_id: 3, role_id: 11, start: '2026-10-01T18:00:00Z', end: '2026-10-01T22:00:00Z', hourly_wage: 1600 },
    { user_id: 4, role_id: 10, start: '2026-10-01T18:00:00Z', end: '2026-10-01T22:00:00Z', hourly_wage: 1600, deleted: true },
    { user_id: 5, role_id: 10, start: '2026-10-01T18:00:00Z', end: '2026-10-01T22:00:00Z', hourly_wage: 1600, soft_deleted: true },
  ];
  const rows = aggregateShifts(shifts, { timeZone: tz, roles, wageFor: (s) => (s.user_id === 2 ? 1800 : 0), excludedRoles: ['register'] });
  assert.equal(localDate('2026-10-02T00:00:00Z', tz), '2026-10-01');
  assert.deepEqual(rows, [
    { business_date: '2026-10-01', role: 'Server', shifts: 2, hours: 11, cost: 6 * 16.5 + 5 * 18, open_shifts: 1, open_hours: 4, employees: 2 },
  ]);
});

test('aggregateShifts leaves out excluded (salaried) shifts', () => {
  const roles = new Map([[1, 'General Manager'], [2, 'Associate (BOH)']]);
  const shifts = [
    { user_id: 1, role_id: 1, start: '2026-11-02T14:00:00Z', end: '2026-11-02T23:00:00Z', hourly_wage: 750000 },
    { user_id: 2, role_id: 2, start: '2026-11-02T14:00:00Z', end: '2026-11-02T22:00:00Z', hourly_wage: 1700 },
  ];
  const rows = aggregateShifts(shifts, { timeZone: 'America/New_York', roles, exclude: (s) => s.user_id === 1 });
  assert.deepEqual(rows.map((r) => [r.role, r.hours, r.cost]), [['Associate (BOH)', 8, 136]]);
});

test('isSalaried and hourlyWageCents read 7shifts wage types per role', () => {
  const gm = [{ role_id: 1, wage_type: 'annual_salary', wage_cents: 6500000 }];
  const mixed = [{ role_id: 1, wage_type: 'annual_salary', wage_cents: 5000000 }, { role_id: 2, wage_type: 'hourly', wage_cents: 1900 }];
  const hourly = [{ role_id: 3, wage_type: 'hourly', wage_cents: 1700 }];
  assert.equal(isSalaried(gm, 1), true);
  assert.equal(isSalaried(gm, 99), true); // no wage for that role: all of their wages are salaried
  assert.equal(isSalaried(mixed, 1), true);
  assert.equal(isSalaried(mixed, 2), false);
  assert.equal(isSalaried(hourly, 3), false);
  assert.equal(isSalaried([], 3), false);
  assert.equal(isSalaried(hourly, 3, 250000), true); // a salary-sized "hourly" wage
  assert.equal(hourlyWageCents(mixed, 2), 1900);
  assert.equal(hourlyWageCents(mixed, 1), 1900); // falls back to any hourly wage
  assert.equal(hourlyWageCents(gm, 1), 0);
});

test('punchHours subtracts unpaid breaks only, and skips open punches', () => {
  const p = (breaks) => ({ clocked_in: '2026-11-02T14:00:00Z', clocked_out: '2026-11-02T22:00:00Z', breaks });
  assert.equal(punchHours(p([])), 8);
  assert.equal(punchHours(p([{ in: '2026-11-02T18:00:00Z', out: '2026-11-02T18:30:00Z', paid: false }])), 7.5);
  assert.equal(punchHours(p([{ in: '2026-11-02T18:00:00Z', out: '2026-11-02T18:15:00Z', paid: true }])), 8);
  assert.equal(punchHours(p([{ in: '2026-11-02T18:00:00Z', out: '2026-11-02T18:30:00Z', paid: false, deleted: true }])), 8);
  assert.equal(punchHours({ clocked_in: '2026-11-02T14:00:00Z', clocked_out: null }), null);
});

test('weekStartOf finds the Monday (or Sunday) that starts the workweek', () => {
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02'); // Sunday -> previous Monday
  assert.equal(weekStartOf('2026-11-02'), '2026-11-02');
  assert.equal(weekStartOf('2026-11-07', 0), '2026-11-01'); // Sunday-start weeks
});

test('overtime is hours past 40 a week per employee, across days and locations', () => {
  const day = (d, hours, remoteId = 'A', user_id = 7) => ({ user_id, remoteId, date: `2026-11-0${d}`, clockedIn: Date.parse(`2026-11-0${d}T14:00:00Z`), hours, role: 'Associate (BOH)', wage: 20 });
  // Mon-Fri 9 h each (45 h): Friday is 4 h regular + 5 h overtime. Thursday is at another store.
  const items = allocateOvertime([day(6, 9), day(2, 9), day(3, 9), day(5, 9, 'B'), day(4, 9), day(3, 6, 'A', 8)]);
  const friday = items.find((i) => i.date === '2026-11-06' && i.user_id === 7);
  assert.deepEqual([friday.regular, friday.overtime], [4, 5]);
  assert.equal(items.find((i) => i.user_id === 8).overtime, 0);
  // Next week starts fresh.
  const [next] = allocateOvertime([day(2, 9), day(3, 9), day(4, 9), day(5, 9), day(6, 9), { ...day(2, 8), date: '2026-11-09', clockedIn: Date.parse('2026-11-09T14:00:00Z') }].slice(-1));
  assert.equal(next.overtime, 0);

  const rows = punchLaborRows(items.filter((i) => i.remoteId === 'A'), { overtimeMultiplier: 1.5 });
  const fri = rows.find((r) => r.business_date === '2026-11-06');
  assert.deepEqual(fri, { business_date: '2026-11-06', job_title: 'Associate (BOH)', shifts: 1, regular_hours: 4, overtime_hours: 5, regular_cost: 80, overtime_cost: 150, employees: 1 });
  const tue = rows.find((r) => r.business_date === '2026-11-03');
  assert.deepEqual([tue.employees, tue.shifts, tue.regular_hours], [2, 2, 15]);
});

test('7shifts labor replaces every day in the range; Toast labor is removed', () => {
  const db = migratedDb();
  const toastRow = (date, job) => db.prepare(`INSERT INTO labor_daily (location_id,business_date,job_title,employees,shifts,regular_hours,overtime_hours,regular_cost,overtime_cost) VALUES ('HB',?,?,1,1,8,0,140,0)`).run(date, job);
  toastRow('2026-10-31', 'Cook'); // outside the synced range: untouched
  toastRow('2026-11-01', 'Cook'); // old Toast labor on a day without 7shifts punches: removed
  toastRow('2026-11-02', 'Cook'); // replaced by 7shifts
  const rows = [
    { business_date: '2026-11-02', job_title: 'Associate (BOH)', employees: 2, shifts: 2, regular_hours: 15, overtime_hours: 0, regular_cost: 270, overtime_cost: 0 },
    { business_date: '2026-11-05', job_title: 'Associate (BOH)', employees: 1, shifts: 1, regular_hours: 8, overtime_hours: 0, regular_cost: 144, overtime_cost: 0 }, // outside: ignored
  ];
  for (const sql of laborStatements('HB', '2026-11-01', '2026-11-02', rows, 178.08)) db.exec(sql);
  const got = db.prepare('SELECT business_date, job_title, regular_cost FROM labor_daily ORDER BY business_date, job_title').all().map((r) => ({ ...r }));
  assert.deepEqual(got, [
    { business_date: '2026-10-31', job_title: 'Cook', regular_cost: 140 },
    { business_date: '2026-11-01', job_title: 'Salaried', regular_cost: 178.08 },
    { business_date: '2026-11-02', job_title: 'Associate (BOH)', regular_cost: 270 },
    { business_date: '2026-11-02', job_title: 'Salaried', regular_cost: 178.08 },
  ]);
  assert.deepEqual(laborStatements('HB', '2026-11-03', '2026-11-02', rows), []);
});

test('a salary entered as an "hourly" 7shifts wage is treated as salaried', () => {
  // Real case: punches without a wage fell back to an hourly wage of 6,500,000 cents.
  const wages = [{ role_id: 5, wage_type: 'hourly', wage_cents: 6500000 }];
  const punchWage = 0;
  assert.equal(isSalaried(wages, 5, punchWage), false); // the punch alone looks fine...
  const cents = effectiveWageCents(wages, 5, punchWage);
  assert.equal(cents, 6500000);
  assert.equal(isSalaried(wages, 5, cents), true); // ...the wage it would be costed at does not
  assert.equal(effectiveWageCents(wages, 5, 1800), 1800); // a wage on the punch wins
  assert.equal(isSalaried([{ role_id: 5, wage_type: 'hourly', wage_cents: 1750 }], 5, effectiveWageCents([{ role_id: 5, wage_type: 'hourly', wage_cents: 1750 }], 5, 0)), false);
});
