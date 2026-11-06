import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logBookFile } from '../src/api.js';

const rows = {
  1: { location_id: 'PB', attachments: JSON.stringify([{ name: 'walkin.jpeg', path: 'https://files.7shifts.com/a/b/c' }, { name: 'x.html', path: 'https://files.7shifts.com/a/b/d' }]) },
  2: { location_id: 'PL', attachments: JSON.stringify([{ name: 'p.jpeg', path: 'https://files.7shifts.com/a/b/e' }]) },
  3: { location_id: 'PB', attachments: JSON.stringify([{ name: 'evil.jpeg', path: 'https://evil.example.com/x' }]) },
};
const env = {
  SEVENSHIFTS_ACCESS_TOKEN: 'tok',
  DB: { prepare: () => ({ bind: (id) => ({ first: async () => rows[id] ?? null }) }) },
};
const user = { locations: ['PB'], sections: { sevenshifts: true } };
const call = (post, i, e = env, u = user) => logBookFile(e, new URL(`https://x/api/logbook/file?post=${post}&i=${i}`), u);

test('streams an allowed image with the 7shifts token', async (t) => {
  t.mock.method(globalThis, 'fetch', async (u, init) => {
    assert.equal(String(u), 'https://files.7shifts.com/a/b/c');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return new Response('img', { headers: { 'content-type': 'image/jpeg' } });
  });
  const res = await call(1, 0);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('content-disposition'), /^inline; filename="walkin.jpeg"/);
  assert.equal(await res.text(), 'img');
});

test('serves non-image types as downloads', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<script>', { headers: { 'content-type': 'text/html' } }));
  const res = await call(1, 1);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
});

test('refuses other locations, unknown files and foreign hosts', async () => {
  await assert.rejects(call(2, 0), { status: 404 });
  await assert.rejects(call(1, 5), { status: 404 });
  await assert.rejects(call(3, 0), { status: 404 });
  await assert.rejects(call('x', 0), { status: 400 });
  await assert.rejects(call(1, 0, { ...env, SEVENSHIFTS_ACCESS_TOKEN: '' }), { status: 503 });
});

test('refuses users without the 7shifts permission', async () => {
  await assert.rejects(call(1, 0, env, { locations: ['PB'], sections: { sevenshifts: false } }), { status: 403 });
});
