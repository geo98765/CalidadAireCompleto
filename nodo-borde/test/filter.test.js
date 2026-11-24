'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Pipeline } = require('../src/pipeline');
const { Sim } = require('../tools/esp32-sim');
const cfg = require('../src/config');

function run({ seed, minutes = 30, everyMs = 2000 }) {
  const p = new Pipeline(cfg);
  const sim = new Sim(seed);
  const truth = new Map();               // rid -> es pico?
  const res = { spikes: 0, spikesDropped: 0, spikesLeaked: 0, normal: 0, normalDropped: 0, frames: 0, reasons: {} };
  let t0 = 1_700_000_000_000, rid = 0;

  p.on('raw', (e) => { /* el rid se asigna en orden; se guarda abajo */ });
  p.on('accept', (e) => { if (truth.get(e.rid)) res.spikesLeaked++; });
  p.on('discard', (e) => {
    res.reasons[e.reason] = (res.reasons[e.reason] || 0) + 1;
    if (truth.get(e.rid)) res.spikesDropped++; else if (e.rid) res.normalDropped++;
  });
  p.on('frame', () => res.frames++);

  const ticks = (minutes * 60_000) / everyMs;
  for (let i = 0; i < ticks; i++) {
    const now = t0 + i * everyMs;
    for (const m of sim.tick()) {
      // los rid se asignan en el mismo orden que las claves (ordenadas alfabéticamente, sin 'id')
      const keys = Object.keys(m.payload).filter((k) => k !== 'id').sort();
      for (const k of keys) { truth.set(p.rid + 1 + keys.indexOf(k), m.truth[k]); }
      for (const k of keys) { if (m.truth[k]) res.spikes++; else res.normal++; }
      p.ingest(m.payload.id, m.payload, now + Math.floor(Math.random() * 40), 90);
    }
    p.sweep(now);
  }
  p.sweep(t0 + ticks * everyMs + 60_000);      // cierra lo pendiente
  return res;
}

test('el filtro descarta los picos y conserva las lecturas reales', () => {
  let tot = { spikes: 0, spikesDropped: 0, spikesLeaked: 0, normal: 0, normalDropped: 0 };
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = run({ seed });
    for (const k of Object.keys(tot)) tot[k] += r[k];
  }
  const recall = tot.spikesDropped / tot.spikes;
  const fp = tot.normalDropped / tot.normal;
  console.log(`  picos: ${tot.spikes}, descartados: ${tot.spikesDropped} (${(recall * 100).toFixed(1)} %), colados: ${tot.spikesLeaked}`);
  console.log(`  lecturas reales: ${tot.normal}, descartadas por error: ${tot.normalDropped} (${(fp * 100).toFixed(2)} %)`);
  assert.ok(recall >= 0.97, `recall ${recall}`);
  assert.ok(fp <= 0.002, `falsos positivos ${fp}`);
});

test('variables desconocidas: se leen igual y un salto aislado se descarta', () => {
  const p = new Pipeline(cfg);
  const acc = [], dis = [];
  p.on('accept', (e) => acc.push(e)); p.on('discard', (e) => dis.push(e));
  let t = 1_000_000;
  const vals = [10, 10.2, 9.9, 10.1, 10, 10.3, 500, 10.1, 10.2, 10, 10.1];
  for (const v of vals) { p.ingest('X_1', { id: 'X_1', no2: v, ruido: 3 }, t); t += 2000; p.sweep(t); }
  p.sweep(t + 20000);
  assert.ok(dis.some((d) => d.variable === 'no2' && d.value === 500 && d.reason === 'pico'));
  assert.ok(acc.some((a) => a.variable === 'ruido'));
  assert.ok(!acc.some((a) => a.value === 500));
});

test('un cambio real y sostenido SÍ se acepta', () => {
  const p = new Pipeline(cfg);
  const acc = [];
  p.on('accept', (e) => acc.push(e.value));
  let t = 0;
  for (const v of [480, 490, 485, 900, 1300, 1500, 1580, 1600, 1590, 1610]) { p.ingest('S', { id: 'S', co2: v }, t); t += 2000; p.sweep(t); }
  p.sweep(t + 20000);
  assert.ok(acc.includes(1600) && acc.includes(1300), acc.join(','));
});

test('duplicados, fuera de rango y no numéricos', () => {
  const p = new Pipeline(cfg);
  const dis = [];
  p.on('discard', (e) => dis.push(e.reason));
  p.ingest('S', { id: 'S', co2: 500 }, 1000);
  p.ingest('S', { id: 'S', co2: 500 }, 1200);               // mismo mensaje 200 ms después
  p.ingest('S', { id: 'S', co2: -999, temp: 'ERR' }, 3000);
  p.ingest('S', null, 4000);
  p.ingest('S', {}, 5000);
  assert.deepStrictEqual(dis.sort(), ['duplicado', 'fuera_de_rango', 'json_invalido', 'no_numerico', 'sin_datos']);
});

test('cada mensaje limpio trae TODAS las variables validadas del sensor (no se parte)', () => {
  const p = new Pipeline(cfg);
  const frames = [];
  p.on('frame', (f) => frames.push(f));
  let t = 0;
  for (let i = 0; i < 8; i++) {
    p.ingest('S_AIRE_06', { id: 'S_AIRE_06', pm25: 6 + (i % 2), pm10: 12, co2: 490, temp: 23, humedad: 50 }, t, 80);
    t += 2000;
  }
  p.sweep(t + 30000);
  assert.strictEqual(frames.length, 8, 'un mensaje limpio por mensaje crudo');
  for (const f of frames) assert.deepStrictEqual(Object.keys(f.values).sort(), ['co2', 'humedad', 'pm10', 'pm25', 'temp']);
});

test('si una variable es un pico, el mensaje sale igual con las demás', () => {
  const p = new Pipeline(cfg);
  const frames = [];
  p.on('frame', (f) => frames.push(f));
  let t = 0;
  for (let i = 0; i < 8; i++) {
    p.ingest('S_ENV_03', { id: 'S_ENV_03', temp: 23, humedad: i === 4 ? 95 : 50, presion: 1010 }, t, 60);
    t += 2000;
  }
  p.sweep(t + 30000);
  assert.strictEqual(frames.length, 8);
  const conPico = frames.find((f) => f.ts === 8000);       // el mensaje del pico sale más tarde (espera a que cierre la ventana)
  assert.deepStrictEqual(Object.keys(conPico.values).sort(), ['presion', 'temp']);
});
