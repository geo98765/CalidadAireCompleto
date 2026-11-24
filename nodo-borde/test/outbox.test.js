'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mqtt = require('mqtt');
const { createApp } = require('../src/app');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

function startBroker(port) {
  const aedes = require('aedes')();
  const server = net.createServer(aedes.handle);
  return new Promise((res) => server.listen(port, () => res({
    port: server.address().port,
    stop: () => new Promise((r) => { server.close(); aedes.close(r); }),
    aedes,
  })));
}

function makeCfg(port, tmp, apiAck) {
  const cfg = structuredClone(require('../src/config'));
  cfg.mqtt.port = port;
  cfg.mqtt.host = '127.0.0.1';
  cfg.mqtt.clientId = 'nodo_test_' + Math.random().toString(16).slice(2, 6);
  cfg.outbox.dbPath = path.join(tmp, 'nodo.db');
  cfg.outbox.tickMs = 200;
  cfg.outbox.apiAck = apiAck;
  cfg.outbox.apiAckTimeoutMs = 1500;
  cfg.alarms.logFile = path.join(tmp, 'alarmas.log');
  cfg.alarms.bell = false;
  return cfg;
}

// Alimenta el pipeline con tiempo virtual: n lecturas estables de un sensor
function feed(app, id, n, t0, make) {
  let t = t0;
  for (let i = 0; i < n; i++) { app.pipeline.ingest(id, { id, ...make(i) }, t, 80); t += 2000; }
  app.pipeline.sweep(t + 30000);
  return t;
}

test('store & forward: lo generado sin broker se entrega al volver, sin duplicados, y la API confirma', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodo-'));
  let broker = await startBroker(0);
  const port = broker.port;

  // "Servicio de la API": recibe lo limpio, deduplica por mid y confirma
  const api = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'api_test' });
  const received = [];
  const seenMids = new Set();
  let dupMids = 0;
  api.on('connect', () => api.subscribe(['planta1/limpio/#', 'planta1/alarma/#'], { qos: 2 }));
  api.on('message', (topic, buf) => {
    const b = JSON.parse(buf.toString());
    if (seenMids.has(b.mid)) dupMids++; else seenMids.add(b.mid);
    received.push({ topic, ...b });
    api.publish('planta1/ack', JSON.stringify({ mid: b.mid }), { qos: 1 });
  });

  const app = createApp(makeCfg(port, tmp, true));
  await app.start();
  t.after(async () => { await app.stop(); api.end(true); await broker.stop(); });

  assert.ok(await waitFor(() => app.client.connected), 'el nodo debería conectar al broker');
  await sleep(500);

  // 1) con conexión: llega todo y la API confirma (estado acked)
  let tv = feed(app, 'S_CO2_01', 8, 1_700_000_000_000, (i) => ({ co2: 480 + (i % 3), temp: 23 + (i % 2) * 0.1 }));
  assert.ok(await waitFor(() => app.store.counts().acked >= 8), 'la API debería confirmar los 8 mensajes: ' + JSON.stringify(app.store.counts()));
  assert.strictEqual(app.store.counts().pending, 0);

  // 2) se cae la red: se sigue generando y todo queda en la cola SQLite
  await broker.stop();
  assert.ok(await waitFor(() => !app.client.connected, 8000), 'el nodo debería detectar la caída');
  tv = feed(app, 'S_CO2_01', 12, tv, (i) => ({ co2: 500 + (i % 3), temp: 24 + (i % 2) * 0.1 }));
  tv = feed(app, 'S_AIRE_06', 12, tv, (i) => ({ pm25: 6 + (i % 2), pm10: 12, co2: 490, temp: 23, humedad: 50 }));
  const enCola = app.store.counts().pending;
  assert.ok(enCola >= 20, `deberían estar en cola, hay ${enCola}`);
  const antes = received.length;

  // 3) vuelve la red (mismo puerto): se drena sola, en orden, sin duplicados
  broker = await startBroker(port);
  assert.ok(await waitFor(() => app.store.counts().pending === 0, 30000), 'la cola debería vaciarse: ' + JSON.stringify(app.store.counts()));
  assert.ok(await waitFor(() => app.store.counts().acked >= 8 + enCola, 15000), 'todo debería quedar confirmado por la API: ' + JSON.stringify(app.store.counts()));
  assert.ok(received.length - antes >= enCola, 'la API debería haber recibido lo acumulado');
  assert.strictEqual(dupMids, 0, 'no debe haber mids duplicados llegando a la API');

  // 4) lectura con variables distintas por sensor: cada mensaje trae solo sus variables
  const aire = received.find((m) => m.id === 'S_AIRE_06');
  assert.ok(aire && 'pm25' in aire && 'pm10' in aire && 'humedad' in aire);
  const co2 = received.find((m) => m.id === 'S_CO2_01');
  assert.ok(co2 && 'co2' in co2 && !('pm25' in co2));
});

test('alarma local: se registra aunque no haya broker y se envía al volver', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodo-'));
  // Puerto cerrado: no hay broker. El nodo debe alarmar igual.
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));

  const app = createApp(makeCfg(port, tmp, false));
  await app.start();
  t.after(() => app.stop());
  const alarmas = [];
  app.alarms.on('alarm', (a) => alarmas.push(a));

  // Un pico aislado de CO₂ NO debe disparar alarma; un nivel alto sostenido SÍ
  feed(app, 'S_CO2_01', 6, 1_700_000_000_000, () => ({ co2: 480 }));
  feed(app, 'S_CO2_04', 6, 1_700_000_100_000, (i) => ({ co2: i === 3 ? 4800 : 490 }));
  assert.strictEqual(alarmas.length, 0, 'un pico aislado no debe generar alarma');
  feed(app, 'S_CO2_01', 8, 1_700_000_200_000, () => ({ co2: 1900 }));

  assert.strictEqual(alarmas.length, 1, 'debe haber 1 alarma (no una por lectura)');
  assert.strictEqual(alarmas[0].level, 'peligro');
  assert.ok(fs.readFileSync(path.join(tmp, 'alarmas.log'), 'utf8').includes('ALARMA'), 'queda en el log local');
  assert.strictEqual(app.store.recentAlarms(5).length, 1, 'queda en SQLite');
  assert.ok(app.store.counts().pending >= 1, 'el aviso al broker queda en cola hasta que haya red');
});
