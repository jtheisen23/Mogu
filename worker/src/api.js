// Read-only data endpoints. Every query is scoped to the locations the
// signed-in user is allowed to see, and each section checks its permission.

import { HttpError, requireSection } from './auth.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 1100;

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function readPeriod(params, startKey, endKey, required) {
  const start = params.get(startKey);
  const end = params.get(endKey);
  if (!start && !end && !required) return null;
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) {
    throw new HttpError(400, `${startKey} and ${endKey} must be YYYY-MM-DD`);
  }
  if (end < start) throw new HttpError(400, `${endKey} is before ${startKey}`);
  if (daysBetween(start, end) > MAX_RANGE_DAYS) throw new HttpError(400, 'Date range is too long');
  return { start, end };
}

/** Parses ?start&end&cstart&cend&locations=DT,UT and intersects locations with the user's rights. */
export function readQuery(url, user) {
  const p = url.searchParams;
  const current = readPeriod(p, 'start', 'end', true);
  const compare = readPeriod(p, 'cstart', 'cend', false);
  const requested = (p.get('locations') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = new Set(user.locations);
  const locations = requested.length ? requested.filter((l) => allowed.has(l)) : [...allowed];
  if (!locations.length) throw new HttpError(403, 'You do not have access to any of the requested locations');
  return { current, compare, locations };
}

/** Runs one parameterized query for the current period and (optionally) the comparison period. */
async function bothPeriods(env, q, sql, extraBinds = []) {
  const inList = q.locations.map(() => '?').join(',');
  const text = sql.replaceAll('{LOCATIONS}', inList);
  const stmt = (period) => env.DB.prepare(text).bind(period.start, period.end, ...q.locations, ...extraBinds);
  const stmts = [stmt(q.current)];
  if (q.compare) stmts.push(stmt(q.compare));
  const res = await env.DB.batch(stmts);
  return { current: res[0].results, compare: q.compare ? res[1].results : null };
}

const RANGE = 'business_date BETWEEN ? AND ? AND location_id IN ({LOCATIONS})';

// Toast jobs left out of every labor figure (hours, cost, labor %, SPLH).
// Matched case-insensitively. The rows stay in D1, so removing a name here
// brings them back for all dates.
export const EXCLUDED_JOBS = ['register'];
const LABOR_RANGE = `${RANGE} AND LOWER(TRIM(job_title)) NOT IN (${EXCLUDED_JOBS.map((j) => `'${j}'`).join(', ')})`;

function stripDiscounts(rows) {
  return rows?.map(({ gross_sales, discounts, voids, void_count, ...rest }) => rest) ?? null;
}

export async function overview(env, url, user) {
  requireSection(user, 'sales');
  const q = readQuery(url, user);

  const [totals, daily] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT location_id, COUNT(*) AS days, SUM(orders) AS orders, SUM(checks) AS checks, SUM(guests) AS guests,
              SUM(gross_sales) AS gross_sales, SUM(discounts) AS discounts, SUM(net_sales) AS net_sales,
              SUM(voids) AS voids, SUM(void_count) AS void_count, SUM(tax) AS tax, SUM(tips) AS tips,
              SUM(service_charges) AS service_charges
         FROM daily_sales WHERE ${RANGE} GROUP BY location_id`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, orders, guests, gross_sales, discounts, net_sales, voids, void_count
         FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
  ]);

  let labor = null;
  let laborDaily = null;
  if (user.sections.labor) {
    [labor, laborDaily] = await Promise.all([
      bothPeriods(
        env,
        q,
        `SELECT location_id, SUM(regular_hours + overtime_hours) AS hours, SUM(overtime_hours) AS overtime_hours,
                SUM(regular_cost + overtime_cost) AS cost
           FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY location_id`,
      ),
      bothPeriods(
        env,
        q,
        `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
                SUM(regular_cost + overtime_cost) AS cost
           FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
      ),
    ]);
  }

  if (!user.sections.discounts) {
    for (const k of ['current', 'compare']) {
      totals[k] = stripDiscounts(totals[k]);
      daily[k] = stripDiscounts(daily[k]);
    }
  }
  return { query: q, totals, daily, labor, laborDaily };
}

