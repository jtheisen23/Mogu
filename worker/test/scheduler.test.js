import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { daysFor, dispatchSync, HOURLY_CRON, NIGHTLY_CRON } from '../src/scheduler.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('hourly runs sync today, plus yesterday between midnight and 6am Eastern', () => {
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-09-29T17:17:00Z')), 1); // 1:17pm EDT
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-09-29T06:17:00Z')), 2); // 2:17am EDT
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-09-29T04:17:00Z')), 2); // 12:17am EDT
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-09-29T10:17:00Z')), 1); // 6:17am EDT
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-12-15T10:17:00Z')), 2); // 5:17am EST (winter)
  assert.equal(daysFor(HOURLY_CRON, Date.parse('2026-12-15T11:17:00Z')), 1); // 6:17am EST (winter)
  assert.equal(daysFor(NIGHTLY_CRON, Date.parse('2026-09-29T08:40:00Z')), 7);
});

test('dispatches the Toast sync workflow with the right days', async () => {
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init }; return new Response(null, { status: 204 }); };
  const r = await dispatchSync(
    { GITHUB_DISPATCH_TOKEN: 'tok', GITHUB_REPO: 'owner/repo' },
    { cron: HOURLY_CRON, scheduledTime: Date.parse('2026-09-29T06:17:00Z') },
  );
  assert.deepEqual(r, { ok: true, days: 2 });
  assert.equal(call.url, 'https://api.github.com/repos/owner/repo/actions/workflows/toast-sync.yml/dispatches');
  assert.equal(call.init.headers.Authorization, 'Bearer tok');
  assert.ok(call.init.headers['User-Agent']);
  assert.deepEqual(JSON.parse(call.init.body), { ref: 'main', inputs: { days: '2' } });
});

test('reports a missing token or a GitHub error instead of throwing', async () => {
  assert.equal((await dispatchSync({}, { cron: HOURLY_CRON, scheduledTime: Date.now() })).ok, false);
  globalThis.fetch = async () => new Response('Bad credentials', { status: 401 });
  const r = await dispatchSync({ GITHUB_DISPATCH_TOKEN: 'x', GITHUB_REPO: 'o/r' }, { cron: NIGHTLY_CRON, scheduledTime: Date.now() });
  assert.deepEqual(r, { ok: false, status: 401 });
});
