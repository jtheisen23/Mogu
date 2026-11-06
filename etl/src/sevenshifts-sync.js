#!/usr/bin/env node
// 7shifts -> D1 sync of scheduled labor (published shifts) per location,
// date and role. Covers the last N days plus the next --ahead days.
//
//   node etl/src/sevenshifts-sync.js --days 2               # yesterday, today and the next 14 days
//   node etl/src/sevenshifts-sync.js --start 2026-09-01 --end 2026-09-30
//   node etl/src/sevenshifts-sync.js --check                # read-only report of what the token can see
//   node etl/src/sevenshifts-sync.js --logbook-all          # also load every log book entry ever posted
//   node etl/src/sevenshifts-sync.js --days 7 --out .tmp/7s.sql
//
// Environment: SEVENSHIFTS_ACCESS_TOKEN, LOCATIONS_JSON (or config/locations.json),
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addDays, parseDate, todayIn } from './dates.js';
import { loadLocations } from './config.js';
import { aggregateShifts, localMidnightUtc, matchLocations, SevenShiftsClient } from './sevenshifts.js';
import { lit } from './sql.js';
import { D1Sink, FileSink } from './sink.js';

const { values: args } = parseArgs({
  options: {
    start: { type: 'string' },
    end: { type: 'string' },
    days: { type: 'string', default: '2' },
    ahead: { type: 'string', default: '14' },
    out: { type: 'string' },
    check: { type: 'boolean', default: false },
    'logbook-all': { type: 'boolean', default: false },
    'skip-logbook': { type: 'boolean', default: false },
    config: { type: 'string', default: 'config/locations.json' },
  },
});

// Same names the dashboard leaves out of actual labor (worker/src/api.js).
const EXCLUDED_ROLES = ['register'];

const log = (...a) => console.error(new Date().toISOString(), ...a);

async function main() {
  const client = new SevenShiftsClient({ token: process.env.SEVENSHIFTS_ACCESS_TOKEN, log });
  const locations = loadLocations(args.config);
  if (args.check) return check(client, locations);

  const sink = args.out
    ? new FileSink(args.out)
    : new D1Sink({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.D1_DATABASE_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        log,
      });

  const company = await client.company();
  const pairs = matchLocations(locations, await client.locations(company.id));
  let failures = 0;
  let names = null; // user id -> name, loaded once if the log book is synced

  for (const { loc, remote } of pairs) {
    if (!remote) {
      log(`${loc.id}: no matching 7shifts location (set "sevenShiftsId" in the location config); skipped`);
      failures++;
      continue;
    }
    const tz = loc.timezone || remote.timezone || 'America/New_York';
    const { start, end } = dateRange(tz);
    try {
      const rows = await syncLocation(client, company.id, remote, tz, start, end);
      await sink.write(statements(loc.id, start, end, rows));
      const hours = rows.reduce((s, r) => s + r.hours, 0);
      const cost = rows.reduce((s, r) => s + r.cost, 0);
      log(`${loc.id} <- 7shifts "${remote.name}": ${start} .. ${end}, ${rows.length} rows, ${hours.toFixed(1)} h, $${cost.toFixed(2)} scheduled`);
    } catch (err) {
      failures++;
      log(`${loc.id}: FAILED - ${err.message}`);
    }
    if (args['skip-logbook']) continue;
    try {
      names ??= await client.userNames(company.id);
      const today = todayIn(tz);
      const lbEnd = end < today ? end : today; // no entries for future days
      const posts = await logBook(client, company.id, remote, args['logbook-all'] ? null : { start, end: lbEnd }, names);
      await sink.write(logBookStatements(loc.id, args['logbook-all'] ? null : { start, end: lbEnd }, posts));
      log(`${loc.id} log book: ${posts.length} entries${args['logbook-all'] ? ' (all history)' : ` ${start} .. ${lbEnd}`}`);
    } catch (err) {
      failures++;
      log(`${loc.id} log book: FAILED - ${err.message}`);
    }
  }
  await sink.close();
  if (sink.rowsWritten !== undefined) log(`D1 rows written: ${sink.rowsWritten}`);
  if (failures) process.exitCode = 1;
}