export const MIX_DIMENSIONS = new Set(['dining_option', 'revenue_center', 'sales_category']);

export async function mix(env, url, user) {
  requireSection(user, 'sales');
  const q = readQuery(url, user);
  const dimension = url.searchParams.get('dimension') || 'hour';

  if (dimension === 'hour') {
    const r = await bothPeriods(
      env,
      q,
      `SELECT location_id, hour AS label, SUM(orders) AS orders, SUM(guests) AS guests, SUM(net_sales) AS net_sales
         FROM hourly_sales WHERE ${RANGE} GROUP BY location_id, hour ORDER BY hour`,
    );
    return { query: q, dimension, ...r };
  }
  if (dimension === 'weekday') {
    // 0 = Sunday. Days counted so the UI can show average per weekday.
    const r = await bothPeriods(
      env,
      q,
      `SELECT location_id, CAST(strftime('%w', business_date) AS INTEGER) AS label, COUNT(*) AS days,
              SUM(orders) AS orders, SUM(guests) AS guests, SUM(net_sales) AS net_sales
         FROM daily_sales WHERE ${RANGE} GROUP BY location_id, label ORDER BY label`,
    );
    return { query: q, dimension, ...r };
  }
  if (!MIX_DIMENSIONS.has(dimension)) throw new HttpError(400, 'Unknown dimension');
  // Labels an admin has grouped (Admin > Category groups) are merged here.
  const r = await bothPeriods(
    env,
    q,
    `SELECT location_id, COALESCE(g.group_name, m.label) AS label, m.label AS source_label, SUM(orders) AS orders,
            SUM(quantity) AS quantity, SUM(net_sales) AS net_sales
       FROM sales_mix m
       LEFT JOIN category_groups g ON g.dimension = m.dimension AND g.source_label = m.label
      WHERE ${RANGE} AND m.dimension = ?
      GROUP BY location_id, COALESCE(g.group_name, m.label), m.label ORDER BY net_sales DESC`,
    [dimension],
  );
  return { query: q, dimension, ...r };
}

