'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { AlarmEngine } = require('../src/alarms');

function motor(consecutive) {
  const cfg = structuredClone(require('../src/config'));
  cfg.alarms.logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alm-')), 'a.log');
  cfg.alarms.bell = false;
  cfg.alarms.consecutive = consecutive;
  const store = { n: 0, addAlarm() { return ++this.n; }, clearAlarm() {} };
  const publisher = { enqueue() {} };
  const e = new AlarmEngine({ cfg, store, publisher });
  const ev = [];
  e.on('alarm', (a) => ev.push('activa:' + a.level));
  e.on('alarm-clear', () => ev.push('resuelta'));
  let t = 0;
  const lee = (...vals) => vals.forEach((v) => e.evaluate({ sensorId: 'S1', variable: 'co2', value: v, ts: (t += 2000) }));
  const log = console.log; console.log = () => {};          // silencia las líneas de alarma durante la prueba
  return { lee, ev, restore: () => { console.log = log; } };
}

test('no salta con menos lecturas seguidas de las exigidas', () => {
  const m = motor(3);
  m.lee(480, 1900, 1900, 480, 1900, 1900, 500);              // nunca 3 seguidas en alarma
  m.restore();
  assert.deepStrictEqual(m.ev, []);
});

test('salta a la 3.ª lectura seguida, una sola vez, y se resuelve al bajar', () => {
  const m = motor(3);
  m.lee(480, 1900, 1900);
  assert.deepStrictEqual(m.ev, [], 'con 2 todavía no');
  m.lee(1900, 1950, 2000);
  assert.deepStrictEqual(m.ev, ['activa:peligro'], 'con 3 salta, y no se repite');
  m.lee(600);
  m.restore();
  assert.deepStrictEqual(m.ev, ['activa:peligro', 'resuelta']);
});

test('escalar a critico también exige lecturas seguidas', () => {
  const m = motor(3);
  m.lee(1900, 1900, 1900, 5000, 5000);
  assert.deepStrictEqual(m.ev, ['activa:peligro'], '2 lecturas críticas no bastan');
  m.lee(5000);
  m.restore();
  assert.deepStrictEqual(m.ev, ['activa:peligro', 'activa:critico']);
});

test('con consecutive = 1 avisa a la primera (comportamiento anterior)', () => {
  const m = motor(1);
  m.lee(1900);
  m.restore();
  assert.deepStrictEqual(m.ev, ['activa:peligro']);
});
