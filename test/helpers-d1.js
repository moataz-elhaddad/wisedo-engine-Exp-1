// A small D1 stand-in over node:sqlite, enough to run the Worker's handlers in tests (prepare/bind/all/first/run,
// batch as one transaction). Not used in production.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  let queries = 0;
  const stmt = (sql, params = []) => ({
    sql,
    params,
    bind: (...p) => stmt(sql, p),
    async all() { queries++; return { results: db.prepare(sql).all(...params), success: true }; },
    async first(col) { queries++; const r = db.prepare(sql).get(...params); return r ? (col ? r[col] : r) : null; },
    async run() { queries++; const r = db.prepare(sql).run(...params); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => {
          queries++;
          if (/^\s*select/i.test(s.sql)) return { results: db.prepare(s.sql).all(...s.params), meta: { changes: 0 } };
          const r = db.prepare(s.sql).run(...s.params);
          return { results: [], meta: { changes: Number(r.changes) } };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    get queries() { return queries; },
    resetCount() { queries = 0; },
  };
}
