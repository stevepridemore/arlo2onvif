'use strict';
/*
 * Attaches an ONVIF Events service to each virtual camera INSIDE onvif-server's
 * own HTTP server, on the device service port. UniFi Protect ignores the
 * events XAddr a camera advertises and posts to /onvif/events_service on the
 * device port, so that is where the service has to live.
 *
 * Loaded by the patched main.js. One MQTT motion source is shared by all
 * cameras. Environment:
 *   EVENTS_MQTT_URL        mqtt://host:1883 (required to enable events)
 *   EVENTS_MQTT_USER / EVENTS_MQTT_PASS   optional
 *   EVENTS_MQTT_TOPIC      comma-separated templates, default
 *                          "bridge/motion/{name},arlo/motion/{name}"
 *   EVENTS_MOTION_HOLD     seconds before a "true" auto-clears (default 90)
 *   EVENTS_EMIT_MOTION_ALARM   "true" to also send tns1:VideoSource/MotionAlarm
 */

const { MotionSource, EventsServer } = require('./events-server');

let motion = null;

function motionSource(logger) {
    if (motion) return motion;
    motion = new MotionSource({
        url: process.env.EVENTS_MQTT_URL,
        username: process.env.EVENTS_MQTT_USER || '',
        password: process.env.EVENTS_MQTT_PASS || '',
        topics: (process.env.EVENTS_MQTT_TOPIC || 'bridge/motion/{name},arlo/motion/{name}')
            .split(',').map((t) => t.trim()).filter(Boolean),
        holdSeconds: parseInt(process.env.EVENTS_MOTION_HOLD || '90', 10) || 0,
        logger,
    });
    motion.connect();
    return motion;
}

/**
 * Create the events service for one camera. Returns the EventsServer; the
 * caller stores it on the OnvifServer so listen() can route requests to it.
 */
function attach(config, server, logger) {
    const events = new EventsServer({
        hostname: server.getHostname(),
        port: config.ports.server,
        cameraName: config.name,
        source: config.events.source,
        motion: motionSource(logger),
        emitMotionAlarm: process.env.EVENTS_EMIT_MOTION_ALARM === 'true',
        logger,
        attached: true,
    });
    events.start();
    return events;
}

module.exports = { attach };
