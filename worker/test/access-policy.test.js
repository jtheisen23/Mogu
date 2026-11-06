import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { d1, migratedDb } from './d1.js';
import { deleteUser, listUsers, saveUser } from '../src/admin.js';
import { syncAccessPolicy } from '../src/access-policy.js';

const admin = { email: 'owner@example.com', isAdmin: true };
const realFetch = globalThis.fetch;
const viewer = (email, over = {}) => ({ email, role: 'viewer', active: true, allLocations: true, locations: [], sections: { sales: true }, ...over });

// A fake Cloudflare API holding reusable Access policies.
let policies;
let calls;
let failPut;
function fakeCloudflare() {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined });
    assert.match(u.pathname, /^\/client\/v4\/accounts\/acct123\/access\/policies/);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const id = u.pathname.split('/policies/')[1];
    if (method === 'GET' && !id) {
      const page = Number(u.searchParams.get('page') || 1);
      const per = Number(u.searchParams.get('per_page') || 50);
      const slice = policies.slice((page - 1) * per, page * per);
      return json(200, { success: true, result: slice, result_info: { page, per_page: per, count: slice.length, total_count: policies.length } });
    }
    if (method === 'PUT' && id) {
      if (failPut) return json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      const i = policies.findIndex((p) => p.id === id);
      policies[i] = { ...policies[i], ...JSON.parse(init.body) };
      return json(200, { success: true, result: policies[i] });
    }
    return json(404, { success: false, errors: [{ message: 'not found' }] });
  };
}

const policy = (over = {}) => ({
  id: 'pol-1',
  name: 'Mogu dashboard users',
  decision: 'allow',
  session_duration: '24h',
  include: [{ email: { email: 'jeremy@restaurantcaddies.com' } }, { email_domain: { domain: 'mogukitchen.com' } }],
  exclude: [],
  require: [],
  reusable: true,
  app_count: 1,
  created_at: '2026-11-06T17:00:00Z',
  updated_at: '2026-11-06T17:00:00Z',
  ...over,
});
const emailsIn = (p) => p.include.filter((r) => r.email).map((r) => r.email.email).sort();
const puts = () => calls.filter((c) => c.method === 'PUT');

let db;
let env;
beforeEach(() => {
  db = migratedDb();
  db.exec(`INSERT INTO locations (id, name) VALUES ('DT', 'Downtown')`);
  env = {
    DB: d1(db),
    BOOTSTRAP_ADMINS: 'Jeremy@restaurantcaddies.com',
    ACCESS_POLICY_TOKEN: 'tok',
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    ACCESS_POLICY_NAME: 'Mogu dashboard users',
  };
  policies = [policy()];
  calls = [];
  failPut = false;
  fakeCloudflare();
});
afterEach(() => { globalThis.fetch = realFetch; });

test('adding a user adds their email to the Access policy and keeps everything else', async () => {
  const res = await saveUser(env, admin, viewer('New.Manager@Gmail.com'));
  assert.equal(res.access.status, 'updated');
  assert.deepEqual(res.access.added, ['new.manager@gmail.com']);
  assert.deepEqual(emailsIn(policies[0]), ['jeremy@restaurantcaddies.com', 'new.manager@gmail.com']);

  const [put] = puts();
  assert.equal(put.path, '/client/v4/accounts/acct123/access/policies/pol-1');
  assert.equal(put.auth, 'Bearer tok');
  // The domain rule and the policy's settings are sent back unchanged; read-only fields are not.
  assert.deepEqual(put.body.include[0], { email_domain: { domain: 'mogukitchen.com' } });
  assert.equal(put.body.decision, 'allow');
  assert.equal(put.body.session_duration, '24h');
  for (const k of ['id', 'reusable', 'app_count', 'created_at', 'updated_at']) assert.equal(k in put.body, false, k);
});

test('disabling or removing a user takes their email out; bootstrap admins always stay', async () => {
  await saveUser(env, admin, viewer('a@x.com'));
  await saveUser(env, admin, viewer('b@y.com'));
  assert.deepEqual(emailsIn(policies[0]), ['a@x.com', 'b@y.com', 'jeremy@restaurantcaddies.com']);

  const off = await saveUser(env, admin, viewer('a@x.com', { active: false }));
  assert.deepEqual(off.access.removed, ['a@x.com']);
  const del = await deleteUser(env, admin, 'b@y.com');
  assert.deepEqual(del.access.removed, ['b@y.com']);
  assert.deepEqual(emailsIn(policies[0]), ['jeremy@restaurantcaddies.com']);
  assert.deepEqual(policies[0].include.filter((r) => r.email_domain), [{ email_domain: { domain: 'mogukitchen.com' } }]);
});

test('emails added in Cloudflare by hand are replaced by the dashboard list', async () => {
  policies[0].include.push({ email: { email: 'manual@old.com' } });
  const res = await saveUser(env, admin, viewer('c@z.com'));
  assert.deepEqual(res.access.removed, ['manual@old.com']);
  assert.deepEqual(emailsIn(policies[0]), ['c@z.com', 'jeremy@restaurantcaddies.com']);
});

test('nothing is sent when the policy already matches', async () => {
  await saveUser(env, admin, viewer('d@z.com'));
  calls = [];
  const res = await saveUser(env, admin, viewer('d@z.com', { name: 'Dee' }));
  assert.equal(res.access.status, 'unchanged');
  assert.equal(puts().length, 0);
});

test('finds the policy on a later page of the list', async () => {
  policies = [...Array.from({ length: 60 }, (_, i) => policy({ id: `other-${i}`, name: `Other ${i}` })), policy()];
  const res = await saveUser(env, admin, viewer('e@z.com'));
  assert.equal(res.access.status, 'updated');
  assert.equal(puts()[0].path.endsWith('/pol-1'), true);
});

test('a Cloudflare error is reported but the user is still saved', async () => {
  failPut = true;
  const res = await saveUser(env, admin, viewer('f@z.com'));
  assert.equal(res.ok, true);
  assert.equal(res.access.status, 'error');
  assert.match(res.access.message, /Authentication error/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'f@z.com'`).get().n, 1);
});

test('a missing policy is reported', async () => {
  env.ACCESS_POLICY_NAME = 'No such policy';
  const res = await saveUser(env, admin, viewer('g@z.com'));
  assert.equal(res.access.status, 'error');
  assert.match(res.access.message, /no reusable Access policy named "No such policy"/);
});

test('without the token nothing is called and the Admin page says so', async () => {
  delete env.ACCESS_POLICY_TOKEN;
  const res = await saveUser(env, admin, viewer('h@z.com'));
  assert.equal(res.access.status, 'skipped');
  assert.equal(calls.length, 0);
  assert.equal((await listUsers(env, admin)).accessSync, false);
  env.ACCESS_POLICY_TOKEN = 'tok';
  assert.equal((await listUsers(env, admin)).accessSync, true);
});

test('never empties the policy', async () => {
  const res = await syncAccessPolicy(env, []);
  assert.equal(res.status, 'error');
  assert.equal(calls.length, 0);
});
