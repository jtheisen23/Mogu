// User management for admins: who can see which locations and sections.

import { bootstrapAdmins, HttpError, requireAdmin, SECTIONS } from './auth.js';
import { EXCLUDED_JOBS, MIX_DIMENSIONS } from './api.js';
import { accessSyncConfigured, syncAccessPolicy } from './access-policy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listUsers(env, user) {
  requireAdmin(user);
  const [{ results: users }, { results: links }, { results: locations }] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM users ORDER BY role, email'),
    env.DB.prepare('SELECT email, location_id FROM user_locations'),
    env.DB.prepare('SELECT id, name FROM locations ORDER BY sort_order, name'),
  ]);
  const byEmail = new Map();
  for (const l of links) {
    const key = l.email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key).push(l.location_id);
  }
  return {
    users: users.map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      active: !!u.active,
      allLocations: !!u.all_locations,
      locations: byEmail.get(u.email.toLowerCase()) || [],
      sections: Object.fromEntries(SECTIONS.map((s) => [s, !!u[`can_${s}`]])),
      updatedAt: u.updated_at,
    })),
    locations,
    bootstrapAdmins: [...bootstrapAdmins(env)],
    // Saving a user also updates the Cloudflare Access policy (access-policy.js).
    accessSync: accessSyncConfigured(env),
  };
}

/** Gives every active user (and every bootstrap admin) sign-in access, and nobody else. */
async function syncAccess(env) {
  const { results } = await env.DB.prepare('SELECT email FROM users WHERE active = 1').all();
  return syncAccessPolicy(env, [...results.map((r) => r.email), ...bootstrapAdmins(env)]);
}

