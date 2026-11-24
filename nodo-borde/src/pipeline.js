'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};


class VarFilter {
  constructor(pipeline, sensorId, name) {
    this.p = pipeline;
    this.sensorId = sensorId;
    this.name = name;
    this.meta = pipeline.cfg.variables[name] || {};
    this.pending = [];
    this.lastRaw = [];
    this.recent = [];
  }

  tolerance() {
    const m = this.meta;
    if (m.min != null && m.max != null) {
      return Math.max((m.max - m.min) * this.p.cfg.filter.tolFraction, 1e-9);
    }

    const r = this.recent;
    if (r.length >= 5) {
      const med = median(r);
      const mad = median(r.map((x) => Math.abs(x - med)));
      return Math.max(4 * 1.4826 * mad, 0.05 * Math.abs(med), 1e-6);
    }
    const last = r.length ? r[r.length - 1] : 0;
    return Math.max(Math.abs(last) * 0.1, 1);
  }

  push(value, ts, rid, frame) {
    const f = this.p.cfg.filter;
    const tol = this.tolerance();


    for (const c of [...this.pending]) {
      if (Math.abs(value - c.value) <= tol) {
        c.conf++;
        if (c.conf >= f.confirmMin) this._resolve(c, true);
      } else {
        c.sawOther = true;
      }
    }

    const past = this.lastRaw.filter((x) => Math.abs(x - value) <= tol).length;
    this.lastRaw.push(value);
    if (this.lastRaw.length > f.confirmMin) this.lastRaw.shift();

    const cand = { value, ts, rid, frame, conf: past, sawOther: false };
    this.pending.push(cand);
    if (cand.conf >= f.confirmMin) this._resolve(cand, true);

    this.expire(ts);
  }

  expire(now) {
    const w = this.p.cfg.filter.confirmWindowMs;
    for (const c of [...this.pending]) {
      if (now - c.ts > w) this._resolve(c, false);
    }
  }

  _resolve(c, ok) {
    this.pending.splice(this.pending.indexOf(c), 1);
    const base = { rid: c.rid, sensorId: this.sensorId, variable: this.name, value: c.value, ts: c.ts };
    if (ok) {
      this.recent.push(c.value);
      if (this.recent.length > 30) this.recent.shift();
      c.frame.accepted[this.name] = c.value;
      this.p.emit('accept', base);
    } else {
      this.p.emit('discard', { ...base, reason: c.sawOther ? 'pico' : 'sin_confirmar' });
    }
    c.frame.pending--;
    this.p._maybeFinish(c.frame);
  }
}

class Pipeline extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.filters = new Map();
    this.lastMsg = new Map();
    this.rid = 0;
  }

  _filter(sensorId, name) {
    const k = sensorId + '/' + name;
    let f = this.filters.get(k);
    if (!f) this.filters.set(k, (f = new VarFilter(this, sensorId, name)));
    return f;
  }



  ingest(sensorId, data, now = Date.now(), bytes = 0) {
    const f = this.cfg.filter;
    const reserved = new Set(f.reservedKeys);
    const discard = (extra) => this.emit('discard', { rid: 0, sensorId, ts: now, ...extra });

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return discard({ variable: null, value: null, reason: 'json_invalido', bytes });
    }


    const seq = data.n ?? data.seq ?? null;
    const entries = Object.entries(data).filter(([k]) => !reserved.has(k)).sort(([a], [b]) => (a < b ? -1 : 1));
    const fp = seq !== null ? 'n:' + seq : 'p:' + JSON.stringify(entries);
    const win = seq !== null ? f.dupSeqWindowMs : f.dupWindowMs;
    const last = this.lastMsg.get(sensorId);
    if (last && last.fp === fp && now - last.t <= win) {
      return discard({ variable: null, value: null, reason: 'duplicado', bytes });
    }
    this.lastMsg.set(sensorId, { fp, t: now });

    if (!entries.length) return discard({ variable: null, value: null, reason: 'sin_datos', bytes });

  
    const frame = {
      sensorId, ts: now, seq, accepted: {}, pending: 0, rawBytes: bytes, open: true,
      mid: `${sensorId}:${now}:${crypto.randomBytes(3).toString('hex')}`,
    };
    let counted = false;
    for (const [name, v] of entries) {
      const rid = ++this.rid;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        discard({ rid, variable: name, value: v, reason: 'no_numerico', bytes: counted ? 0 : bytes });
        counted = true;
        continue;
      }
      this.emit('raw', { rid, sensorId, variable: name, value: v, ts: now, bytes: counted ? 0 : bytes });
      counted = true;
      const meta = this.cfg.variables[name];
      if (meta && meta.min != null && (v < meta.min || v > meta.max)) {
        discard({ rid, variable: name, value: v, reason: 'fuera_de_rango', bytes: 0 });
        continue;
      }
      frame.pending++;
      this._filter(sensorId, name).push(v, now, rid, frame);
    }
    frame.open = false;
    this._maybeFinish(frame);
  }

  sweep(now = Date.now()) {
    for (const vf of this.filters.values()) vf.expire(now);
  }

  _maybeFinish(frame) {
    if (frame.open || frame.pending > 0 || frame.done) return;
    frame.done = true;
    const names = Object.keys(frame.accepted);
    if (!names.length) return;
    const body = { mid: frame.mid, id: frame.sensorId, ts: frame.ts };
    for (const k of names) body[k] = frame.accepted[k];
    this.emit('frame', {
      mid: frame.mid, sensorId: frame.sensorId, ts: frame.ts, values: frame.accepted,
      payload: JSON.stringify(body), rawBytes: frame.rawBytes,
    });
  }
}

module.exports = { Pipeline, VarFilter };
