'use strict';
const mqtt = require('mqtt');
const host = process.env.MQTT_HOST || '127.0.0.1';
const port = Number(process.env.MQTT_PORT || 1883);
const API_URL = process.env.API_URL || '';
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);

const c = mqtt.connect(`mqtt://${host}:${port}`, { clientId: 'puente_api_' + Math.random().toString(16).slice(2, 6) });
const seen = new Set();
let stats = { recibidos: 0, aApi: 0, duplicados: 0, fallos: 0 };

async function enviarAApi(body) {
  if (API_URL) {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } else if (Math.random() < FAIL_RATE) {
    throw new Error('API simulada caída');
  }
}

c.on('connect', () => {
  console.log(`Puente conectado a ${host}:${port} · API: ${API_URL || 'simulada'} · fallos simulados: ${FAIL_RATE * 100}%`);
  c.subscribe(['planta1/limpio/#', 'planta1/alarma/#'], { qos: 2 });
});
c.on('message', async (topic, buf) => {
  let body;
  try { body = JSON.parse(buf.toString()); } catch { return; }
  if (!body.mid) return;
  stats.recibidos++;
  if (seen.has(body.mid)) {                        // reintento: ya estaba en la API, solo se vuelve a confirmar
    stats.duplicados++;
    return c.publish('planta1/ack', JSON.stringify({ mid: body.mid }), { qos: 1 });
  }
  try {
    await enviarAApi(body);
    seen.add(body.mid);
    stats.aApi++;
    c.publish('planta1/ack', JSON.stringify({ mid: body.mid }), { qos: 1 });
  } catch (e) {
    stats.fallos++;                                // sin ACK: el nodo lo reenviará
  }
});
setInterval(() => console.log('puente:', JSON.stringify(stats)), 10000).unref();
c.on('error', (e) => console.error('MQTT:', e.message));
