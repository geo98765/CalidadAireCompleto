# Calidad del aire: sistema completo en Docker

Un solo `docker compose` levanta todo:

| Servicio              | Qué hace                                              | Puerto en el equipo |
|-----------------------|-------------------------------------------------------|---------------------|
| `mosquitto`           | Broker MQTT único para todos                          | 1883                |
| `base_de_datos`       | PostgreSQL (el esquema se crea solo)                  | 5433                |
| `nodo-borde`          | Tu nodo Node.js: limpia lecturas y publica por MQTT   | (ninguno)           |
| `core-ingesta`        | Recibe por MQTT, clasifica, guarda, API y dashboard   | 8081                |
| `core-notificaciones` | Envía correos de alerta                               | (ninguno)           |
| `simulador` (opcional)| Simula el ESP32 para pruebas                          | (ninguno)           |

Flujo: ESP32 → `esp32/sensor/#` → **nodo-borde** → `planta1/limpio/<id>` y `planta1/alarma/<id>` → **core-ingesta** → PostgreSQL + dashboard → **core-notificaciones** (correo).

## Desplegar

```bash
cp .env.example .env        # opcional: los valores por defecto funcionan
docker compose up -d --build
docker compose ps
```

Dashboard: http://localhost:8081/dashboard.html · API: http://localhost:8081/docs

## ESP32

Debe publicar en `esp32/sensor/<id>` al broker `IP_DE_ESTE_EQUIPO:1883`
(la IP que ya usaba tu nodo, `192.168.1.66`, si es este equipo). No hay que cambiar el firmware.

## Probar sin el ESP32

```bash
docker compose --profile demo up -d simulador
docker compose logs -f core-ingesta      # debe mostrar "Lectura guardada"
docker compose stop simulador
```

## Comandos útiles

```bash
docker compose logs -f nodo-borde               # logs del nodo (agrega DEBUG: "1" en el compose para más detalle)
docker compose up -d --build core-ingesta       # reconstruir un solo servicio
docker compose down                             # detener, conserva datos
docker compose down -v                          # detener y BORRAR base de datos, cola y broker
```

## Correo (opcional)

Llena `MAIL_USERNAME`, `MAIL_PASSWORD` (contraseña de aplicación de Gmail) y `MAIL_DESTINATARIO` en `.env`
y ejecuta `docker compose up -d`.

## Notas

- Mosquitto acepta conexiones anónimas: úsalo solo en red local o agrega usuario y contraseña.
- El volumen `nodo_data` guarda la cola SQLite del nodo: si el broker cae, las lecturas se reenvían al volver.
