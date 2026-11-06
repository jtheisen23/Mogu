// Cron triggers (wrangler.toml [triggers]) start the Toast sync on GitHub
// Actions. Cloudflare's scheduler fires on time; GitHub's own skipped most
// hourly runs. The Worker only dispatches the workflow; the sync itself runs
// on GitHub, where it has the Toast credentials and no CPU-time limit.

export const HOURLY_CRON = '17 * * * *';
export const NIGHTLY_CRON = '40 8 * * *'; // ~4:40am Eastern (3:40am in winter)

const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });

/** How many days a scheduled run should sync. */
export function daysFor(cron, scheduledTime) {
  if (cron === NIGHTLY_CRON) return 7; // re-check the last week for late edits
  // Between midnight and 6am Eastern also finish yesterday: its last orders
  // came in after the final evening run.
  const hour = Number(hourFormat.format(new Date(scheduledTime))) % 24;
  return hour < 6 ? 2 : 1;
}

export async function dispatchSync(env, { cron, scheduledTime }) {
  const token = env.GITHUB_DISPATCH_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) {
    console.error('Toast sync not dispatched: set the GITHUB_DISPATCH_TOKEN secret and GITHUB_REPO variable');
    return { ok: false, reason: 'not configured' };
  }
  const days = daysFor(cron, scheduledTime);
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/toast-sync.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mogu-dashboard-scheduler',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main', inputs: { days: String(days) } }),
  });
  if (res.status !== 204) {
    const detail = (await res.text()).slice(0, 300);
    console.error(`Toast sync dispatch failed (${res.status}): ${detail}`);
    return { ok: false, status: res.status };
  }
  console.log(`Toast sync dispatched for the last ${days} day(s) (cron ${cron})`);
  return { ok: true, days };
}
