'use strict';
/*
 * Starts one ONVIF Events service per virtual camera listed in the
 * onvif-server config (/onvif.yaml), fed by Arlo motion over MQTT.
 *
 * Environment:
 *   EVENTS_MQTT_URL        mqtt://host:1883
 *   EVENTS_MQTT_USER / EVENTS_MQTT_PASS   optional
 *   EVENTS_MQTT_TOPIC      default arlo/motion/{name}
 *   EVENTS_MOTION_HOLD     seconds before a "true" auto-clears (default 90)
 *   EVENTS_EMIT_MOTION_ALARM   "true" to also send tns1:VideoSource/MotionAlarm
 *   EVENTS_DEBUG           "true" for per-request logging
 *
 * Each camera entry in the YAML needs `ports.events` and `events.source`
 * (the arlo-streamer camera name whose motion topic to follow).
 */

const fs = require('fs');
const os = require('os');
const yaml = require('yaml');
const { MotionSource, EventsServer } = require('./events-server');

function ipForMac(mac) {
    const wanted = String(mac).toLowerCase();
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs) {
            if (a.family === 'IPv4' && a.mac.toLowerCase() === wanted) return a.address;
        }
    }
    return null;
}

const DEBUG = process.env.EVENTS_DEBUG === 'true';
const stamp = () => new Date().toISOString().slice(11, 23);
const logger = {
    info: (m) => console.log(`${stamp()} INFO  ${m}`),
    warn: (m) => console.log(`${stamp()} WARN  ${m}`),
    error: (m) => console.error(`${stamp()} ERROR ${m}`),
    debug: DEBUG ? (m) => console.log(`${stamp()} DEBUG ${m}`) : null,
};

const configPath = process.argv[2] || '/onvif.yaml';
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
const cameras = (config.onvif || []).filter((c) => c.ports && c.ports.events && c.events && c.events.source);

if (cameras.length === 0) {
    logger.error('No cameras with ports.events and events.source in the config; nothing to do.');
    process.exit(1);
}
if (!process.env.EVENTS_MQTT_URL) {
    logger.error('EVENTS_MQTT_URL is not set.');
    process.exit(1);
}

const motion = new MotionSource({
    url: process.env.EVENTS_MQTT_URL,
    username: process.env.EVENTS_MQTT_USER || '',
    password: process.env.EVENTS_MQTT_PASS || '',
    topic: process.env.EVENTS_MQTT_TOPIC || 'arlo/motion/{name}',
    holdSeconds: parseInt(process.env.EVENTS_MOTION_HOLD || '90', 10) || 0,
    logger,
});

for (const cam of cameras) {
    cam.hostname = cam.hostname || ipForMac(cam.mac);
    if (!cam.hostname) {
        logger.error(`No interface with MAC ${cam.mac} for ${cam.name}; is the macvlan up?`);
        process.exit(1);
    }
}

const servers = cameras.map((cam) => new EventsServer({
    hostname: cam.hostname,
    port: cam.ports.events,
    cameraName: cam.name,
    source: cam.events.source,
    motion,
    emitMotionAlarm: process.env.EVENTS_EMIT_MOTION_ALARM === 'true',
    logger,
}));

for (const server of servers) server.start();
motion.connect();

function shutdown() {
    logger.info('Events service stopping');
    for (const server of servers) server.server && server.server.close();
    motion.client && motion.client.end(true);
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