async function syncLocation(client, companyId, remote, tz, start, end) {
  const roleRows = await client.roles(companyId, remote.id);
  const roles = new Map(roleRows.map((r) => [r.id, r.name]));
  const shifts = await client.shifts(
    companyId,
    remote.id,
    localMidnightUtc(start, tz).toISOString(),
    new Date(localMidnightUtc(addDays(end, 1), tz).getTime() - 1000).toISOString(),
  );

  // Shifts without a wage on them fall back to the employee's current wage for that role.
  const wages = new Map();
  for (const s of shifts) {
    if (s.hourly_wage || !s.user_id || s.open || wages.has(s.user_id)) continue;
    try {
      wages.set(s.user_id, await client.userWages(companyId, s.user_id));
    } catch (err) {
      wages.set(s.user_id, []);
      log(`  wages for user ${s.user_id} unavailable (${err.status ?? err.message})`);
    }
  }
  const wageFor = (s) => {
    const list = (wages.get(s.user_id) || []).filter((w) => !w.wage_type || w.wage_type === 'hourly');
    return (list.find((w) => w.role_id === s.role_id) || list[0])?.wage_cents ?? 0;
  };
  return aggregateShifts(shifts, { timeZone: tz, roles, wageFor, excludedRoles: EXCLUDED_ROLES });
}

/** Log book posts with category names, author names and comments attached. */
async function logBook(client, companyId, remote, range, names) {
  const cats = new Map((await client.logBookCategories(companyId, remote.id)).map((c) => [c.id, c.name]));
  let posts = [];
  if (range) {
    for (let d = range.start; d <= range.end; d = addDays(d, 1)) posts.push(...(await client.logBookPosts(companyId, remote.id, d)));
  } else {
    posts = await client.allLogBookPosts(companyId, remote.id);
  }
  const comments = new Map();
  const withComments = posts.filter((p) => p.log_book_comment_count > 0).map((p) => p.id);
  for (let i = 0; i < withComments.length; i += 50) {
    try {
      for (const c of await client.logBookComments(companyId, withComments.slice(i, i + 50))) {
        const postId = c.log_book_id ?? c.log_book_post_id ?? c.post_id;
        if (!comments.has(postId)) comments.set(postId, []);
        comments.get(postId).push({
          author: names.get(c.user_id) || '',
          message: String(c.message ?? c.comment ?? c.body ?? ''),
          created: c.created ?? null,
        });
      }
    } catch (err) {
      log(`  log book comments unavailable (${err.status ?? err.message}); posts are kept without them`);
      break;
    }
  }
  return posts.map((p) => ({
    id: p.id,
    business_date: p.date,
    category: cats.get(p.log_book_category_id) || 'Other',
    author: names.get(p.user_id) || '',
    message: String(p.message ?? '').slice(0, 20000),
    comments: JSON.stringify(comments.get(p.id) || []),
    attachment_count: Array.isArray(p.attachments) ? p.attachments.length : 0,
    attachments: JSON.stringify(
      (Array.isArray(p.attachments) ? p.attachments : [])
        .filter((a) => a?.full_path)
        .map((a) => ({ name: String(a.file_name || 'attachment').slice(0, 200), path: String(a.full_path) })),
    ),
    created: p.created ?? null,
  }));
}

function logBookStatements(locationId, range, posts) {
  const stmts = [
    range
      ? `DELETE FROM log_book_posts WHERE location_id=${lit(locationId)} AND business_date BETWEEN ${lit(range.start)} AND ${lit(range.end)};`
      : `DELETE FROM log_book_posts WHERE location_id=${lit(locationId)};`,
  ];
  const cols = ['id', 'location_id', 'business_date', 'category', 'author', 'message', 'comments', 'attachment_count', 'attachments', 'created'];
  // Notes can be long, so batch by size rather than count (D1 statements max out at 100 KB).
  let batch = [];
  let size = 0;
  const flush = () => {
    if (batch.length) stmts.push(`INSERT OR REPLACE INTO log_book_posts (${cols.join(',')}) VALUES\n${batch.join(',\n')};`);
    batch = [];
    size = 0;
  };
  for (const p of posts) {
    const v = `(${cols.map((c) => lit(c === 'location_id' ? locationId : p[c])).join(',')})`;
    if (size + v.length > 60_000) flush();
    batch.push(v);
    size += v.length;
  }
  flush();
  return stmts;
}

