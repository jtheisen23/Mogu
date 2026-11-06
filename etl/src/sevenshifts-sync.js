#!/usr/bin/env node
// 7shifts -> D1 sync of scheduled labor (published shifts) per location,
// date and role. Covers the last N days plus the next --ahead days.
//
//   node etl/src/sevenshifts-sync.js --days 2               # yesterday, today and the next 14 days
//   node etl/src/sevenshifts-sync.js --start 2026-09-01 --end 2026-09-30
//   node etl/src/sevenshifts-sync.js --check                # read-only report of what the token can see
//   node etl/src/sevenshifts-sync.js --logbook-all          # also load every log book entry ever posted
//   node etl/src/sevenshifts-sync.js --days 7 --out .tmp/7s.sql
//   node etl/src/sevenshifts-sync.js --days 2 --labor       # also actual labor from time punches
//
// With --labor, actual labor (labor_daily, the Labor tab) comes from 7shifts
// time punches, and only from them (the Toast sync runs with --skip-labor);
// every synced day is replaced. Hourly punches only, overtime
// past 40 h per employee per workweek (SEVENSHIFTS_WEEK_START, default 1 =
// Monday) across all locations, salaried pay from each location's
// salariedLaborPerDay.
//
// Environment: SEVENSHIFTS_ACCESS_TOKEN, LOCATIONS_JSON (or config/locations.json),
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addDays, parseDate, todayIn } from './dates.js';
import { loadLocations } from './config.js';
import {
  aggregateShifts, allocateOvertime, effectiveWageCents, hourlyWageCents, isSalaried, laborStatements, localDate, localMidnightUtc,
  matchLocations, punchHours, punchLaborRows, SevenShiftsClient, weekStartOf,
} from './sevenshifts.js';
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
    labor: { type: 'boolean', default: false },
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
  const remoteLocations = await client.locations(company.id);
  const pairs = matchLocations(locations, remoteLocations);
  let failures = 0;
  let names = null; // user id -> name, loaded once if the log book is synced

  // Current 7shifts wages per user, fetched once per run (used for missing
  // wages and to tell salaried people from hourly ones).
  const wageCache = new Map();
  const wagesOf = async (userId) => {
    if (!userId) return [];
    if (!wageCache.has(userId)) {
      try {
        wageCache.set(userId, await client.userWages(company.id, userId));
      } catch (err) {
        wageCache.set(userId, []);
        log(`  wages for user ${userId} unavailable (${err.status ?? err.message})`);
      }
    }
    return wageCache.get(userId);
  };

  let labor = null;
  if (args.labor) {
    try {
      labor = await punchLabor(client, company.id, remoteLocations, pairs, wagesOf);
    } catch (err) {
      failures++;
      log(`Actual labor from 7shifts: FAILED - ${err.message}`);
    }
  }

  for (const { loc, remote } of pairs) {
    if (!remote) {
      log(`${loc.id}: no matching 7shifts location (set "sevenShiftsId" in the location config); skipped`);
      failures++;
      continue;
    }
    const tz = loc.timezone || remote.timezone || 'America/New_York';
    const { start, end } = dateRange(tz);
    if (labor?.has(loc.id)) {
      const l = labor.get(loc.id);
      try {
        await sink.write(laborStatements(loc.id, l.start, l.end, l.rows, loc.salariedLaborPerDay));
        const hours = l.rows.reduce((s, r) => s + r.regular_hours + r.overtime_hours, 0);
        const cost = l.rows.reduce((s, r) => s + r.regular_cost + r.overtime_cost, 0);
        log(`${loc.id} actual labor: ${l.start} .. ${l.end}, ${l.days.length} day(s) with punches, ${l.punches} hourly punches, ${hours.toFixed(1)} h, $${cost.toFixed(2)}${l.salaried ? ` (${l.salaried} salaried punches left out)` : ''}`);
      } catch (err) {
        failures++;
        log(`${loc.id} actual labor: FAILED - ${err.message}`);
      }
    }
    try {
      const rows = await syncLocation(client, company.id, remote, tz, start, end, wagesOf);
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

async function syncLocation(client, companyId, remote, tz, start, end, wagesOf) {
  const roleRows = await client.roles(companyId, remote.id);
  const roles = new Map(roleRows.map((r) => [r.id, r.name]));
  const shifts = await client.shifts(
    companyId,
    remote.id,
    localMidnightUtc(start, tz).toISOString(),
    new Date(localMidnightUtc(addDays(end, 1), tz).getTime() - 1000).toISOString(),
  );

  // Shifts without a wage on them fall back to the employee's current hourly
  // wage for that role. Salaried people's shifts are left out, as in actual labor.
  const wages = new Map();
  for (const s of shifts) if (s.user_id && !s.open && !wages.has(s.user_id)) wages.set(s.user_id, await wagesOf(s.user_id));
  const wageFor = (s) => hourlyWageCents(wages.get(s.user_id), s.role_id);
  // The check uses the wage the shift would be costed at, fallback included: some
  // salaried people have their salary entered as an "hourly" 7shifts wage.
  const exclude = (s) => !!s.user_id && !s.open
    && isSalaried(wages.get(s.user_id), s.role_id, effectiveWageCents(wages.get(s.user_id), s.role_id, s.hourly_wage));
  return aggregateShifts(shifts, { timeZone: tz, roles, wageFor, excludedRoles: EXCLUDED_ROLES, exclude });
}

/**
 * Actual labor from time punches for every matched location. Punches are
 * read for all 7shifts locations (Central Kitchen too) from the start of the
 * first workweek, so overtime counts every hour an employee worked that week.
 * Returns loc.id -> { start, end, rows, punches, salaried }.
 */
async function punchLabor(client, companyId, remoteLocations, pairs, wagesOf) {
  const weekStart = Number(process.env.SEVENSHIFTS_WEEK_START ?? 1);
  const overtimeMultiplier = Number(process.env.OVERTIME_MULTIPLIER || 1.5);
  const skip = new Set(EXCLUDED_ROLES);
  const items = [];
  const ranges = new Map();
  const salariedByRemote = new Map();
  const daysByRemote = new Map(); // days with any closed punch (reported in the log)
  for (const r of remoteLocations) {
    const pair = pairs.find((p) => p.remote?.id === r.id);
    const tz = pair?.loc.timezone || r.timezone || 'America/New_York';
    const { start, end } = dateRange(tz);
    const today = todayIn(tz);
    const last = end < today ? end : today; // no punches in the future
    if (last < start) continue;
    ranges.set(r.id, { start, end: last });
    const from = weekStartOf(start, weekStart);
    const punches = await client.timePunches(
      companyId,
      r.id,
      localMidnightUtc(from, tz).toISOString(),
      new Date(localMidnightUtc(addDays(last, 1), tz).getTime() - 1000).toISOString(),
    );
    const roles = new Map((await client.roles(companyId, r.id)).map((x) => [x.id, x.name]));
    let salaried = 0;
    const days = new Set();
    for (const p of punches) {
      if (p.deleted || !p.user_id) continue;
      const hours = punchHours(p);
      if (hours === null) continue; // still clocked in; a later sync picks it up
      const date = localDate(p.clocked_in, tz);
      if (date >= start && date <= last) days.add(date);
      const role = roles.get(p.role_id) || (p.role_id ? `Role ${p.role_id}` : 'No role');
      if (skip.has(role.trim().toLowerCase())) continue;
      const wages = await wagesOf(p.user_id);
      // Checked against the wage the punch is costed at (fallback included): some
      // salaried people have their salary entered as an "hourly" 7shifts wage.
      const cents = effectiveWageCents(wages, p.role_id, p.hourly_wage);
      if (isSalaried(wages, p.role_id, cents)) {
        salaried++;
        continue;
      }
      items.push({ remoteId: r.id, user_id: p.user_id, clockedIn: Date.parse(p.clocked_in), date, hours, role, wage: cents / 100 });
    }
    salariedByRemote.set(r.id, salaried);
    daysByRemote.set(r.id, [...days]);
  }
  allocateOvertime(items, { weekStart });

  const out = new Map();
  for (const { loc, remote } of pairs) {
    const range = remote && ranges.get(remote.id);
    if (!range) continue;
    const mine = items.filter((it) => it.remoteId === remote.id && it.date >= range.start && it.date <= range.end);
    out.set(loc.id, {
      ...range,
      days: daysByRemote.get(remote.id) || [],
      rows: punchLaborRows(mine, { overtimeMultiplier }),
      punches: mine.length,
      salaried: salariedByRemote.get(remote.id) || 0,
    });
  }
  return out;
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
        out(`Shifts with hourly_wage: ${shifts.filter((s) => Number(s.hourly_wage) > 0).length}/${shifts.length}`);
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
      const punches = await checkPunches(client, company.id, r, tz, today, out);
      await checkWageTypes(client, company.id, new Map(roles.map((x) => [x.id, x.name])), shifts, punches || [], out);
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
  return punches;
}

// An "hourly" wage above this (in cents) is almost certainly a salary amount.
const IMPLAUSIBLE_HOURLY_CENTS = 10000;

/**
 * Per role: how many shifts and punches carry a wage, how many of those look
 * like a salary rather than an hourly rate, and which 7shifts wage types the
 * people in that role have. Counts only: no names or amounts, because the
 * Actions log may be public.
 */
async function checkWageTypes(client, companyId, roles, shifts, punches, out) {
  const roleName = (id) => roles.get(id) || (id ? `role ${id}` : 'no role');
  const userIds = [...new Set([...shifts, ...punches].map((x) => x.user_id).filter(Boolean))];
  const typesByUser = new Map();
  for (const id of userIds.slice(0, 60)) {
    try {
      const wages = await client.userWages(companyId, id);
      typesByUser.set(id, wages.map((w) => ({ type: w.wage_type || 'unknown', role: w.role_id, cents: Number(w.wage_cents) || 0 })));
    } catch (err) {
      typesByUser.set(id, [{ type: `lookup failed (${err.status ?? 'error'})`, role: null, cents: 0 }]);
    }
  }
  const rows = new Map();
  const row = (role) => {
    if (!rows.has(role)) rows.set(role, { shifts: 0, shiftHigh: 0, punches: 0, punchNoWage: 0, punchHigh: 0, salaryOnShift: 0, types: new Map() });
    return rows.get(role);
  };
  for (const s of shifts) {
    if (!s.user_id || s.open) continue;
    const r = row(roleName(s.role_id));
    r.shifts++;
    const cents = Number(s.hourly_wage) || 0;
    if (cents > IMPLAUSIBLE_HOURLY_CENTS) r.shiftHigh++;
    if ((typesByUser.get(s.user_id) || []).some((w) => w.type !== 'hourly' && w.cents && w.cents === cents)) r.salaryOnShift++;
  }
  for (const p of punches) {
    const r = row(roleName(p.role_id));
    r.punches++;
    const cents = Number(p.hourly_wage) || 0;
    if (!cents) r.punchNoWage++;
    if (cents > IMPLAUSIBLE_HOURLY_CENTS) r.punchHigh++;
  }
  for (const [userId, wages] of typesByUser) {
    const inRoles = new Set([...shifts, ...punches].filter((x) => x.user_id === userId).map((x) => roleName(x.role_id)));
    for (const role of inRoles) {
      const t = row(role).types;
      for (const type of new Set(wages.map((w) => w.type))) t.set(type, (t.get(type) || 0) + 1);
    }
  }
  out('');
  out('| Role | Shifts | Shift wage > $100/h | Shift wage = salary | Punches | Punches without wage | Punch wage > $100/h | 7shifts wage types (people) |');
  out('|---|---|---|---|---|---|---|---|');
  for (const [role, r] of [...rows].sort()) {
    const types = [...r.types].map(([t, n]) => `${t} ×${n}`).join(', ') || '—';
    out(`| ${role} | ${r.shifts} | ${r.shiftHigh} | ${r.salaryOnShift} | ${r.punches} | ${r.punchNoWage} | ${r.punchHigh} | ${types} |`);
  }
}

main().catch((err) => {
  log(err.stack || err.message);
  process.exit(1);
});