export async function saveUser(env, user, body) {
  requireAdmin(user);
  const email = String(body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');
  const role = body.role === 'admin' ? 'admin' : 'viewer';
  const active = body.active !== false;
  if (email === user.email && (role !== 'admin' || !active)) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  const name = String(body.name || '').slice(0, 100);
  const allLocations = !!body.allLocations;
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, !!body.sections?.[s]]));

  const { results: known } = await env.DB.prepare('SELECT id FROM locations').all();
  const knownIds = new Set(known.map((l) => l.id));
  const locs = [...new Set(Array.isArray(body.locations) ? body.locations : [])].filter((l) => knownIds.has(l));

  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (email, name, role, all_locations, can_sales, can_discounts, can_labor, can_items, can_sevenshifts, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, all_locations=excluded.all_locations,
         can_sales=excluded.can_sales, can_discounts=excluded.can_discounts, can_labor=excluded.can_labor,
         can_items=excluded.can_items, can_sevenshifts=excluded.can_sevenshifts, active=excluded.active, updated_at=excluded.updated_at`,
    ).bind(
      email,
      name,
      role,
      allLocations ? 1 : 0,
      sections.sales ? 1 : 0,
      sections.discounts ? 1 : 0,
      sections.labor ? 1 : 0,
      sections.items ? 1 : 0,
      sections.sevenshifts ? 1 : 0,
      active ? 1 : 0,
    ),
    env.DB.prepare('DELETE FROM user_locations WHERE email = ?').bind(email),
    ...locs.map((l) => env.DB.prepare('INSERT INTO user_locations (email, location_id) VALUES (?, ?)').bind(email, l)),
    env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').bind(
      user.email,
      'save_user',
      JSON.stringify({ email, role, active, allLocations, locations: locs, sections }),
    ),
  ];
  await env.DB.batch(stmts);
  return { ok: true, access: await syncAccess(env) };
}

export async function deleteUser(env, user, email) {
  requireAdmin(user);
  email = String(email || '').trim().toLowerCase();
  if (email === user.email) throw new HttpError(400, 'You cannot delete yourself');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_locations WHERE email = ?').bind(email),
    env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email),
    env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').bind(user.email, 'delete_user', email),
  ]);
  return { ok: true, access: await syncAccess(env) };
}

export async function auditLog(env, user) {
  requireAdmin(user);
  const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 200').all();
  return { entries: results };
}

// ---------------------------------------------------------------------------
// Category groups: merge Toast labels (sales categories, dining options,
// revenue centers, discounts) into admin-defined groups for reporting.
// ---------------------------------------------------------------------------

const GROUP_DIMENSIONS = new Set([...MIX_DIMENSIONS, 'discount', 'labor_job']);

function readDimension(value) {
  if (!GROUP_DIMENSIONS.has(value)) throw new HttpError(400, 'Unknown dimension');
  return value;
}

/** Every label Toast has used for a dimension, with last-year sales for context and its current group. */
export async function listGroups(env, user, url) {
  requireAdmin(user);
  const dimension = readDimension(url.searchParams.get('dimension') || 'sales_category');
  // Discounts live in their own table; the others in sales_mix. Either way the
  // amount column is last-12-month dollars (net sales, or discount amount).
  if (dimension === 'labor_job') {
    // Labor jobs, to be grouped into roles; 7shifts roles are offered as suggestions.
    const [jobs, roles] = await env.DB.batch([
      env.DB.prepare(
        `SELECT l.job_title AS label, ROUND(SUM(l.regular_cost + l.overtime_cost), 2) AS net_sales, MAX(l.business_date) AS last_seen, g.group_name
           FROM labor_daily l
           LEFT JOIN category_groups g ON g.dimension = 'labor_job' AND g.source_label = l.job_title
          WHERE l.business_date >= date('now', '-365 days')
            AND LOWER(TRIM(l.job_title)) NOT IN (${EXCLUDED_JOBS.map(() => '?').join(',')})
          GROUP BY l.job_title ORDER BY net_sales DESC`,
      ).bind(...EXCLUDED_JOBS),
      env.DB.prepare('SELECT DISTINCT role FROM scheduled_labor ORDER BY role'),
    ]);
    return { dimension, labels: jobs.results, suggestions: roles.results.map((r) => r.role) };
  }
  const stmt =
    dimension === 'discount'
      ? env.DB.prepare(
          `SELECT d.discount_name AS label, ROUND(SUM(d.amount), 2) AS net_sales, MAX(d.business_date) AS last_seen, g.group_name
             FROM discount_sales d
             LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
            WHERE d.business_date >= date('now', '-365 days')
            GROUP BY d.discount_name ORDER BY net_sales DESC`,
        )
      : env.DB.prepare(
          `SELECT m.label, ROUND(SUM(m.net_sales), 2) AS net_sales, MAX(m.business_date) AS last_seen, g.group_name
             FROM sales_mix m
             LEFT JOIN category_groups g ON g.dimension = m.dimension AND g.source_label = m.label
            WHERE m.dimension = ? AND m.business_date >= date('now', '-365 days')
            GROUP BY m.label ORDER BY net_sales DESC`,
        ).bind(dimension);
  const { results } = await stmt.all();
  return { dimension, labels: results };
}

/** Replaces all groupings for one dimension. Body: { dimension, mappings: [{ label, group }] } */
export async function saveGroups(env, user, body) {
  requireAdmin(user);
  const dimension = readDimension(body?.dimension);
  // The label is stored exactly as Toast has it (stray spaces included) so it
  // matches when reports join on it. Grouping a name under itself is kept too,
  // so the box shows what was typed after a reload.
  const mappings = (Array.isArray(body?.mappings) ? body.mappings : [])
    .map((m) => ({ label: String(m?.label ?? ''), group: String(m?.group ?? '').trim().slice(0, 60) }))
    .filter((m) => m.label && m.group);
  if (mappings.length > 500) throw new HttpError(400, 'Too many mappings');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM category_groups WHERE dimension = ?').bind(dimension),
    ...mappings.map((m) =>
      env.DB.prepare('INSERT INTO category_groups (dimension, source_label, group_name) VALUES (?, ?, ?)').bind(
        dimension,
        m.label,
        m.group,
      ),
    ),
    env.DB.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').bind(
      user.email,
      'save_groups',
      JSON.stringify({ dimension, mappings }),
    ),
  ]);
  return { ok: true, saved: mappings.length };
}
