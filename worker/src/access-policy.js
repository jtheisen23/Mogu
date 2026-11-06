// Keeps the Cloudflare Access policy that guards the dashboard in step with the
// Admin user list, so people are added and removed in one place.
//
// The policy (ACCESS_POLICY_NAME, a reusable Access policy) gets one "Emails"
// include rule per active dashboard user, plus every BOOTSTRAP_ADMINS email so
// an admin can never be locked out. Other include rules (e.g. "Emails ending
// in") are left alone. Without the ACCESS_POLICY_TOKEN secret nothing happens
// and people are added to the policy by hand, as before.
//
// Configuration:
//   ACCESS_POLICY_TOKEN    Worker secret: Cloudflare API token with
//                          Account > Access: Apps and Policies > Edit
//   CLOUDFLARE_ACCOUNT_ID  wrangler.toml var
//   ACCESS_POLICY_NAME     wrangler.toml var, e.g. "Mogu dashboard users"

const API = 'https://api.cloudflare.com/client/v4';

// Fields of a reusable policy that are sent back unchanged on update.
const WRITABLE = [
  'name', 'decision', 'include', 'exclude', 'require', 'session_duration',
  'approval_required', 'approval_groups', 'isolation_required',
  'purpose_justification_required', 'purpose_justification_prompt',
  'connection_rules', 'mfa_config',
];

export function accessSyncConfigured(env) {
  return !!(env.ACCESS_POLICY_TOKEN && env.CLOUDFLARE_ACCOUNT_ID && env.ACCESS_POLICY_NAME);
}

async function cf(env, method, path, body) {
  const res = await fetch(`${API}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.ACCESS_POLICY_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const detail = json.errors?.map((e) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${method} ${path.split('?')[0]} failed: ${detail}`);
  }
  return json;
}

async function findPolicy(env) {
  const want = env.ACCESS_POLICY_NAME.trim().toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const json = await cf(env, 'GET', `/access/policies?page=${page}&per_page=50`);
    const list = json.result || [];
    const hit = list.find((p) => String(p.name || '').trim().toLowerCase() === want);
    if (hit) return hit;
    const info = json.result_info;
    if (!list.length || !info || page * (info.per_page || 50) >= (info.total_count ?? 0)) break;
  }
  return null;
}

const ruleEmail = (r) => (r && r.email && typeof r.email.email === 'string' ? r.email.email.toLowerCase() : null);

/**
 * Makes the policy's individual-email rules exactly `emails`.
 * Never throws: returns { status: 'skipped' | 'unchanged' | 'updated' | 'error', message, added, removed }.
 */
export async function syncAccessPolicy(env, emails) {
  if (!accessSyncConfigured(env)) {
    return { status: 'skipped', message: 'Automatic Cloudflare Access updates are off (no ACCESS_POLICY_TOKEN secret).', added: [], removed: [] };
  }
  try {
    const want = [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort();
    if (!want.length) throw new Error('refusing to remove every email from the Access policy');

    const policy = await findPolicy(env);
    if (!policy) throw new Error(`no reusable Access policy named "${env.ACCESS_POLICY_NAME}"`);

    const include = Array.isArray(policy.include) ? policy.include : [];
    const have = include.map(ruleEmail).filter(Boolean);
    const added = want.filter((e) => !have.includes(e));
    const removed = have.filter((e) => !want.includes(e));
    if (!added.length && !removed.length) {
      return { status: 'unchanged', message: `Cloudflare Access policy "${policy.name}" already matches.`, added, removed };
    }

    const body = {};
    for (const k of WRITABLE) if (policy[k] !== undefined && policy[k] !== null) body[k] = policy[k];
    body.include = [...include.filter((r) => !ruleEmail(r)), ...want.map((email) => ({ email: { email } }))];
    await cf(env, 'PUT', `/access/policies/${policy.id}`, body);

    const parts = [];
    if (added.length) parts.push(`added ${added.join(', ')}`);
    if (removed.length) parts.push(`removed ${removed.join(', ')}`);
    return { status: 'updated', message: `Cloudflare Access policy "${policy.name}" updated: ${parts.join('; ')}.`, added, removed };
  } catch (err) {
    return {
      status: 'error',
      message: `The user was saved, but the Cloudflare Access policy could not be updated (${err.message}). Add or remove them there by hand, or save again to retry.`,
      added: [],
      removed: [],
    };
  }
}
