-- Mogu Chinese dashboard schema (Cloudflare D1 / SQLite).
--
-- The ETL stores *daily aggregates* per location rather than raw checks.
-- That keeps the database tiny, keeps dashboard queries well inside the
-- D1 free tier, and means a re-sync of a day is a simple delete + insert.
-- All money columns are dollars (REAL). Dates are 'YYYY-MM-DD' business dates.

CREATE TABLE locations (
  id          TEXT PRIMARY KEY,          -- short code, e.g. 'DT'
  name        TEXT NOT NULL,
  toast_guid  TEXT UNIQUE,
  timezone    TEXT NOT NULL DEFAULT 'America/New_York',
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- One row per location per business date.
CREATE TABLE daily_sales (
  location_id     TEXT NOT NULL REFERENCES locations(id),
  business_date   TEXT NOT NULL,
  orders          INTEGER NOT NULL DEFAULT 0,
  checks          INTEGER NOT NULL DEFAULT 0,
  guests          INTEGER NOT NULL DEFAULT 0,
  gross_sales     REAL NOT NULL DEFAULT 0,  -- item sales before discounts
  discounts       REAL NOT NULL DEFAULT 0,  -- item + check level discounts/comps
  net_sales       REAL NOT NULL DEFAULT 0,  -- gross_sales - discounts
  voids           REAL NOT NULL DEFAULT 0,  -- value of voided items
  void_count      INTEGER NOT NULL DEFAULT 0,
  service_charges REAL NOT NULL DEFAULT 0,
  tax             REAL NOT NULL DEFAULT 0,
  tips            REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date)
);
CREATE INDEX idx_daily_sales_date ON daily_sales(business_date);

-- Hour of day (location local time, 0-23) the order was opened.
CREATE TABLE hourly_sales (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  hour          INTEGER NOT NULL,
  orders        INTEGER NOT NULL DEFAULT 0,
  guests        INTEGER NOT NULL DEFAULT 0,
  net_sales     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, hour)
);
CREATE INDEX idx_hourly_sales_date ON hourly_sales(business_date);

-- Sales mix: dimension is one of 'dining_option', 'revenue_center', 'sales_category'.
CREATE TABLE sales_mix (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  dimension     TEXT NOT NULL,
  label         TEXT NOT NULL,
  orders        INTEGER NOT NULL DEFAULT 0,
  quantity      REAL NOT NULL DEFAULT 0,
  gross_sales   REAL NOT NULL DEFAULT 0,
  discounts     REAL NOT NULL DEFAULT 0,
  net_sales     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, dimension, label)
);
CREATE INDEX idx_sales_mix_date ON sales_mix(business_date, dimension);

-- Menu item sales (check-level discounts prorated onto items).
CREATE TABLE item_sales (
  location_id    TEXT NOT NULL,
  business_date  TEXT NOT NULL,
  item_name      TEXT NOT NULL,
  sales_category TEXT NOT NULL DEFAULT '',
  quantity       REAL NOT NULL DEFAULT 0,
  gross_sales    REAL NOT NULL DEFAULT 0,
  net_sales      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, item_name, sales_category)
);
CREATE INDEX idx_item_sales_date ON item_sales(business_date);

-- Discounts & comps, by discount name and the employee who approved/applied it.
CREATE TABLE discount_sales (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  discount_name TEXT NOT NULL,
  approver      TEXT NOT NULL DEFAULT '',
  uses          INTEGER NOT NULL DEFAULT 0,
  amount        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, discount_name, approver)
);
CREATE INDEX idx_discount_sales_date ON discount_sales(business_date);

-- Labor from Toast time entries, by job. Salaried labor (configured per
-- location) is written as job_title 'Salaried'.
CREATE TABLE labor_daily (
  location_id    TEXT NOT NULL,
  business_date  TEXT NOT NULL,
  job_title      TEXT NOT NULL,
  employees      INTEGER NOT NULL DEFAULT 0,
  shifts         INTEGER NOT NULL DEFAULT 0,
  regular_hours  REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  regular_cost   REAL NOT NULL DEFAULT 0,
  overtime_cost  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, job_title)
);
CREATE INDEX idx_labor_daily_date ON labor_daily(business_date);

-- Record of every sync so the UI can show data freshness.
CREATE TABLE sync_log (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  synced_at     TEXT NOT NULL,
  orders        INTEGER NOT NULL DEFAULT 0,
  time_entries  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date)
);

-- ---------------------------------------------------------------------------
-- Access control. Cloudflare Access decides who can log in at all; these
-- tables decide what each signed-in person can see.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  email          TEXT PRIMARY KEY COLLATE NOCASE,
  name           TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  all_locations  INTEGER NOT NULL DEFAULT 0,  -- 1 = every location, including future ones
  can_sales      INTEGER NOT NULL DEFAULT 1,
  can_discounts  INTEGER NOT NULL DEFAULT 0,
  can_labor      INTEGER NOT NULL DEFAULT 0,
  can_items      INTEGER NOT NULL DEFAULT 1,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user_locations (
  email       TEXT NOT NULL COLLATE NOCASE REFERENCES users(email) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (email, location_id)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT ''
);
