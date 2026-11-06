// Cloudflare Worker entry point. Static files in /public are served directly
// by Workers Static Assets; everything under /api/* lands here.

import { authenticate, HttpError } from './auth.js';
import * as api from './api.js';
import * as admin from './admin.js';
import { dispatchSync } from './scheduler.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/health') return json({ ok: true });

  const user = await authenticate(request, env);

  if (method === 'GET') {
    switch (pathname) {
      case '/api/me':
        return json({ user });
      case '/api/locations':
        return json(await api.locations(env, user));
      case '/api/overview':
        return json(await api.overview(env, url, user));
      case '/api/mix':
        return json(await api.mix(env, url, user));
      case '/api/discounts':
        return json(await api.discounts(env, url, user));
      case '/api/labor':
        return json(await api.labor(env, url, user));
      case '/api/items':
        return json(await api.items(env, url, user));
      case '/api/admin/users':
        return json(await admin.listUsers(env, user));
      case '/api/admin/audit':
        return json(await admin.auditLog(env, user));
      case '/api/admin/groups':
        return json(await admin.listGroups(env, user, url));
    }
  }

  if ((pathname === '/api/admin/users' && (method === 'POST' || method === 'DELETE')) ||
      (pathname === '/api/admin/groups' && method === 'POST')) {
    // Same-origin check: blocks cross-site form posts riding the Access cookie.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request refused');
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        throw new HttpError(400, 'Invalid JSON');
      }
      if (pathname === '/api/admin/groups') return json(await admin.saveGroups(env, user, body));
      return json(await admin.saveUser(env, user, body));
    }
    return json(await admin.deleteUser(env, user, url.searchParams.get('email')));
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },

  // Cron triggers from wrangler.toml: start the Toast sync on GitHub Actions.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchSync(env, { cron: event.cron, scheduledTime: event.scheduledTime }));
  },
};
