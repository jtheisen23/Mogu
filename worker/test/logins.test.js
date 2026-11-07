import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { d1, migratedDb } from './d1.js';
import { authenticate, recordLogin } from '../src/auth.js';
import { listUsers } from '../src/admin.js';

const TEAM = 'mogu-dashboard.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
let privateKey;
let realFetch;

before(async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  const jwk = { ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
});
after(() => { globalThis.fetch = realFetch; });

async function token(email, iat) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email, iat, exp: Math.floor(Date.now() / 1000) + 600 }));
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

let db;
let env;
beforeEach(() => {
  db = migratedDb();
  db.exec(`INSERT INTO locations (id, name) VALUES ('HB', 'Holbrook')`);
  db.exec(`INSERT INTO users (email, name, role, all_locations) VALUES ('manager@gmail.com', 'Manager', 'viewer', 1)`);
  env = { DB: d1(db), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, BOOTSTRAP_ADMINS: 'Jeremy@restaurantcaddies.com' };
});

const signIn = async (email, iat) => {
  const req = new Request('https://mogu.example/api/me', { headers: { 'Cf-Access-Jwt-Assertion': await token(email, iat) } });
  const user = await authenticate(req, env);
  await recordLogin(env, user);
  return user;
};

test('records when the person signed in (the Access token time), keeping the latest', async () => {
  const nov6 = Date.parse('2026-11-06T22:40:00Z') / 1000;
  const user = await signIn('Manager@Gmail.com', nov6);
  assert.equal(user.loginAt, '2026-11-06T22:40:00.000Z');
  // A page opened later with an older token does not move the time back.
  await signIn('manager@gmail.com', nov6 - 3600);
  await signIn('jeremy@restaurantcaddies.com', nov6 + 60);

  const data = await listUsers(env, { email: 'jeremy@restaurantcaddies.com', isAdmin: true });
  assert.equal(data.users.find((u) => u.email === 'manager@gmail.com').lastLoginAt, '2026-11-06T22:40:00.000Z');
  assert.deepEqual(data.bootstrapLastLogin, { 'jeremy@restaurantcaddies.com': '2026-11-06T22:41:00.000Z' });
});

test('people who never signed in show no time', async () => {
  const data = await listUsers(env, { email: 'jeremy@restaurantcaddies.com', isAdmin: true });
  assert.equal(data.users[0].lastLoginAt, null);
  assert.deepEqual(data.bootstrapLastLogin, { 'jeremy@restaurantcaddies.com': null });
});

test('before the table exists, sign-in and the Admin list still work', async () => {
  db.exec('DROP TABLE user_logins');
  const user = await signIn('manager@gmail.com', Date.parse('2026-11-06T22:40:00Z') / 1000);
  assert.equal(user.email, 'manager@gmail.com');
  const data = await listUsers(env, { email: 'jeremy@restaurantcaddies.com', isAdmin: true });
  assert.equal(data.users[0].lastLoginAt, null);
});
