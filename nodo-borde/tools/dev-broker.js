'use strict';

const net = require('net');
const aedes = require('aedes')();
const port = Number(process.env.MQTT_PORT || 1883);
const server = net.createServer(aedes.handle);
server.listen(port, () => console.log(`Broker de pruebas escuchando en el puerto ${port}`));
aedes.on('client', (c) => console.log('cliente conectado:', c.id));
aedes.on('clientDisconnect', (c) => console.log('cliente desconectado:', c.id));
