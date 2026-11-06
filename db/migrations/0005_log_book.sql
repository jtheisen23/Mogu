-- 7shifts log book entries, one row per post (a category's note for a day).
-- Shown on the 7shifts tab, for each user's assigned locations.
CREATE TABLE log_book_posts (
  id               INTEGER PRIMARY KEY,
  location_id      TEXT NOT NULL,
  business_date    TEXT NOT NULL,
  category         TEXT NOT NULL,
  author           TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  comments         TEXT NOT NULL DEFAULT '[]',   -- JSON [{author, message, created}]
  attachment_count INTEGER NOT NULL DEFAULT 0,
  created          TEXT
);
CREATE INDEX idx_log_book_date ON log_book_posts(business_date, location_id);
