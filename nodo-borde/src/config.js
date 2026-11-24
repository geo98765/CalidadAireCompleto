'use strict';

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const str = (k, d) => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
const bool = (k, d) => env[k] === undefined || env[k] === '' ? d : ['1', 'true', 'si', 'sí', 'on'].includes(String(env[k]).toLowerCase());

const INF = Infinity;

const variables = {
  co2: {
    label: 'CO₂', unit: 'ppm', min: 400, max: 5000, decimals: 0,
    levels: [
      { from: 0, label: 'Aire exterior limpio', tone: 'ok' },
      { from: 450, label: 'Buena ventilación', tone: 'ok' },
      { from: 800, label: 'Aceptable', tone: 'ok' },
      { from: 1000, label: 'Insuficiente', tone: 'advertir' },
      { from: 1500, label: 'Deficiente', tone: 'peligro' },
      { from: 2000, label: 'Muy malo', tone: 'peligro' },
      { from: 5000, label: 'Peligroso', tone: 'critico' },
    ],
  },


  temp: {
    label: 'Temperatura', unit: '°C', min: 15, max: 40, decimals: 1,
    levels: [
      { from: -INF, label: 'Fresca', tone: 'ok' },
      { from: 18, label: 'Confortable', tone: 'ok' },
      { from: 27, label: 'Cálida', tone: 'advertir' },
      { from: 33, label: 'Calor alto', tone: 'peligro' },
      { from: 38, label: 'Calor extremo', tone: 'critico' },
    ],
  },
  humedad: {
    label: 'Humedad', unit: '%', min: 20, max: 95, decimals: 1,
    levels: [
      { from: -INF, label: 'Baja', tone: 'advertir' },
      { from: 30, label: 'Confortable', tone: 'ok' },
      { from: 60, label: 'Alta', tone: 'advertir' },
      { from: 80, label: 'Muy alta', tone: 'peligro' },
    ],
  },
  presion: {
    label: 'Presión', unit: 'hPa', min: 990, max: 1030, decimals: 1,
    levels: [
      { from: -INF, label: 'Baja', tone: 'advertir' },
      { from: 1000, label: 'Normal', tone: 'ok' },
      { from: 1025, label: 'Alta', tone: 'advertir' },
    ],
  },
  pm25: {
    label: 'PM2.5', unit: 'µg/m³', min: 0, max: 100, decimals: 1,
    levels: [
      { from: 0, label: 'Muy baja concentración', tone: 'ok' },
      { from: 5, label: 'Baja', tone: 'ok' },
      { from: 10, label: 'Moderado', tone: 'advertir' },
      { from: 15, label: 'Elevado', tone: 'advertir' },
      { from: 25, label: 'Mala', tone: 'peligro' },
      { from: 35, label: 'Muy mala', tone: 'peligro' },
      { from: 50, label: 'Perjudicial', tone: 'critico' },
    ],
  },
  pm10: {
    label: 'PM10', unit: 'µg/m³', min: 0, max: 200, decimals: 1,
    levels: [
      { from: 0, label: 'Excelente', tone: 'ok' },
      { from: 15, label: 'Buena', tone: 'ok' },
      { from: 30, label: 'Moderada', tone: 'advertir' },
      { from: 45, label: 'Elevada', tone: 'advertir' },
      { from: 75, label: 'Mala', tone: 'peligro' },
      { from: 100, label: 'Muy mala', tone: 'peligro' },
      { from: 150, label: 'Extremadamente alta', tone: 'critico' },
    ],
  },
};

module.exports = {
  mqtt: {
    host: str('MQTT_HOST', '192.168.1.66'),
    port: num('MQTT_PORT', 1883),
    username: str('MQTT_USER', undefined),
    password: str('MQTT_PASS', undefined),
    clientId: str('MQTT_CLIENT_ID', 'nodo_borde_planta1'),

    topicIn: str('TOPIC_IN', 'esp32/sensor/#'),
    topicOut: str('TOPIC_OUT', 'planta1/limpio'),
    topicAlarm: str('TOPIC_ALARM', 'planta1/alarma'),
    topicAck: str('TOPIC_ACK', 'planta1/ack'),
  },


  filter: {

    confirmWindowMs: num('CONFIRM_WINDOW_MS', 9000),
    confirmMin: num('CONFIRM_MIN', 2),
    tolFraction: num('TOL_FRACTION', 0.15),
    dupWindowMs: num('DUP_WINDOW_MS', 1000),
    dupSeqWindowMs: 30000,
    sweepMs: 500,
    reservedKeys: ['id', 'n', 'seq', 'ts', 'time', 'timestamp', 'sensor', 'mid'],
  },

  outbox: {
    dbPath: str('DB_PATH', './data/nodo.db'),
    tickMs: 1000,
    inflightTimeoutMs: 10000,
    maxInflight: 20,
    batch: 200,
    maxBackoffMs: 60000,

    apiAck: bool('API_ACK', false),
    apiAckTimeoutMs: num('API_ACK_TIMEOUT_MS', 15000),
    retentionHours: num('RETENTION_HOURS', 24),
  },

  alarms: {
    hysteresis: 0.03,
    minTone: 'peligro',
    consecutive: num('ALARM_CONSECUTIVE', 3),//Alarmas segidas antes de la alarma
    logFile: str('ALARM_LOG', './logs/alarmas.log'),
    webhookUrl: str('ALARM_WEBHOOK_URL', ''),
    webhookRetries: 3,
    bell: bool('ALARM_BELL', true),
  },

  variables,
};
