-- When each person last signed in: the time Cloudflare Access issued the login
-- token they opened the dashboard with. Shown in Admin. Kept apart from
-- `users` so admins who are only in BOOTSTRAP_ADMINS are covered too.
CREATE TABLE user_logins (
  email         TEXT PRIMARY KEY COLLATE NOCASE,
  last_login_at TEXT NOT NULL   -- ISO 8601, UTC
) WITHOUT ROWID;
