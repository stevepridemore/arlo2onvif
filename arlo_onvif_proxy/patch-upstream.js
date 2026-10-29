'use strict';
/*
 * Build-time patch for daniela-hase/onvif-server: advertise the ONVIF Events
 * service (served by events-main.js on ports.events) in GetCapabilities and
 * GetServices. Fails the build if the upstream code no longer matches.
 *
 * Usage: node patch-upstream.js /app/src/onvif-server.js
 */

const fs = require('fs');

const file = process.argv[2] || '/app/src/onvif-server.js';
let src = fs.readFileSync(file, 'utf8');

function replaceOnce(anchor, replacement, label) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
        console.error(`patch-upstream: expected exactly one match for ${label}, found ${count}`);
        process.exit(1);
    }
    src = src.replace(anchor, replacement);
}

// 1. GetCapabilities: add the Events capability block before the Media block.
//    The events service is served on the device port (Protect posts there
//    regardless of what is advertised).
replaceOnce(
    "                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {",
    "                        if (this.config.events && this.config.events.source && (args.Category === undefined || args.Category == 'All' || args.Category == 'Events')) {\n" +
    "                            response.Capabilities['Events'] = {\n" +
    "                                XAddr: `http://${this.config.hostname}:${this.config.ports.server}/onvif/events_service`,\n" +
    "                                WSSubscriptionPolicySupport: false,\n" +
    "                                WSPullPointSupport: true,\n" +
    "                                WSPausableSubscriptionManagerInterfaceSupport: false\n" +
    "                            };\n" +
    "                        }\n" +
    "                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {",
    'GetCapabilities Media block'
);

// 2. GetServices: append the Events service entry.
replaceOnce(
    "                    GetServices: (args) => {\n" +
    "                        return {\n" +
    "                            Service : [",
    "                    GetServices: (args) => {\n" +
    "                        let eventsService = (this.config.events && this.config.events.source) ? [{\n" +
    "                            Namespace : 'http://www.onvif.org/ver10/events/wsdl',\n" +
    "                            XAddr : `http://${this.config.hostname}:${this.config.ports.server}/onvif/events_service`,\n" +
    "                            Version : { Major : 2, Minor : 5 }\n" +
    "                        }] : [];\n" +
    "                        return {\n" +
    "                            Service : eventsService.concat([",
    'GetServices opening'
);
replaceOnce(
    "                                    Version : { \n" +
    "                                        Major : 2,\n" +
    "                                        Minor : 5,\n" +
    "                                    }\n" +
    "                                }\n" +
    "                            ]\n" +
    "                        };\n" +
    "                    },\n" +
    "                \n" +
    "                    GetDeviceInformation:",
    "                                    Version : { \n" +
    "                                        Major : 2,\n" +
    "                                        Minor : 5,\n" +
    "                                    }\n" +
    "                                }\n" +
    "                            ])\n" +
    "                        };\n" +
    "                    },\n" +
    "                \n" +
    "                    GetDeviceInformation:",
    'GetServices closing'
);

// 3. Route the events service through onvif-server's own HTTP server (device
//    port) and log anything else that matches no service, so we can see what
//    an NVR is probing for.
replaceOnce(
    "        } else {\n" +
    "            response.writeHead(404, {'Content-Type': 'text/plain'});\n" +
    "            response.write('404 Not Found\\n');\n" +
    "            response.end();\n" +
    "        }",
    "        } else if (this.events && (action === '/onvif/events_service' || action.startsWith('/onvif/events/sub/'))) {\n" +
    "            this.events.handle(request, response);\n" +
    "        } else {\n" +
    "            console.log(`${new Date().toISOString().slice(11, 23)} WARN  unhandled ${request.method} ${action} from ${request.socket.remoteAddress}`);\n" +
    "            response.writeHead(404, {'Content-Type': 'text/plain'});\n" +
    "            response.write('404 Not Found\\n');\n" +
    "            response.end();\n" +
    "        }",
    'listen() 404 branch'
);
// listen() is handed to http.createServer unbound upstream; bind it so
// `this.events` is reachable.
replaceOnce(
    "        this.server = http.createServer(this.listen);",
    "        this.server = http.createServer(this.listen.bind(this));",
    'createServer(listen)'
);