/** Replaces the whole date range for a location, so deleted shifts disappear too. */
function statements(locationId, start, end, rows) {
  const stmts = [
    `DELETE FROM scheduled_labor WHERE location_id=${lit(locationId)} AND business_date BETWEEN ${lit(start)} AND ${lit(end)};`,
  ];
  const cols = ['location_id', 'business_date', 'role', 'shifts', 'employees', 'hours', 'cost', 'open_shifts', 'open_hours'];
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows
      .slice(i, i + 200)
      .map((r) => `(${cols.map((c) => lit(c === 'location_id' ? locationId : r[c])).join(',')})`)
      .join(',\n');
    stmts.push(`INSERT INTO scheduled_labor (${cols.join(',')}) VALUES\n${values};`);
  }
  stmts.push(
    `INSERT INTO schedule_sync (location_id,synced_at,first_date,last_date) VALUES (${lit(locationId)},${lit(new Date().toISOString())},${lit(start)},${lit(end)}) ` +
      'ON CONFLICT(location_id) DO UPDATE SET synced_at=excluded.synced_at, first_date=excluded.first_date, last_date=excluded.last_date;',
  );
  return stmts;
}

function dateRange(tz) {
  if (args.start) {
    const end = args.end || todayIn(tz);
    parseDate(args.start);
    parseDate(end);
    if (end < args.start) throw new Error('--end is before --start');
    return { start: args.start, end };
  }
  const today = todayIn(tz);
  const days = Math.max(1, Number(args.days) || 2);
  const ahead = Math.max(0, Number(args.ahead) || 0);
  return { start: addDays(today, -(days - 1)), end: addDays(today, ahead) };
}

/**
 * Read-only report: company, locations and how they match, roles, and one
 * week of shifts and of time punches per location summarized by field (no
 * employee names). The punch summary is what actual labor from 7shifts is
 * built on.
 */
