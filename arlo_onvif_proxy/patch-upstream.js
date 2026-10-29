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
replaceOnce(
    "                        if (args.Category === undefined || args.Category == 'All' || args.Category == 'Media') {",
    "                        if (this.config.ports.events && (args.Category === undefined || args.Category == 'All' || args.Category == 'Events')) {\n" +
    "                            response.Capabilities['Events'] = {\n" +
    "                                XAddr: `http://${this.config.hostname}:${this.config.ports.events}/onvif/events_service`,\n" +
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
    "                        let eventsService = this.config.ports.events ? [{\n" +
    "                            Namespace : 'http://www.onvif.org/ver10/events/wsdl',\n" +
    "                            XAddr : `http://${this.config.hostname}:${this.config.ports.events}/onvif/events_service`,\n" +
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

fs.writeFileSync(file, src);
console.log(`patch-upstream: patched ${file}`);