// Discount names an admin has grouped (Admin > Category groups > Discounts) are merged here.
export async function discounts(env, url, user) {
  requireSection(user, 'discounts');
  const q = readQuery(url, user);
  const [byName, byLocation, byApprover, daily, approvals] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT COALESCE(g.group_name, d.discount_name) AS discount_name, d.discount_name AS source_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} GROUP BY COALESCE(g.group_name, d.discount_name), d.discount_name ORDER BY amount DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, COALESCE(g.group_name, d.discount_name) AS discount_name, d.discount_name AS source_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} GROUP BY location_id, COALESCE(g.group_name, d.discount_name), d.discount_name`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT approver, COALESCE(g.group_name, d.discount_name) AS discount_name, SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} AND approver <> '' GROUP BY approver, COALESCE(g.group_name, d.discount_name) ORDER BY amount DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, gross_sales, discounts, net_sales
         FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
    // Who approved each Toast discount, for the "Approved by" column.
    bothPeriods(
      env,
      { ...q, compare: null },
      `SELECT COALESCE(g.group_name, d.discount_name) AS discount_name, d.discount_name AS source_name, approver,
              SUM(uses) AS uses, SUM(amount) AS amount
         FROM discount_sales d LEFT JOIN category_groups g ON g.dimension = 'discount' AND g.source_label = d.discount_name
        WHERE ${RANGE} AND approver <> '' GROUP BY COALESCE(g.group_name, d.discount_name), d.discount_name, approver`,
    ),
  ]);
  return { query: q, byName, byLocation, byApprover, daily, approvals: approvals.current };
}

export async function labor(env, url, user) {
  requireSection(user, 'labor');
  const q = readQuery(url, user);
  const [byJob, byLocationJob, daily, sales] = await Promise.all([
    bothPeriods(
      env,
      q,
      `SELECT COALESCE(g.group_name, l.job_title) AS job_title, l.job_title AS source_name,
              SUM(regular_hours) AS regular_hours, SUM(overtime_hours) AS overtime_hours,
              SUM(regular_cost) AS regular_cost, SUM(overtime_cost) AS overtime_cost, SUM(shifts) AS shifts
         FROM labor_daily l LEFT JOIN category_groups g ON g.dimension = 'labor_job' AND g.source_label = l.job_title
        WHERE ${LABOR_RANGE} GROUP BY COALESCE(g.group_name, l.job_title), l.job_title ORDER BY SUM(regular_cost + overtime_cost) DESC`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT location_id, COALESCE(g.group_name, l.job_title) AS job_title, l.job_title AS source_name,
              SUM(regular_hours + overtime_hours) AS hours, SUM(overtime_hours) AS overtime_hours,
              SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily l LEFT JOIN category_groups g ON g.dimension = 'labor_job' AND g.source_label = l.job_title
        WHERE ${LABOR_RANGE} GROUP BY location_id, COALESCE(g.group_name, l.job_title), l.job_title`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, SUM(regular_hours + overtime_hours) AS hours,
              SUM(overtime_hours) AS overtime_hours, SUM(regular_cost + overtime_cost) AS cost
         FROM labor_daily WHERE ${LABOR_RANGE} GROUP BY business_date, location_id ORDER BY business_date`,
    ),
    bothPeriods(
      env,
      q,
      `SELECT business_date, location_id, net_sales, guests FROM daily_sales WHERE ${RANGE} ORDER BY business_date`,
    ),
  ]);
  // Labor % and SPLH need net sales; users with labor but not sales access
  // get hours and cost only.
  return { query: q, byJob, byLocationJob, daily, sales: user.sections.sales ? sales : null };
}

export async function items(env, url, user) {
  requireSection(user, 'items');
  const q = readQuery(url, user);
  const limit = Math.min(200, Math.max(5, Number(url.searchParams.get('limit')) || 50));
  const r = await bothPeriods(
    env,
    q,
    `SELECT item_name, COALESCE(g.group_name, i.sales_category) AS sales_category, SUM(quantity) AS quantity,
            SUM(gross_sales) AS gross_sales, SUM(net_sales) AS net_sales
       FROM item_sales i
       LEFT JOIN category_groups g ON g.dimension = 'sales_category' AND g.source_label = i.sales_category
      WHERE ${RANGE}
      GROUP BY item_name, COALESCE(g.group_name, i.sales_category) ORDER BY net_sales DESC LIMIT ?`,
    [limit],
  );
  return { query: q, limit, ...r };
}

const easternDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export async function locations(env, user) {
  if (!user.locations.length) return { locations: [] };
  // "Yesterday" in Eastern time, to report whether it was re-synced after the
  // day ended (a sync during service leaves the dinner rush missing).
  const today = easternDate.format(new Date());
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.timezone,
            (SELECT MAX(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS last_business_date,
            (SELECT MIN(business_date) FROM daily_sales d WHERE d.location_id = l.id) AS first_business_date,
            (SELECT MAX(synced_at) FROM sync_log s WHERE s.location_id = l.id) AS last_synced_at,
            (SELECT synced_at FROM sync_log s WHERE s.location_id = l.id AND s.business_date = ?) AS yesterday_synced_at
       FROM locations l
      WHERE l.id IN (${user.locations.map(() => '?').join(',')})
      ORDER BY l.sort_order, l.name`,
  )
    .bind(yesterday, ...user.locations)
    .all();
  for (const r of results) {
    r.yesterday = yesterday;
    // Complete once synced on a later Eastern date than the day itself.
    r.yesterday_complete = !!r.yesterday_synced_at && easternDate.format(new Date(r.yesterday_synced_at)) > yesterday;
  }
  return { locations: results };
}
