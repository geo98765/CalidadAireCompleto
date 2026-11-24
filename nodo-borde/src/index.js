'use strict';
const cfg = require('./config');
const { createApp } = require('./app');

const app = createApp(cfg);
app.start();

let closing = false;
async function bye() {
  if (closing) return;
  closing = true;
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('unhandledRejection', (e) => { if (process.env.DEBUG) console.error('Promesa sin manejar:', e); });
