-- Cut D1 write volume by about two-thirds.
--
-- Each fact row used to be written three times: the rowid table, the
-- automatic primary-key index, and a business_date index. WITHOUT ROWID
-- stores rows directly in the primary-key b-tree, and the date indexes are
-- redundant because every query filters location_id IN (...) plus a
-- business_date range, which the (location_id, business_date, ...) primary
-- key already serves. Rows are copied over unchanged.

CREATE TABLE daily_sales_new (
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
) WITHOUT ROWID;
INSERT INTO daily_sales_new SELECT * FROM daily_sales;
DROP TABLE daily_sales;
ALTER TABLE daily_sales_new RENAME TO daily_sales;

CREATE TABLE hourly_sales_new (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  hour          INTEGER NOT NULL,
  orders        INTEGER NOT NULL DEFAULT 0,
  guests        INTEGER NOT NULL DEFAULT 0,
  net_sales     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, hour)
) WITHOUT ROWID;
INSERT INTO hourly_sales_new SELECT * FROM hourly_sales;
DROP TABLE hourly_sales;
ALTER TABLE hourly_sales_new RENAME TO hourly_sales;

CREATE TABLE sales_mix_new (
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
) WITHOUT ROWID;
INSERT INTO sales_mix_new SELECT * FROM sales_mix;
DROP TABLE sales_mix;
ALTER TABLE sales_mix_new RENAME TO sales_mix;

CREATE TABLE item_sales_new (
  location_id    TEXT NOT NULL,
  business_date  TEXT NOT NULL,
  item_name      TEXT NOT NULL,
  sales_category TEXT NOT NULL DEFAULT '',
  quantity       REAL NOT NULL DEFAULT 0,
  gross_sales    REAL NOT NULL DEFAULT 0,
  net_sales      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, item_name, sales_category)
) WITHOUT ROWID;
INSERT INTO item_sales_new SELECT * FROM item_sales;
DROP TABLE item_sales;
ALTER TABLE item_sales_new RENAME TO item_sales;

CREATE TABLE discount_sales_new (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  discount_name TEXT NOT NULL,
  approver      TEXT NOT NULL DEFAULT '',
  uses          INTEGER NOT NULL DEFAULT 0,
  amount        REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, discount_name, approver)
) WITHOUT ROWID;
INSERT INTO discount_sales_new SELECT * FROM discount_sales;
DROP TABLE discount_sales;
ALTER TABLE discount_sales_new RENAME TO discount_sales;

CREATE TABLE labor_daily_new (
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
) WITHOUT ROWID;
INSERT INTO labor_daily_new SELECT * FROM labor_daily;
DROP TABLE labor_daily;
ALTER TABLE labor_daily_new RENAME TO labor_daily;
