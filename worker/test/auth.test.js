import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { authenticate, verifyAccessJwt } from '../src/auth.js';

const TEAM = 'mogu.cloudflareaccess.com';
const AUD = 'aud-tag-123';
let privateKey;
let realFetch;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function sign(payload, { kid = 'k1', key = privateKey } = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const claims = (over = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  email: 'owner@example.com',
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

before(async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  const jwk = { ...(await webcrypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
});
after(() => { globalThis.fetch = realFetch; });

const opts = { teamDomain: TEAM, audience: AUD };

test('accepts a valid Access token', async () => {
  const c = await verifyAccessJwt(await sign(claims()), opts);
  assert.equal(c.email, 'owner@example.com');
});

test('rejects wrong audience, issuer, expiry and tampering', async () => {
  await assert.rejects(verifyAccessJwt(await sign(claims({ aud: ['other'] })), opts), /audience/);
  await assert.rejects(verifyAccessJwt(await sign(claims({ iss: 'https://evil.cloudflareaccess.com' })), opts), /issuer/);
  await assert.rejects(verifyAccessJwt(await sign(claims({ exp: 1 })), opts), /expired/);
  const [h, , s] = (await sign(claims())).split('.');
  const forged = `${h}.${b64url(JSON.stringify(claims({ email: 'attacker@example.com' })))}.${s}`;
  await assert.rejects(verifyAccessJwt(forged, opts), /signature/);
  await assert.rejects(verifyAccessJwt(await sign(claims(), { kid: 'unknown' }), opts), /signing key/);
  await assert.rejects(verifyAccessJwt('not-a-jwt', opts), /Malformed/);
});

test('refuses every request while the Access settings are still placeholders', async () => {
  const req = new Request('https://dash.example.com/api/me');
  for (const env of [
    { ACCESS_TEAM_DOMAIN: 'REPLACE-WITH-TEAM-NAME.cloudflareaccess.com', ACCESS_AUD: AUD },
    { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'REPLACE_WITH_ACCESS_AUD_TAG' },
    { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
  ]) {
    await assert.rejects(authenticate(req, env), { status: 500, message: /missing ACCESS_TEAM_DOMAIN/ });
  }
});
