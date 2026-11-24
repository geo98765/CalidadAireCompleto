'use strict';

const mqtt = require('mqtt');
const { Pipeline } = require('./pipeline');
const { Store } = require('./store');
const { Publisher } = require('./publisher');
const { AlarmEngine } = require('./alarms');

function createApp(cfg) {
  const log = process.env.DEBUG ? (...a) => console.log(new Date().toLocaleTimeString(), ...a) : () => { };

  const store = new Store(cfg.outbox.dbPath);
  const pipeline = new Pipeline(cfg);

  const client = mqtt.connect(`mqtt://${cfg.mqtt.host}:${cfg.mqtt.port}`, {
    clientId: cfg.mqtt.clientId,
    username: cfg.mqtt.username,
    password: cfg.mqtt.password,
    clean: false,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 20,
  });

  const publisher = new Publisher({ client, store, cfg });
  const alarms = new AlarmEngine({ cfg, store, publisher });


  pipeline.on('accept', (e) => alarms.evaluate(e));
  pipeline.on('frame', (f) =>
    publisher.enqueue({
      mid: f.mid,
      kind: 'lectura',
      sensorId: f.sensorId,
      ts: f.ts,
      topic: `${cfg.mqtt.topicOut}/${f.sensorId}`, payload: f.payload,
    })
  );
  pipeline.on('discard', (d) => log(`descartada [${d.reason}] ${d.sensorId} ${d.variable ?? ''} ${d.value ?? ''}`));
  publisher.on('send-error', (e) => log('envío fallido, quedará en cola:', e.error));


  client.on('connect', () => {
    log(`MQTT conectado a ${cfg.mqtt.host}:${cfg.mqtt.port}`);
    client.subscribe(cfg.mqtt.topicIn, { qos: 0 }, (err) => err && log('error al suscribirse:', err.message));
    client.subscribe(cfg.mqtt.topicAck, { qos: 1 }, (err) => err && log('error al suscribirse (ack):', err.message));
    publisher.pump();
  });
  client.on('close', () => log('MQTT desconectado — las lecturas se guardan en la cola local'));
  client.on('error', (e) => log('MQTT error:', e.message));

  client.on('message', (topic, buf) => {
    try {
      if (topic === cfg.mqtt.topicAck) {
        const a = JSON.parse(buf.toString());
        for (const mid of Array.isArray(a.mids) ? a.mids : [a.mid]) if (mid) publisher.onAck(mid);
        return;
      }
      let data = null;
      try { data = JSON.parse(buf.toString()); } catch (_) { }
      const sensorId = (data && typeof data.id === 'string' && data.id) || topic.split('/').pop();
      pipeline.ingest(sensorId, data, Date.now(), buf.length);
    } catch (e) {
      log('error procesando mensaje:', e.message);
    }
  });

  const sweepTimer = setInterval(() => pipeline.sweep(), cfg.filter.sweepMs);

  return {
    cfg, store, client, pipeline, publisher, alarms,
    start() {
      publisher.start();
    },
    async stop() {
      clearInterval(sweepTimer);
      publisher.stop();
      await new Promise((r) => client.end(true, {}, r));
      store.close();
    },
  };
}

module.exports = { createApp };
