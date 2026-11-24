'use strict';

const { EventEmitter } = require('events');

class Publisher extends EventEmitter {
  constructor({ client, store, cfg }) {
    super();
    this.client = client;
    this.store = store;
    this.cfg = cfg.outbox;
    this.inflight = new Map();   
    this.timer = null;
    this.backlog = false;
  }

  start() {
    this.timer = setInterval(() => this.pump(), this.cfg.tickMs);
    this.pruneTimer = setInterval(() => {
      const n = this.store.prune(this.cfg.retentionHours * 3600e3);
      if (n) this.emit('pruned', n);
    }, 3600e3);
    this.timer.unref?.();
    this.pruneTimer.unref?.();
  }
  stop() { clearInterval(this.timer); clearInterval(this.pruneTimer); }

  enqueue(msg) {
    const isNew = this.store.addOutbox(msg);
    if (!isNew) return false;
    this.emit('queued', msg);
    this._trySend(this.store.get(msg.mid));
    return true;
  }

  _backoff(attempts) {
    return Math.min(this.cfg.maxBackoffMs, 1000 * 2 ** Math.max(0, attempts - 1));
  }

  _trySend(row) {
    if (!row || !this.client.connected) return false;
    if (this.inflight.has(row.mid)) return false;
    if (this.inflight.size >= this.cfg.maxInflight) { this.backlog = true; return false; }

    this.inflight.set(row.mid, Date.now());
    this.store.markTry(row.mid, Date.now());
    this.client.publish(row.topic, row.payload, { qos: 2, retain: false }, (err) => {
      this.inflight.delete(row.mid);
      if (err) {                      
        this.emit('send-error', { mid: row.mid, error: err.message });
        return;
      }
      if (this.store.markSent(row.mid, Date.now())) {
        this.emit('delivery', { mid: row.mid, kind: row.kind, state: 'sent' });
      }
      if (this.backlog) this.pump(); 
    });
    return true;
  }

  pump() {
    const now = Date.now();
    for (const [mid, t] of this.inflight) {
      if (now - t > this.cfg.inflightTimeoutMs) this.inflight.delete(mid); 
    }
    if (!this.client.connected) return;
    this.backlog = false;

    for (const row of this.store.pendingRows(this.cfg.batch)) {
      if (row.attempts > 0 && now - row.last_try < this._backoff(row.attempts)) continue;
      if (!this._trySend(row) && this.inflight.size >= this.cfg.maxInflight) return;
    }
    if (this.cfg.apiAck) {
      const cutoff = now - this.cfg.apiAckTimeoutMs;
      for (const row of this.store.awaitingAckRows(cutoff, 20)) {
        if (now - row.last_try < Math.max(this.cfg.apiAckTimeoutMs, this._backoff(row.attempts))) continue;
        this._trySend(row);
      }
    }
  }


  onAck(mid) {
    if (this.store.markAcked(mid, Date.now())) {
      this.emit('delivery', { mid, state: 'acked' });
    }
  }
}

module.exports = { Publisher };
