# Mogu Chinese Dashboard

A multi-location dashboard for Mogu Chinese. It shows sales, discounts & comps, labor and menu items,
lets you compare locations and time periods, and controls who can see what. Data comes from the
**Toast API**, logins go through **Cloudflare Access**, and everything runs on free tiers.

| Tab | What you get |
|---|---|
| **Overview** | KPIs (net sales, orders, avg check, guests, discounts, labor $, labor %, sales per labor hour), each with change vs. the comparison period. Trend chart by day/week/month (total vs. comparison, or one line per location), plus a location summary table |
| **Compare locations** | Full scorecard (net/day, avg check, per guest, discount %, voids, labor %, SPLH, OT), location-vs-location bars for any metric, average day by weekday, and average sales by hour |
| **Sales mix** | Sales category, dining option (dine in / take out / online / 3rd party) and revenue center, with share of sales by location and change vs. the comparison period |
| **Discounts & comps** | Totals, % of gross, top discounts vs. comparison, discount % by location and over time, a discount × location table, and **comps by approving manager** |
| **Labor** | Labor $, labor %, hours, OT, SPLH, labor $ per guest. Trend by location, and breakdowns by location and by job |
| **Menu items** | Top items with quantity, net sales, average price and change |
| **Admin** | Add users and choose which **locations** and **sections** (sales, discounts, labor, items) each one can see. Every change is written to an audit log |

The filters apply to every tab. **Date range** presets: today, yesterday, last 7/30/90/365 days,
week/month/quarter/year to date, last week/month/quarter/year, or a custom range. **Compare to**:
same period last year matched by weekday (the default: a Saturday is compared with a Saturday),
the same calendar dates last year, the previous period, or a custom range. You can also group by
day/week/month and pick locations (Alt/⌘-click shows only that location). The filters are saved
in the URL, so a bookmarked or shared link opens the same view. Every table can be sorted and
exported to CSV. Light and dark mode are both supported.

## Architecture (all free tier)

```
 Toast API ──(every 2h, GitHub Actions)──▶ etl/ (Node, no dependencies)
                                               │ daily aggregates
                                               ▼
 Browser ──▶ Cloudflare Access (login) ──▶ Cloudflare Worker ──▶ Cloudflare D1 (SQLite)
             email PIN / Google / MS        /api/* + permission      sales, mix, items,
                                            checks, static UI        discounts, labor, users
```

- **Cloudflare Access** (Zero Trust, free for up to 50 users) decides who can sign in.
- The **Worker** checks the Access JWT itself, then looks the email up in the `users` table to
  decide which locations and sections that person can see. These rules are enforced in the API,
  not only hidden in the UI. Someone who gets past Access but isn't in the table still gets a 403.
- **D1** stores *daily aggregates*, not raw checks. That keeps queries fast and well inside the
  free limits (5 GB storage, 5M rows read/day).
- The **ETL** runs in **GitHub Actions**, not in a Worker cron, because the Workers free plan
  only allows 10 ms of CPU per run. That isn't enough to process a day of Toast orders.
