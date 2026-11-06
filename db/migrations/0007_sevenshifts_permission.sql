-- Per-user permission for the 7shifts tab (schedule, log book, attachments).
-- Off by default; admins always have it.
ALTER TABLE users ADD COLUMN can_sevenshifts INTEGER NOT NULL DEFAULT 0;
