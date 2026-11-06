// Test helper: just enough of the D1 binding, backed by a real in-memory
// SQLite database with every migration applied.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);

export function d1(db) {
  const run = (sql, args) => {
    const s = db.prepare(sql);
    if (/^\s*SELECT/i.test(sql)) return { results: s.all(...args) };
    s.run(...args);
    return { results: [] };
  };
  const stmt = (sql, args = []) => ({ sql, args, bind: (...a) => stmt(sql, a), all: async () => run(sql, args) });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => run(s.sql, s.args));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** A fresh in-memory database with the schema from db/migrations. */
export function migratedDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  return db;
}