async function check(client, locations) {
  const lines = [];
  const out = (s = '') => {
    console.log(s);
    lines.push(s);
  };
  out('# 7shifts connection check');
  out();
  try {
    const company = await client.company();
    out(`Company: **${company.name ?? '(no name)'}** (id ${company.id})`);
    const remote = await client.locations(company.id);
    out();
    out('| Dashboard location | 7shifts location | 7shifts id | Time zone |');
    out('|---|---|---|---|');
    const pairs = matchLocations(locations, remote);
    for (const { loc, remote: r } of pairs) out(`| ${loc.id} ${loc.name} | ${r ? r.name : '**no match**'} | ${r?.id ?? ''} | ${r?.timezone ?? ''} |`);
    const unmatched = remote.filter((r) => !pairs.some((p) => p.remote?.id === r.id));
    if (unmatched.length) out(`\nOther 7shifts locations: ${unmatched.map((r) => `${r.name} (id ${r.id})`).join(', ')}`);

    for (const { loc, remote: r } of pairs) {
      if (!r) continue;
      const tz = loc.timezone || r.timezone || 'America/New_York';
      const today = todayIn(tz);
      out(`\n## ${loc.name}`);
      const roles = await client.roles(company.id, r.id);
      out(`Roles (${roles.length}): ${roles.map((x) => x.name).join(', ')}`);
      const shifts = await client.shifts(company.id, r.id, localMidnightUtc(addDays(today, -7), tz).toISOString(), localMidnightUtc(addDays(today, 7), tz).toISOString());
      out(`Shifts from ${addDays(today, -7)} to ${addDays(today, 6)}: ${shifts.length}`);
      if (shifts.length) {
        const keys = [...new Set(shifts.flatMap((s) => Object.keys(s)))].sort();
        out(`Shift fields: ${keys.join(', ')}`);
        const wages = shifts.map((s) => Number(s.hourly_wage)).filter((w) => w > 0).sort((a, b) => a - b);
        out(`Shifts with hourly_wage: ${wages.length}/${shifts.length}; median ${wages.length ? wages[Math.floor(wages.length / 2)] : 'n/a'} (expected in cents)`);
        out(`Open shifts: ${shifts.filter((s) => s.open || !s.user_id).length}; with breaks array: ${shifts.filter((s) => Array.isArray(s.breaks) && s.breaks.length).length}`);
        const sample = shifts.find((s) => Array.isArray(s.breaks) && s.breaks.length);
        if (sample) out(`Break fields: ${Object.keys(sample.breaks[0]).join(', ')}; types: ${[...new Set(shifts.flatMap((s) => (s.breaks || []).map((b) => b.type)))].join(', ')}`);
        const rows = aggregateShifts(shifts, { timeZone: tz, roles: new Map(roles.map((x) => [x.id, x.name])), excludedRoles: EXCLUDED_ROLES });
        out(`Scheduled (published) hours: ${rows.reduce((s, x) => s + x.hours, 0).toFixed(1)}; cost from shift wages: $${rows.reduce((s, x) => s + x.cost, 0).toFixed(2)}`);
        const userId = shifts.find((s) => s.user_id && !s.open)?.user_id;
        if (userId) {
          try {
            const w = await client.userWages(company.id, userId);
            out(`Wage lookup works (${w.length} current wage(s); fields: ${w[0] ? Object.keys(w[0]).join(', ') : 'none'})`);
          } catch (err) {
            out(`Wage lookup failed: ${err.status ?? err.message}`);
          }
        }
      }
      await checkPunches(client, company.id, r, tz, today, out);
    }
  } catch (err) {
    out(`**Failed:** ${err.message}`);
    process.exitCode = 1;
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

/** Summarizes a week of time punches for one location (fields, wages, breaks, hours). */
async function checkPunches(client, companyId, r, tz, today, out) {
  let punches;
  try {
    punches = await client.timePunches(companyId, r.id, localMidnightUtc(addDays(today, -7), tz).toISOString(), localMidnightUtc(today, tz).toISOString());
  } catch (err) {
    out(`Time punches: **failed** (${err.status ?? ''} ${err.message.slice(0, 200)})`);
    return;
  }
  out(`Time punches from ${addDays(today, -7)} to ${addDays(today, -1)}: ${punches.length}`);
  if (!punches.length) return;
  const keys = [...new Set(punches.flatMap((p) => Object.keys(p)))].sort();
  out(`Punch fields: ${keys.join(', ')}`);
  // Counts punches where the field is set and not false/0 (so "approved" counts approved punches).
  const has = (f) => punches.filter((p) => p[f] !== undefined && p[f] !== null && p[f] !== '' && p[f] !== 0 && p[f] !== false).length;
  for (const f of ['clocked_out', 'approved', 'role_id', 'department_id', 'shift_id', 'hourly_wage', 'wage', 'tips', 'deleted']) {
    if (keys.includes(f)) out(`- ${f}: true/set on ${has(f)}/${punches.length}`);
  }
  const wages = punches.map((p) => Number(p.hourly_wage)).filter((w) => w > 0).sort((a, b) => a - b);
  if (wages.length) out(`- hourly_wage median ${wages[Math.floor(wages.length / 2)]}, range ${wages[0]}..${wages[wages.length - 1]} (cents if in the thousands)`);
  const withBreaks = punches.filter((p) => Array.isArray(p.breaks) && p.breaks.length);
  out(`- with breaks: ${withBreaks.length}`);
  if (withBreaks.length) {
    out(`- break fields: ${[...new Set(withBreaks.flatMap((p) => p.breaks.flatMap((b) => Object.keys(b))))].sort().join(', ')}`);
    out(`- paid flags seen: ${[...new Set(withBreaks.flatMap((p) => p.breaks.map((b) => String(b.paid ?? b.is_paid ?? b.type))))].join(', ')}`);
  }
  const hours = punches.reduce((sum, p) => {
    const a = Date.parse(p.clocked_in);
    const b = Date.parse(p.clocked_out);
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? sum + (b - a) / 3600000 : sum;
  }, 0);
  out(`- clocked hours before breaks: ${hours.toFixed(1)} across ${new Set(punches.map((p) => p.user_id)).size} employees`);
}

main().catch((err) => {
  log(err.stack || err.message);
  process.exit(1);
});