- The **UI** is plain HTML/JS with [Apache ECharts](https://echarts.apache.org) (Apache-2.0),
  served locally from `public/vendor`. There's no build step.

Why not Metabase, Grafana or Superset? They all need a server you run and pay for. Metabase's
per-location row permissions ("sandboxing") are also a paid feature. This stack costs $0 and
enforces per-location permissions itself.

## Try it locally with demo data

```bash
npm install
cp .dev.vars.example .dev.vars          # AUTH_MODE=dev signs you in as DEV_USER_EMAIL
npm run db:migrate:local
npm run demo:seed                       # ~2 years of fake data for 3 demo locations
npm run dev                             # http://localhost:8787
```

To test a restricted user, change `DEV_USER_EMAIL` in `.dev.vars` to `dt.manager@example.com`
(a demo viewer who can only see Downtown) and restart `npm run dev`.

The logo in the header (`public/logo.svg`) is a placeholder. Replace that file with the real logo,
or add a PNG and point the two `logo` references in `public/index.html` at it.

## Production setup

### 1. Toast API credentials
1. In Toast Web, go to **Integrations → Toast API access** and create a *Standard API access*
   credential with **read-only** scopes for orders, labor (including employees and jobs),
   configuration and restaurants. If your account doesn't show API access, ask your Toast rep to
   enable it.
2. Note the **client ID** and **client secret**, and each location's **restaurant GUID**.
3. Copy `config/locations.example.json` and fill in one entry per location. `id` is a short code
   such as `PL` that the dashboard uses in permissions. `salariedLaborPerDay` (optional) adds
   salaried managers' daily cost to labor, because Toast time entries only cover hourly staff.

### 2. Cloudflare database and Worker
```bash
npx wrangler login
npx wrangler d1 create mogu             # copy the database_id into wrangler.toml
npm run db:migrate:remote
```
Run `npm run deploy`, or connect the repo under *Workers & Pages → Create → Import a repository*
(deploy command `npx wrangler deploy`) so every push to `main` deploys. In the Worker's
**Settings → Build → Branch control**, turn **off** builds for preview (non-production)
branches: they fail, and preview URLs can't sign in through Access anyway. Only `main` deploys. Then, in the Worker's
**Settings → Variables and Secrets**, add a **secret** `BOOTSTRAP_ADMINS` with your email, so you
can't lock yourself out. `keep_vars = true` in `wrangler.toml` stops deploys from erasing it.
The `Database migrations` GitHub workflow creates or updates the tables using the secrets from step 4. Wrangler prints the dashboard URL (`https://mogu-dashboard.<you>.workers.dev`).
You can add a custom domain later under the Worker's **Settings → Domains & Routes**.

### 3. Cloudflare Access (logins)
1. In the Cloudflare dashboard, open **Zero Trust**. Pick a team name (for example `mogu`),
   which gives you `mogu.cloudflareaccess.com`, and choose the Free plan.
2. Under **Settings → Authentication**, add login methods. *One-time PIN* (a code sent by
   email) works for everyone; Google or Microsoft are optional.
3. Under **Access → Applications → Add an application → Self-hosted**, enter the dashboard's
   hostname. Add an **Allow** policy that lists the emails (or email domain) allowed to sign in.
   You can also turn on Access from the Worker's **Settings → Domains & Routes** page.
4. Copy the application's **Audience (AUD) tag**. In `wrangler.toml`, set `ACCESS_AUD` to that tag
   and `ACCESS_TEAM_DOMAIN = "mogu.cloudflareaccess.com"`, then run `npm run deploy` again.

Until both values are set (the `REPLACE_…` placeholders count as unset), the API refuses every
request (it fails closed).

### 4. Scheduled sync (GitHub Actions)
Under **Settings → Secrets and variables → Actions**, add these repository secrets:

| Secret | Value |
|---|---|
| `TOAST_CLIENT_ID` / `TOAST_CLIENT_SECRET` | From step 1 |
| `LOCATIONS_JSON` | The contents of your filled-in locations JSON |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages (right sidebar) |
| `CLOUDFLARE_API_TOKEN` | My Profile → API Tokens → Create token → Custom, permission **Account · D1 · Edit** |
| `D1_DATABASE_ID` | The `database_id` from step 2 |

Optional repository variables: `TOAST_API_HOST` (defaults to `https://ws-api.toasttab.com`)
and `OVERTIME_MULTIPLIER` (defaults to `1.5`).

**Test Toast first:** once the `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET` and `LOCATIONS_JSON`
secrets are set, run *Actions → Toast connection check*. It signs in and reads one day for each
location, then reports net sales, labor and any missing Toast permissions in the run summary. It
writes nothing and doesn't need the Cloudflare secrets.

`.github/workflows/toast-sync.yml` refreshes today hourly, started by the Worker's cron trigger (see *Reliable scheduling* below). Each morning it
also re-syncs the last 7 days, so late edits and tip adjustments are picked up. **History** is
loaded by `.github/workflows/toast-backfill.yml`. Every night it works backwards from the
earliest loaded day toward its `from` date (default 2025-01-01), and stops after 60,000 D1 rows
written so it stays under the free plan's 100k/day. Once history is complete it does nothing. To
go further back, run *Actions → Toast history backfill → Run workflow* with an earlier date. For a
one-off date range, use *Toast sync → Run workflow* with a start and end date. Tick
*revenue_centers_only* to rewrite only the revenue center numbers for that range: a few dozen D1
rows per location-day instead of several hundred, for re-pulling history after a change to how
revenue centers are assigned.

You can also run the sync by hand: `node etl/src/index.js --start 2025-01-01 --end 2025-06-30`
with the same environment variables set. Add `--out file.sql` to write SQL to a file instead of
sending it to D1.

**Reliable scheduling:** GitHub's free scheduler often skips runs, so the Worker's cron triggers
(`[triggers]` in `wrangler.toml`) start the sync instead: hourly at :17, plus 8:40 UTC (4:40am
Eastern, 3:40am in winter) for the 7-day recheck. Hourly runs between midnight and 6am Eastern
also finish the previous day. They need a Worker **secret** `GITHUB_DISPATCH_TOKEN`: a fine-grained GitHub
token limited to this repository with **Actions: Read and write** permission. GitHub's own
schedule keeps only the 8:40 UTC 7-day re-sync as a backup.

> GitHub pauses scheduled workflows after 60 days with no activity in the repo. If that happens,
> re-enable the workflow from the Actions tab.

### 5. Give people access
Sign in as a bootstrap admin, open **Admin → Add user**, and enter the email the person will
sign in with. Then choose:
- **Role**: *Admin* sees everything and can manage users. *Viewer* sees only what's ticked.
- **Locations**: specific locations, or *All locations*, which also covers locations you add later.
- **Sections**: Sales, Discounts & comps, Labor, Menu items. A viewer without Labor never gets
  labor data from the API, and one without Discounts gets sales numbers with gross/discount/void
  fields removed.

**Category groups** (Admin tab): combine Toast sales categories, dining options, revenue
centers or discount names into reporting groups, e.g. "Draft", "Draft Beer" and "HH Draft" → "Beer". Groups are
applied when the dashboard reads data, so they cover all history immediately and never change the
stored Toast data.

People also have to be allowed by the Access policy (step 3.3) to reach the sign-in page.

## How numbers are calculated

| Metric | Definition |
|---|---|
| Gross sales | Pre-discount price of every non-voided item. Gift card sales/reloads and house-account payments are excluded, as in Toast |
| Discounts | Item-level plus check-level discounts and comps |
| Net sales | Gross sales − discounts. Tax, tips and service charges are tracked separately |
| Voids | Value of voided items, checks and orders |
| Avg check | Net sales ÷ orders |
| Labor $ | Regular hours × wage + OT hours × wage × 1.5, from Toast time entries, plus any configured salaried cost per day |
| Labor % | Labor $ ÷ net sales |
| SPLH | Net sales ÷ labor hours |
| Hour of day | Hour the order was opened, in the location's time zone |
| Revenue center | The order's revenue center in Toast. Orders Toast saved without one (for example DoorDash orders sent in before the integration had a revenue center) go to the revenue center whose name starts their dining option's name ("DoorDash - Delivery" → DoorDash); the rest show as Unspecified |
| Item sales | Check-level discounts are spread across the items on each check, so item totals add up to net sales |

When you first connect Toast, compare one day per location against Toast's **Sales Summary**
report. If your Toast setup counts something differently (for example, service charges inside
net sales), adjust `etl/src/transform.js`.

## Project layout

```
db/migrations/     D1 schema (aggregates + users/permissions + audit log)
etl/src/           Toast client, transforms, SQL builder, sync CLI, demo-data generator
worker/src/        Cloudflare Worker: Access JWT check, permissions, JSON API, admin API
public/            Dashboard UI (HTML/CSS/JS + vendored ECharts)
.github/workflows  Scheduled Toast sync, CI tests
```

`npm test` runs unit tests for the Toast transforms, SQL escaping and Access JWT verification.
