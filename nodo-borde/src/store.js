'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        mid TEXT PRIMARY KEY,
        kind TEXT NOT NULL, -- 'lectura' | 'alarma'
        topic TEXT NOT NULL,
        sensor_id TEXT,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_try INTEGER NOT NULL DEFAULT 0,
        sent_ts INTEGER,
        ack_ts INTEGER,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_outbox_state ON outbox(state, created);
      CREATE TABLE IF NOT EXISTS alarms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        sensor_id TEXT NOT NULL,
        variable TEXT NOT NULL,
        level TEXT NOT NULL,
        label TEXT,
        value REAL,
        unit TEXT,
        message TEXT,
        cleared_ts INTEGER
      );
    `);
    const q = (sql) => this.db.prepare(sql);
    this.s = {
      insert: q(`INSERT OR IGNORE INTO outbox (mid,kind,topic,sensor_id,ts,payload,created) VALUES (@mid,@kind,@topic,@sensorId,@ts,@payload,@created)`),
      get: q(`SELECT * FROM outbox WHERE mid = ?`),
      pending: q(`SELECT * FROM outbox WHERE state = 'pending' ORDER BY created LIMIT ?`),
      awaitingAck: q(`SELECT * FROM outbox WHERE state = 'sent' AND sent_ts < ? ORDER BY created LIMIT ?`),
      tried: q(`UPDATE outbox SET attempts = attempts + 1, last_try = ? WHERE mid = ?`),
      sent: q(`UPDATE outbox SET state = 'sent', sent_ts = ? WHERE mid = ? AND state = 'pending'`),
      acked: q(`UPDATE outbox SET state = 'acked', ack_ts = ? WHERE mid = ? AND state != 'acked'`),
      counts: q(`SELECT state, COUNT(*) n FROM outbox GROUP BY state`),
      prune: q(`DELETE FROM outbox WHERE state != 'pending' AND created < ?`),
      addAlarm: q(`INSERT INTO alarms (ts,sensor_id,variable,level,label,value,unit,message) VALUES (@ts,@sensorId,@variable,@level,@label,@value,@unit,@message)`),
      clearAlarm: q(`UPDATE alarms SET cleared_ts = ? WHERE id = ?`),
      alarms: q(`SELECT * FROM alarms ORDER BY id DESC LIMIT ?`),
    };
  }

  addOutbox(m) {
    const r = this.s.insert.run({ ...m, created: Date.now() });
    return r.changes === 1;
  }
  get(mid) {
    return this.s.get.get(mid);
  }
  pendingRows(limit) {
    return this.s.pending.all(limit);
  }
  awaitingAckRows(olderThan, limit) {
    return this.s.awaitingAck.all(olderThan, limit);
  }
  markTry(mid, now) {
    this.s.tried.run(now, mid);
  }
  markSent(mid, now) {
    return this.s.sent.run(now, mid).changes === 1;
  }
  markAcked(mid, now) {
    return this.s.acked.run(now, mid).changes === 1;
  }
  counts() {
    const out = { pending: 0, sent: 0, acked: 0 };
    for (const r of this.s.counts.all()) out[r.state] = r.n;
    return out;
  }
  prune(olderThanMs) { return this.s.prune.run(Date.now() - olderThanMs).changes; }

  addAlarm(a) { return Number(this.s.addAlarm.run(a).lastInsertRowid); }
  clearAlarm(id, ts) {
    this.s.clearAlarm.run(ts, id);
  }
  recentAlarms(n = 50) {
    return this.s.alarms.all(n);
  }

  close() {
    try {
      this.db.close();

    } catch (_) { }
  }
}

module.exports = { Store };
