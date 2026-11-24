import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultDbPath = fileURLToPath(new URL('../data/modbus-scan.db', import.meta.url));

export function createStore(file = defaultDbPath) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      context_json TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      selected_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_results (
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      function_code INTEGER NOT NULL,
      address INTEGER NOT NULL,
      status TEXT NOT NULL,
      value INTEGER,
      count INTEGER,
      time INTEGER,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS scan_results_scan ON scan_results(scan_id);
    CREATE TABLE IF NOT EXISTS live_samples (
      id INTEGER PRIMARY KEY,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      function_code INTEGER NOT NULL,
      address INTEGER NOT NULL,
      value INTEGER,
      status TEXT NOT NULL,
      time INTEGER NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS live_samples_scan ON live_samples(scan_id, id);
  `);
  const insertScan = db.prepare('INSERT INTO scans (context_json, summary_json, selected_json) VALUES (?, ?, ?)');
  const insertResult = db.prepare('INSERT INTO scan_results (scan_id, function_code, address, status, value, count, time, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertLive = db.prepare('INSERT INTO live_samples (scan_id, function_code, address, value, status, time, message) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const latest = db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1');
  const results = db.prepare('SELECT function_code, address, status, value, count, time, message FROM scan_results WHERE scan_id = ? ORDER BY rowid');
  const live = db.prepare('SELECT function_code, address, value, status, time, message FROM live_samples WHERE scan_id = ? ORDER BY id');
  const updateSelection = db.prepare('UPDATE scans SET selected_json = ? WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM scans WHERE id = ?');

  return {
    saveScan({ context, summary, rows, failures, selected }) {
      db.exec('BEGIN');
      try {
        const id = Number(insertScan.run(JSON.stringify(context), JSON.stringify(summary), JSON.stringify(selected)).lastInsertRowid);
        for (const row of [...rows, ...failures]) insertResult.run(id, row.functionCode, row.address, row.status, row.value ?? null, row.count ?? null, row.time ?? null, row.message ?? null);
        db.exec('COMMIT');
        return id;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    latestScan() {
      const scan = latest.get();
      if (!scan) return null;
      const rows = [];
      const failures = [];
      for (const result of results.all(scan.id)) {
        const row = { status: result.status, functionCode: result.function_code, address: result.address };
        if (result.value !== null) row.value = result.value;
        if (result.count !== null) row.count = result.count;
        if (result.time !== null) row.time = result.time;
        if (result.message !== null) row.message = result.message;
        (result.status === 'ok' ? rows : failures).push(row);
      }
      return { id: scan.id, createdAt: scan.created_at, context: JSON.parse(scan.context_json), summary: JSON.parse(scan.summary_json), selected: JSON.parse(scan.selected_json), rows, failures };
    },
    setSelection(id, selected) { return updateSelection.run(JSON.stringify(selected), id).changes > 0; },
    hasScan(id) { return !!exists.get(id); },
    saveLive(id, row) { insertLive.run(id, row.functionCode, row.address, row.value ?? null, row.status, row.time, row.message ?? null); },
    getLive(id) { return live.all(id).map(row => ({ functionCode: row.function_code, address: row.address, value: row.value, status: row.status, time: row.time, message: row.message })); },
    close() { db.close(); }
  };
}
