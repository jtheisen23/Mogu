#!/usr/bin/env node
// Toast -> D1 sync.
//
//   node etl/src/index.js                       # yesterday + today (default)
//   node etl/src/index.js --days 7              # last 7 business dates
//   node etl/src/index.js --start 2025-01-01 --end 2025-12-31   # backfill
//   node etl/src/index.js --locations DT,UT --out .tmp/sync.sql  # write SQL instead of D1
//   node etl/src/index.js --backfill --from 2025-01-01 --max-rows 60000  # nightly history load
//   node etl/src/index.js --start 2026-02-01 --end 2026-10-10 --revenue-centers-only
//                                   # rewrite only revenue center sales (after a mapping fix)
//
// Environment: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, [TOAST_API_HOST],
//   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID,
//   [LOCATIONS_JSON], [OVERTIME_MULTIPLIER]

import { parseArgs } from 'node:util';
import { addDays, eachDate, parseDate, todayIn, toToastDate } from './dates.js';
import { loadLocations } from './config.js';
import { ToastClient } from './toast.js';
import { aggregateLabor, aggregateOrders } from './transform.js';
import { dayStatements, mixStatements, upsertLocationsSql } from './sql.js';
import { D1Sink, FileSink } from './sink.js';

const { values: args } = parseArgs({
  options: {
    start: { type: 'string' },
    end: { type: 'string' },
    days: { type: 'string' },
    locations: { type: 'string' },
    out: { type: 'string' },
    'skip-labor': { type: 'boolean', default: false },
    'revenue-centers-only': { type: 'boolean', default: false },
    backfill: { type: 'boolean', default: false },
    from: { type: 'string', default: '2025-01-01' },
    'max-rows': { type: 'string', default: '60000' },
    config: { type: 'string', default: 'config/locations.json' },
  },
});

const log = (...a) => console.error(new Date().toISOString(), ...a);

async function main() {
  // Backfill progress comes from sync_log, which a revenue-centers-only run doesn't update.
  if (args.backfill && args['revenue-centers-only']) throw new Error('--revenue-centers-only needs --start/--days, not --backfill');
  let locations = loadLocations(args.config);
  if (args.locations) {
    const want = new Set(args.locations.split(',').map((s) => s.trim().toUpperCase()));
    locations = locations.filter((l) => want.has(l.id.toUpperCase()));
    if (!locations.length) throw new Error(`No configured locations match --locations ${args.locations}`);
  }

  const toast = new ToastClient({
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    host: process.env.TOAST_API_HOST || undefined,
    log,
  });
  const sink = args.out
    ? new FileSink(args.out)
    : new D1Sink({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        databaseId: process.env.D1_DATABASE_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        log,
      });
  const overtimeMultiplier = Number(process.env.OVERTIME_MULTIPLIER || 1.5);

  // Keep the locations table in step with config.
  await sink.write(upsertLocationsSql(locations));

  const syncDay = async (loc, date, lookups) => {
    const tz = loc.timezone || 'America/New_York';
    const toastDate = toToastDate(date);
    const orders = await toast.ordersForBusinessDate(loc.toastGuid, toastDate);
    const sales = aggregateOrders(orders, { timezone: tz, lookups });
    if (args['revenue-centers-only']) {
      await sink.write(mixStatements(loc.id, date, sales, 'revenue_center'));
      log(`  ${loc.id} ${date}: ${orders.length} orders, revenue centers rewritten`);
      return;
    }
    let entries = [];
    let labor = null;
    if (!args['skip-labor']) {
      entries = await toast.timeEntriesForBusinessDate(loc.toastGuid, toastDate);
      labor = aggregateLabor(entries, {
        lookups,
        overtimeMultiplier,
        salariedLaborPerDay: loc.salariedLaborPerDay,
      });
    }
    await sink.write(dayStatements(loc.id, date, sales, labor, { orders: orders.length, timeEntries: entries.length }));
    log(`  ${loc.id} ${date}: ${orders.length} orders, net $${sales.daily.net_sales.toFixed(2)}, ${entries.length} time entries`);
  };

  let failures = 0;
  if (args.backfill) {
    failures = await backfill({ locations, toast, sink, syncDay });
  } else {
    for (const loc of locations) {
      const tz = loc.timezone || 'America/New_York';
      const { start, end } = dateRange(tz);
      log(`${loc.id} (${loc.name}): syncing ${start} .. ${end}`);
      const lookups = await toast.lookups(loc.toastGuid);
      for (const date of eachDate(start, end)) {
        try {
          await syncDay(loc, date, lookups);
        } catch (err) {
          failures++;
          log(`  ${loc.id} ${date}: FAILED - ${err.message}`);
        }
      }
    }
  }
  await sink.close();
  if (sink.rowsWritten !== undefined) log(`D1 rows written: ${sink.rowsWritten}`);
  if (failures) {
    log(`Finished with ${failures} failed location-day(s)`);
    process.exitCode = 1;
  } else {
    log('Sync complete');
  }
}

