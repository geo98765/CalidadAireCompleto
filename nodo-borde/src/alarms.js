'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const RANK = { ok: 0, advertir: 1, peligro: 2, critico: 3 };
const ANSI = { peligro: '\x1b[31;1m', critico: '\x1b[35;1m', clear: '\x1b[32m', reset: '\x1b[0m' };

function classify(meta, value) {
  if (!meta || !meta.levels) {
    return null;
  }
  let lv = meta.levels[0];
  for (const l of meta.levels) if (value >= l.from) lv = l;
  return lv;
}

class AlarmEngine extends EventEmitter {
  constructor({ cfg, store, publisher }) {
    super();
    this.cfg = cfg;
    this.a = cfg.alarms;
    this.store = store;
    this.publisher = publisher;
    this.state = new Map();
    fs.mkdirSync(path.dirname(path.resolve(this.a.logFile)), { recursive: true });
  }

  active() {
    return [...this.state.entries()]
      .filter(([, s]) => s.rank >= RANK[this.a.minTone])
      .map(([k, s]) => ({ key: k, ...s.info }));
  }

  evaluate({ sensorId, variable, value, ts }) {
    const meta = this.cfg.variables[variable];
    const lv = classify(meta, value);
    if (!lv) {
      return;
    }
    const key = `${sensorId}/${variable}`;
    const prev = this.state.get(key) || { rank: 0, lv: null, info: null, hist: [] };
    const minRank = RANK[this.a.minTone];
    const need = Math.max(1, this.a.consecutive || 1);
    const rawRank = RANK[lv.tone];
    const hist = prev.hist.concat({ rank: rawRank, lv }).slice(-need);
    const alarmed = prev.rank >= minRank;

    let rank = rawRank;
    let eff = lv;
    if (alarmed && rank < prev.rank && value >= prev.lv.from * (1 - this.a.hysteresis)) {
      rank = prev.rank;
      eff = prev.lv;
    }

    if (alarmed && rank < minRank) {
      this._clear({ key, sensorId, variable, value, ts, prev });
      this.state.set(key, { rank: 0, lv: eff, info: null, hist });
      return;
    }


    let info = prev.info;
    let newRank = 0;
    let newLv = null;
    if (hist.length >= need && hist.every((h) => h.rank >= minRank)) {
      const min = hist.reduce((m, h) => (h.rank <= m.rank ? h : m));
      if (min.rank > (alarmed ? prev.rank : 0)) {
        newRank = min.rank;
        newLv = rawRank === min.rank ? lv : min.lv;
        if (prev.info?.id) this.store.clearAlarm(prev.info.id, ts);
        info = this._raise({ sensorId, variable, value, ts, lv: newLv, meta });
      }
    }

    if (newRank) {
      this.state.set(key, { rank: newRank, lv: newLv, info, hist });
    } else if (alarmed) {
      const baja = rank < prev.rank;
      this.state.set(key, { rank: baja ? rank : prev.rank, lv: baja ? eff : prev.lv, info, hist });
    } else {
      this.state.set(key, { rank: 0, lv, info: null, hist });
    }
  }

  _raise({ sensorId, variable, value, ts, lv, meta }) {
    const unit = meta.unit || '';
    const message = `${meta.label || variable} ${value}${unit ? ' ' + unit : ''} — ${lv.label}`;
    const rec = { ts, sensorId, variable, level: lv.tone, label: lv.label, value, unit, message };
    rec.id = this.store.addAlarm(rec);

    this._log({ evento: 'ALARMA', ...rec });

    const col = lv.tone === 'critico' ? ANSI.critico : ANSI.peligro;

    console.log(`${col}${this.a.bell ? '\x07' : ''}[ALARMA ${lv.tone.toUpperCase()}] ${sensorId}: ${message}${ANSI.reset}`);

    const mid = `alarma:${sensorId}:${variable}:${ts}:${crypto.randomBytes(2).toString('hex')}`;
    this.publisher.enqueue({
      mid, kind: 'alarma', sensorId, ts,
      topic: `${this.cfg.mqtt.topicAlarm}/${sensorId}`,
      payload: JSON.stringify({
        mid,
        tipo: 'alarma',
        estado: 'activa',
        id: sensorId,
        variable,
        valor: value,
        unidad: unit,
        nivel: lv.tone,
        detalle: lv.label,
        ts
      }),
    });
    this._webhook({
      tipo: 'alarma',
      estado: 'activa',
      id: sensorId,
      variable,
      valor: value,
      unidad: unit,
      nivel: lv.tone,
      detalle: lv.label,
      ts
    });

    this.emit('alarm', {
      ...rec, estado: 'activa'
    });
    return rec;
  }

  _clear({ sensorId, variable, value, ts, prev }) {
    const info = prev.info;
    if (info?.id) this.store.clearAlarm(info.id, ts);
    const dur = info ? Math.round((ts - info.ts) / 1000) : 0;
    this._log({ evento: 'RESUELTA', ts, sensorId, variable, value, duracion_s: dur });
    console.log(`${ANSI.clear}[ALARMA RESUELTA] ${sensorId}: ${variable} volvió a ${value} (duró ${dur} s)${ANSI.reset}`);
    const mid = `alarma:${sensorId}:${variable}:${ts}:clr`;
    this.publisher.enqueue({
      mid, kind: 'alarma', sensorId, ts, topic: `${this.cfg.mqtt.topicAlarm}/${sensorId}`,
      payload: JSON.stringify({ mid, tipo: 'alarma', estado: 'resuelta', id: sensorId, variable, valor: value, duracion_s: dur, ts }),
    });
    this.emit('alarm-clear', { id: info?.id, sensorId, variable, ts, value, duration_s: dur });
  }

  _log(obj) {
    try {
      fs.appendFileSync(this.a.logFile, JSON.stringify({ ...obj, hora: new Date(obj.ts).toISOString() }) + '\n');
    } catch (e) { console.error('No se pudo escribir el log de alarmas:', e.message); }
  }

  async _webhook(body) {
    const url = this.a.webhookUrl;
    if (!url) return;
    for (let i = 1; i <= this.a.webhookRetries; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
        });
        if (r.ok) return;
        throw new Error('HTTP ' + r.status);
      } catch (e) {
        this._log({ evento: 'WEBHOOK_ERROR', ts: Date.now(), intento: i, error: e.message });
        await new Promise((res) => setTimeout(res, 2000 * i));
      }
    }
  }
}

module.exports = { AlarmEngine, classify, RANK };
