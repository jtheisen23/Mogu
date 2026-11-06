-- Attachment names and 7shifts file paths for each log book post, as JSON
-- [{name, path}]. Files are fetched through the Worker, which adds the
-- 7shifts token; paths alone don't open them.
ALTER TABLE log_book_posts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
