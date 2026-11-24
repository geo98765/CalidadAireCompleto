'use strict';

const P = { PICO: 0.03, REGIMEN_ALTO: 0.02, RACHA_MIN: 8, RACHA_MAX: 25, REVERSION: 0.25 };

//         nombre  min  max   base  alto  sigma dec
const TIPOS = {
  co2:      [['co2', 400, 5000, 480, 1600, 25, 0], ['temp', 15, 40, 23, 28, 0.25, 1]],
  simple:   [['temp', 15, 40, 22, 29, 0.25, 1]],
  ambiente: [['temp', 15, 40, 23, 30, 0.25, 1], ['humedad', 20, 95, 50, 75, 1.0, 1], ['presion', 990, 1030, 1010, 1018, 0.4, 1]],
  aire:     [['pm25', 0, 100, 6, 40, 1.2, 1], ['pm10', 0, 200, 12, 80, 2.5, 1], ['co2', 400, 5000, 480, 1800, 25, 0],
             ['temp', 15, 40, 23, 30, 0.25, 1], ['humedad', 20, 95, 50, 78, 1.0, 1]],
};
const SENSORES = [
  ['S_CO2_01', 'co2'], ['S_TEMP_02', 'simple'], ['S_ENV_03', 'ambiente'], ['S_CO2_04', 'co2'],
  ['S_TEMP_05', 'simple'], ['S_AIRE_06', 'aire'], ['S_AIRE_07', 'aire'],
];

function mulberry32(a) {           // generador pseudoaleatorio con semilla (resultados repetibles)
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class Sim {
  constructor(seed = Date.now()) {
    this.rnd = mulberry32(seed);
    this.sensors = SENSORES.map(([id, tipo]) => ({
      id,
      vars: TIPOS[tipo].map(([name, min, max, base, alto, sigma, dec]) =>
        ({ name, min, max, base, alto, sigma, dec, valor: base, regimen: 0, restante: 0 })),
    }));
  }
  gauss() { let s = 0; for (let i = 0; i < 6; i++) s += this.rnd(); return (s - 3) * 1.414; }
  randint(a, b) { return a + Math.floor(this.rnd() * (b - a + 1)); }

  stepVar(v) {
    if (v.restante > 0) { v.restante--; if (v.restante === 0) v.regimen = 0; }
    else if (this.rnd() < P.REGIMEN_ALTO) { v.regimen = 1; v.restante = this.randint(P.RACHA_MIN, P.RACHA_MAX); }
    const objetivo = v.regimen ? v.alto : v.base;
    v.valor += (objetivo - v.valor) * P.REVERSION + this.gauss() * v.sigma;
    v.valor = Math.min(v.max, Math.max(v.min, v.valor));
    let r = v.valor, spike = false;
    if (this.rnd() < P.PICO) { r += (v.max - v.min) * (0.25 + this.rnd() * 0.4); spike = true; }
    r = Math.min(v.max, Math.max(v.min, r));
    const f = v.dec === 0 ? 1 : 10;
    return { value: Math.round(r * f) / f, spike };
  }

  /** Una ronda: un mensaje por sensor.  truth[var] = true si esa lectura es un pico intencional */
  tick() {
    return this.sensors.map((s) => {
      const payload = { id: s.id }, truth = {};
      for (const v of s.vars) { const r = this.stepVar(v); payload[v.name] = r.value; truth[v.name] = r.spike; }
      return { topic: `esp32/sensor/${s.id}`, payload, truth };
    });
  }
}

module.exports = { Sim, SENSORES };

// ---------------- Modo línea de comandos ----------------
if (require.main === module) {
  const mqtt = require('mqtt');
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const host = arg('host', process.env.MQTT_HOST || '127.0.0.1');
  const port = Number(arg('port', process.env.MQTT_PORT || 1883));
  const every = Number(arg('every', 2000));
  const chaos = process.argv.includes('--chaos');
  const sim = new Sim();
  const c = mqtt.connect(`mqtt://${host}:${port}`, { clientId: 'esp32_sim_' + Math.random().toString(16).slice(2, 6) });
  c.on('connect', () => console.log(`Simulador conectado a ${host}:${port}, una ronda cada ${every} ms${chaos ? ' (modo caos)' : ''}`));
  c.on('error', (e) => console.error('MQTT:', e.message));
  setInterval(() => {
    for (const m of sim.tick()) {
      const send = (obj) => c.publish(m.topic, typeof obj === 'string' ? obj : JSON.stringify(obj));
      send(m.payload);
      if (chaos) {
        const r = Math.random();
        if (r < 0.03) send(m.payload);                                             // duplicado
        else if (r < 0.05) { const k = Object.keys(m.payload).find((x) => x !== 'id'); send({ ...m.payload, [k]: -999 }); }
        else if (r < 0.065) { const k = Object.keys(m.payload).find((x) => x !== 'id'); send({ ...m.payload, [k]: 'ERR' }); }
        else if (r < 0.075) send('{esto no es json');
      }
    }
  }, every);
}
