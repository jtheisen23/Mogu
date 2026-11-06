import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateShifts, localDate, localMidnightUtc, matchLocations } from '../src/sevenshifts.js';

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
