// Authentication and authorization.
//
// 1. Cloudflare Access sits in front of the whole site and handles login
//    (email one-time PIN, Google, Microsoft...). It forwards a signed JWT in
//    the Cf-Access-Jwt-Assertion header.
// 2. We verify that JWT ourselves (never trust the email header alone), then
//    look the email up in the `users` table to decide which locations and
//    sections this person can see. Unknown emails get a 403 even if Access
//    let them in.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SECTIONS = ['sales', 'discounts', 'labor', 'items'];

let jwksCache = { domain: null, keys: new Map(), fetchedAt: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadKeys(domain, force = false) {
  const fresh = jwksCache.domain === domain && Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (fresh && !force) return jwksCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, 'Could not load Cloudflare Access signing keys');
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    map.set(
      jwk.kid,
      await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    );
  }
  jwksCache = { domain, keys: map, fetchedAt: Date.now() };
  return map;
}

/** Verifies a Cloudflare Access JWT and returns its claims. */
export async function verifyAccessJwt(token, { teamDomain, audience, now = Date.now() }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed access token');
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = b64urlToJson(h);
    payload = b64urlToJson(p);
  } catch {
    throw new HttpError(401, 'Malformed access token');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unexpected token algorithm');

  let keys = await loadKeys(teamDomain);
  if (!keys.has(header.kid)) keys = await loadKeys(teamDomain, true); // keys rotated
  const key = keys.get(header.kid);
  if (!key) throw new HttpError(401, 'Unknown token signing key');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new HttpError(401, 'Invalid token signature');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new HttpError(401, 'Token audience mismatch');
  if (payload.iss !== `https://${teamDomain}`) throw new HttpError(401, 'Token issuer mismatch');
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) throw new HttpError(401, 'Token expired');
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) throw new HttpError(401, 'Token not yet valid');
  return payload;
}

function cookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function identify(request, env) {
  if (env.AUTH_MODE === 'dev') {
    // Local development only (set in .dev.vars, never in wrangler.toml).
    if (!env.DEV_USER_EMAIL) throw new HttpError(500, 'AUTH_MODE=dev requires DEV_USER_EMAIL');
    return env.DEV_USER_EMAIL.toLowerCase();
  }
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  // The REPLACE_... placeholders in wrangler.toml count as unset, so a deploy
  // made before Access is configured refuses every request with a clear message.
  const unset = (v) => !v || /REPLACE/i.test(v);
  if (unset(teamDomain) || unset(env.ACCESS_AUD)) {
    throw new HttpError(500, 'Server is missing ACCESS_TEAM_DOMAIN / ACCESS_AUD configuration');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) throw new HttpError(401, 'Not signed in');
  const claims = await verifyAccessJwt(token, { teamDomain, audience: env.ACCESS_AUD });
  if (!claims.email) throw new HttpError(403, 'Service tokens cannot use the dashboard');
  return String(claims.email).toLowerCase();
}

function bootstrapAdmins(env) {
  return new Set(
    String(env.BOOTSTRAP_ADMINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Returns the signed-in user with resolved permissions:
 * { email, name, role, isAdmin, locations: string[], sections: {sales,discounts,labor,items} }
 */
export async function authenticate(request, env) {
  const email = await identify(request, env);
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ? AND active = 1').bind(email).first();
  const isBootstrap = bootstrapAdmins(env).has(email);

  if (!row && !isBootstrap) {
    throw new HttpError(403, `${email} is signed in but has not been given access to the dashboard. Ask an admin to add you.`);
  }
  const isAdmin = isBootstrap || row?.role === 'admin';

  const { results: allLocations } = await env.DB.prepare(
    'SELECT id FROM locations WHERE active = 1 ORDER BY sort_order, name',
  ).all();
  let locations;
  if (isAdmin || row.all_locations) {
    locations = allLocations.map((l) => l.id);
  } else {
    const { results } = await env.DB.prepare('SELECT location_id FROM user_locations WHERE email = ?').bind(email).all();
    const allowed = new Set(results.map((r) => r.location_id));
    locations = allLocations.map((l) => l.id).filter((id) => allowed.has(id));
  }

  const sections = Object.fromEntries(SECTIONS.map((s) => [s, isAdmin || !!row?.[`can_${s}`]]));
  return {
    email,
    name: row?.name || '',
    role: isAdmin ? 'admin' : 'viewer',
    isAdmin,
    locations,
    sections,
  };
}

export function requireSection(user, section) {
  if (!user.sections[section]) throw new HttpError(403, `You do not have access to ${section} data`);
}

export function requireAdmin(user) {
  if (!user.isAdmin) throw new HttpError(403, 'Admins only');
}