// 4. Audio: declare an audio source and encoder in both profiles so the NVR
//    knows the stream carries sound (Protect shows hasMic=false otherwise).
replaceOnce(
    "                    H264: {\n" +
    "                        GovLength: this.config.highQuality.framerate,\n" +
    "                        H264Profile: 'Main'\n" +
    "                    },\n" +
    "                    SessionTimeout: 'PT1000S'\n" +
    "                }\n" +
    "            }\n" +
    "        ];",
    "                    H264: {\n" +
    "                        GovLength: this.config.highQuality.framerate,\n" +
    "                        H264Profile: 'Main'\n" +
    "                    },\n" +
    "                    SessionTimeout: 'PT1000S'\n" +
    "                },\n" +
    "                ...this.audioEncoderConfig()\n" +
    "            }\n" +
    "        ];",
    'main profile closing'
);
// Schema order is VideoSource, AudioSource, VideoEncoder, AudioEncoder, so the
// audio source goes in front of each VideoEncoderConfiguration.
replaceOnce(
    "                VideoEncoderConfiguration: {\n" +
    "                    attributes: {\n" +
    "                        token: 'encoder_hq_config_token'",
    "                ...this.audioSourceConfig(),\n" +
    "                VideoEncoderConfiguration: {\n" +
    "                    attributes: {\n" +
    "                        token: 'encoder_hq_config_token'",
    'main profile video encoder'
);
replaceOnce(
    "                    VideoEncoderConfiguration: {\n" +
    "                        attributes: {\n" +
    "                            token: 'encoder_lq_config_token'",
    "                    ...this.audioSourceConfig(),\n" +
    "                    VideoEncoderConfiguration: {\n" +
    "                        attributes: {\n" +
    "                            token: 'encoder_lq_config_token'",
    'sub profile video encoder'
);
replaceOnce(
    "                        H264: {\n" +
    "                            GovLength: this.config.lowQuality.framerate,\n" +
    "                            H264Profile: 'Main'\n" +
    "                        },\n" +
    "                        SessionTimeout: 'PT1000S'\n" +
    "                    }\n" +
    "                }\n" +
    "            );",
    "                        H264: {\n" +
    "                            GovLength: this.config.lowQuality.framerate,\n" +
    "                            H264Profile: 'Main'\n" +
    "                        },\n" +
    "                        SessionTimeout: 'PT1000S'\n" +
    "                    },\n" +
    "                    ...this.audioEncoderConfig()\n" +
    "                }\n" +
    "            );",
    'sub profile closing'
);
replaceOnce(
    "    listen(request, response) {",
    "    audioSourceConfig() {\n" +
    "        if (this.config.audio === false) return {};\n" +
    "        return {\n" +
    "            AudioSourceConfiguration: {\n" +
    "                Name: 'AudioSource',\n" +
    "                UseCount: 2,\n" +
    "                attributes: { token: 'audio_src_config_token' },\n" +
    "                SourceToken: 'audio_src_token'\n" +
    "            }\n" +
    "        };\n" +
    "    }\n" +
    "\n" +
    "    audioEncoderConfig() {\n" +
    "        if (this.config.audio === false) return {};\n" +
    "        const enc = String(this.config.audioEncoding || 'AAC').toUpperCase();\n" +
    "        return {\n" +
    "            AudioEncoderConfiguration: {\n" +
    "                Name: 'AudioEncoder',\n" +
    "                UseCount: 2,\n" +
    "                attributes: { token: 'audio_enc_config_token' },\n" +
    "                Encoding: enc,\n" +
    "                Bitrate: enc === 'AAC' ? 32 : 64,\n" +
    "                SampleRate: enc === 'AAC' ? 16 : 8,\n" +
    "                Multicast: { Address: { Type: 'IPv4', IPv4Address: '0.0.0.0' }, Port: 0, TTL: 0, AutoStart: false },\n" +
    "                SessionTimeout: 'PT1000S'\n" +
    "            }\n" +
    "        };\n" +
    "    }\n" +
    "\n" +
    "    audioConfigs() {\n" +
    "        return { ...this.audioSourceConfig(), ...this.audioEncoderConfig() };\n" +
    "    }\n" +
    "\n" +
    "    listen(request, response) {",
    'listen() method start'
);
replaceOnce(
    "                    GetSnapshotUri: (args) => {",
    "                    GetAudioSources: (args) => {\n" +
    "                        if (this.config.audio === false) return { AudioSources: [] };\n" +
    "                        return { AudioSources: [{ attributes: { token: 'audio_src_token' }, Channels: 1 }] };\n" +
    "                    },\n" +
    "\n" +
    "                    GetAudioSourceConfigurations: (args) => {\n" +
    "                        const a = this.audioConfigs();\n" +
    "                        return { Configurations: a.AudioSourceConfiguration ? [a.AudioSourceConfiguration] : [] };\n" +
    "                    },\n" +
    "\n" +
    "                    GetAudioEncoderConfigurations: (args) => {\n" +
    "                        const a = this.audioConfigs();\n" +
    "                        return { Configurations: a.AudioEncoderConfiguration ? [a.AudioEncoderConfiguration] : [] };\n" +
    "                    },\n" +
    "\n" +
    "                    GetSnapshotUri: (args) => {",
    'GetSnapshotUri handler'
);

fs.writeFileSync(file, src);
console.log(`patch-upstream: patched ${file}`);

// ---------------------------------------------------------------------------
// main.js: attach the events service to each camera when MQTT is configured.
const mainFile = process.argv[3] || '/app/main.js';
src = fs.readFileSync(mainFile, 'utf8');
replaceOnce(
    "            let server = onvifServer.createServer(onvifConfig, logger);\n" +
    "            if (server.getHostname()) {",
    "            let server = onvifServer.createServer(onvifConfig, logger);\n" +
    "            if (server.getHostname() && process.env.EVENTS_MQTT_URL && onvifConfig.events && onvifConfig.events.source) {\n" +
    "                server.events = require('./events-bridge').attach(onvifConfig, server, logger);\n" +
    "            }\n" +
    "            if (server.getHostname()) {",
    'main.js createServer'
);
fs.writeFileSync(mainFile, src);
console.log(`patch-upstream: patched ${mainFile}`);
