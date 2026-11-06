-- Scheduled labor from 7shifts, per location, business date and role.
-- Compared with actual labor from Toast (labor_daily) on the admin-only
-- 7shifts tab. Open (unassigned) shifts are kept apart from hours and cost.
CREATE TABLE scheduled_labor (
  location_id   TEXT NOT NULL,
  business_date TEXT NOT NULL,
  role          TEXT NOT NULL,
  shifts        INTEGER NOT NULL DEFAULT 0,
  employees     INTEGER NOT NULL DEFAULT 0,
  hours         REAL NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0,
  open_shifts   INTEGER NOT NULL DEFAULT 0,
  open_hours    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_date, role)
) WITHOUT ROWID;

-- Last successful 7shifts sync per location.
CREATE TABLE schedule_sync (
  location_id TEXT PRIMARY KEY,
  synced_at   TEXT NOT NULL,
  first_date  TEXT NOT NULL,
  last_date   TEXT NOT NULL
) WITHOUT ROWID;