/**
 * Loads history backwards from each location's earliest synced day toward
 * --from, round-robin across locations so they fill in evenly, and stops once
 * --max-rows D1 rows have been written (the free plan allows 100k/day and the
 * regular syncs need some of that). Safe to run every night: when every
 * location has reached --from it does nothing.
 */
async function backfill({ locations, toast, sink, syncDay }) {
  if (!(sink instanceof D1Sink)) throw new Error('--backfill needs the D1 database (it reads progress from sync_log)');
  const from = args.from;
  parseDate(from);
  const maxRows = Number(args['max-rows']);
  if (!(maxRows > 0)) throw new Error('--max-rows must be a positive number');

  const rows = await sink.query('SELECT location_id, MIN(business_date) AS earliest FROM sync_log GROUP BY location_id');
  const earliest = new Map(rows.map((r) => [r.location_id, r.earliest]));
  const queue = [];
  for (const loc of locations) {
    const first = earliest.get(loc.id);
    // A location with nothing synced yet starts from yesterday.
    const next = first ? addDays(first, -1) : addDays(todayIn(loc.timezone || 'America/New_York'), -1);
    if (next >= from) queue.push({ loc, next, lookups: null, done: 0 });
    log(`${loc.id}: earliest synced ${first ?? 'none'}; ${next >= from ? `backfilling from ${next} toward ${from}` : 'history complete'}`);
  }
  if (!queue.length) {
    log(`Backfill complete: every location has data back to ${from}`);
    return 0;
  }

  let failures = 0;
  while (queue.length && sink.rowsWritten < maxRows) {
    for (const item of [...queue]) {
      if (sink.rowsWritten >= maxRows) break;
      item.lookups ??= await toast.lookups(item.loc.toastGuid);
      try {
        await syncDay(item.loc, item.next, item.lookups);
        item.done++;
        item.next = addDays(item.next, -1);
      } catch (err) {
        // Stop this location for tonight so a bad day is retried tomorrow
        // instead of being skipped over (progress is read from sync_log).
        failures++;
        log(`  ${item.loc.id} ${item.next}: FAILED - ${err.message}; stopping this location until the next run`);
        queue.splice(queue.indexOf(item), 1);
        continue;
      }
      if (item.next < from) queue.splice(queue.indexOf(item), 1);
    }
  }
  for (const loc of locations) {
    const done = queue.find((q) => q.loc.id === loc.id);
    if (done) log(`${loc.id}: next run resumes at ${done.next}`);
  }
  log(queue.length ? `Stopped at the ${maxRows}-row budget; the next run continues` : `Backfill reached ${from}`);
  return failures;
}

function dateRange(tz) {
  if (args.start) {
    const start = args.start;
    const end = args.end || todayIn(tz);
    parseDate(start);
    parseDate(end);
    if (end < start) throw new Error('--end is before --start');
    return { start, end };
  }
  const days = Math.max(1, Number(args.days || 2));
  const end = todayIn(tz);
  return { start: addDays(end, -(days - 1)), end };
}

main().catch((err) => {
  log(err.stack || err.message);
  process.exit(1);
});
