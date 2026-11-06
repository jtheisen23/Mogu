import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { d1, migratedDb } from './d1.js';
import { listGroups, saveGroups } from '../src/admin.js';

const admin = { email: 'owner@example.com', isAdmin: true };
const today = new Date().toISOString().slice(0, 10);

let db;
let env;
beforeEach(() => {
  db = migratedDb();
  db.exec(`INSERT INTO locations (id, name) VALUES ('DT', 'Downtown')`);
  env = { DB: d1(db) };
});

const addDiscount = (name, amount) =>
  db.prepare(`INSERT INTO discount_sales (location_id, business_date, discount_name, uses, amount) VALUES ('DT', ?, ?, 1, ?)`)
    .run(today, name, amount);
const groupsOf = async (dimension) =>
  Object.fromEntries((await listGroups(env, admin, new URL(`https://x/api/admin/groups?dimension=${dimension}`))).labels
    .map((l) => [l.label, l.group_name]));

test('discount groups survive a reload, even when the Toast name has stray spaces', async () => {
  addDiscount('Manager Comp', 50);
  addDiscount('Mgr Comp ', 30); // trailing space, as typed into Toast
  addDiscount(' Employee Meal', 20);

  const res = await saveGroups(env, admin, {
    dimension: 'discount',
    mappings: [
      { label: 'Manager Comp', group: 'Manager Comps' },
      { label: 'Mgr Comp ', group: 'Manager Comps' },
      { label: ' Employee Meal', group: 'Staff' },
    ],
  });

  assert.equal(res.saved, 3);
  assert.deepEqual(await groupsOf('discount'), {
    'Manager Comp': 'Manager Comps',
    'Mgr Comp ': 'Manager Comps',
    ' Employee Meal': 'Staff',
  });
});

test('names that differ only by spaces can be grouped separately', async () => {
  addDiscount('Comp', 10);
  addDiscount('Comp ', 5);

  await saveGroups(env, admin, {
    dimension: 'discount',
    mappings: [
      { label: 'Comp', group: 'Comps' },
      { label: 'Comp ', group: 'Comps' },
    ],
  });

  assert.deepEqual(await groupsOf('discount'), { Comp: 'Comps', 'Comp ': 'Comps' });
});

test('a name grouped under itself still shows after a reload', async () => {
  addDiscount('Manager Comp', 50);
  addDiscount('MGR COMP', 30);

  await saveGroups(env, admin, {
    dimension: 'discount',
    mappings: [
      { label: 'Manager Comp', group: 'Manager Comp' },
      { label: 'MGR COMP', group: 'Manager Comp' },
    ],
  });

  assert.deepEqual(await groupsOf('discount'), { 'Manager Comp': 'Manager Comp', 'MGR COMP': 'Manager Comp' });
});

test('blank groups and whitespace in the typed group are cleaned up', async () => {
  addDiscount('Happy Hour', 10);
  addDiscount('Promo', 5);

  const res = await saveGroups(env, admin, {
    dimension: 'discount',
    mappings: [
      { label: 'Happy Hour', group: '  HH  ' },
      { label: 'Promo', group: '   ' },
    ],
  });

  assert.equal(res.saved, 1);
  assert.deepEqual(await groupsOf('discount'), { 'Happy Hour': 'HH', Promo: null });
});
