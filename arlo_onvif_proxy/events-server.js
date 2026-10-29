'use strict';
/*
 * ONVIF Events service (WS-BaseNotification PullPoint) for the virtual
 * cameras, driven by Arlo motion published over MQTT by arlo-streamer.
 *
 * Implements, over raw SOAP 1.2 XML on its own HTTP port per camera:
 *   GetServiceCapabilities, GetEventProperties, CreatePullPointSubscription,
 *   PullMessages, Renew, Unsubscribe, SetSynchronizationPoint.
 *
 * Motion is reported as the property event every NVR understands,
 *   tns1:RuleEngine/CellMotionDetector/Motion  (Data: IsMotion = true|false)
 * and optionally also as tns1:VideoSource/MotionAlarm (Data: State).
 */

const http = require('http');
const crypto = require('crypto');
const mqtt = require('mqtt');

const NS = {
    s: 'http://www.w3.org/2003/05/soap-envelope',
    wsa: 'http://www.w3.org/2005/08/addressing',
    wsnt: 'http://docs.oasis-open.org/wsn/b-2',
    wstop: 'http://docs.oasis-open.org/wsn/t-1',
    tev: 'http://www.onvif.org/ver10/events/wsdl',
    tt: 'http://www.onvif.org/ver10/schema',
    tns1: 'http://www.onvif.org/ver10/topics',
    xs: 'http://www.w3.org/2001/XMLSchema',
};

const ACTIONS = {
    GetServiceCapabilities: `${NS.tev}/EventPortType/GetServiceCapabilitiesResponse`,
    GetEventProperties: `${NS.tev}/EventPortType/GetEventPropertiesResponse`,
    CreatePullPointSubscription: `${NS.tev}/EventPortType/CreatePullPointSubscriptionResponse`,
    PullMessages: `${NS.tev}/PullPointSubscription/PullMessagesResponse`,
    SetSynchronizationPoint: `${NS.tev}/PullPointSubscription/SetSynchronizationPointResponse`,
    Renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewResponse',
    Unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeResponse',
};

const MAX_PULL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_TERMINATION_MS = 10 * 60 * 1000;
const MAX_TERMINATION_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE = 200;

function isoNow(date) {
    return (date || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** xs:duration (PT10S, PT1M30S, P1D...) or xs:dateTime -> milliseconds from now. */
function parseTerminationMs(value, fallbackMs) {
    if (!value) return fallbackMs;
    const duration = parseDurationMs(value);
    if (duration !== null) return duration;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    return fallbackMs;
}

function parseDurationMs(value) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(value).trim());
    if (!m) return null;
    const [, d, h, mi, s] = m;
    return ((+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
}

function tag(body, name) {
    // First element named `name` in any namespace prefix; returns inner text or null.
    const re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${name}>`);
    const m = re.exec(body);
    return m ? m[1].trim() : null;
}

function detectOperation(body) {
    const bodyPart = (/<(?:[\w.-]+:)?Body[^>]*>([\s\S]*)<\/(?:[\w.-]+:)?Body>/.exec(body) || [, body])[1];
    const m = /<(?:[\w.-]+:)?(GetServiceCapabilities|GetEventProperties|CreatePullPointSubscription|PullMessages|SetSynchronizationPoint|Renew|Unsubscribe|Subscribe)\b/.exec(bodyPart);
    return m ? m[1] : null;
}

/* ---------------------------------------------------------------------- */
/* Shared MQTT motion source                                               */
/* ---------------------------------------------------------------------- */

class MotionSource {
    /**
     * @param {object} opts
     * @param {string} opts.url        mqtt://host:port
     * @param {string} [opts.username]
     * @param {string} [opts.password]
     * @param {string} opts.topic      e.g. "arlo/motion/{name}"
     * @param {number} opts.holdSeconds  auto-clear if no "false" arrives
     * @param {object} opts.logger
     */
    constructor(opts) {
        this.opts = opts;
        this.logger = opts.logger;
        this.states = new Map();     // name -> boolean
        this.listeners = new Map();  // name -> Set<fn(bool)>
        this.holdTimers = new Map();
        this.client = null;
    }

    topicFor(name) {
        return this.opts.topic.replace('{name}', name);
    }

    nameFromTopic(topic) {
        const [prefix, suffix] = this.opts.topic.split('{name}');
        if (!topic.startsWith(prefix)) return null;
        const rest = topic.slice(prefix.length);
        if (suffix && !rest.endsWith(suffix)) return null;
        return suffix ? rest.slice(0, -suffix.length) : rest;
    }

    connect() {
        const { url, username, password } = this.opts;
        this.client = mqtt.connect(url, {
            username: username || undefined,
            password: password || undefined,
            reconnectPeriod: 5000,
            connectTimeout: 10000,
        });
        this.client.on('connect', () => {
            this.logger.info(`MQTT connected to ${url}`);
            this.client.subscribe(this.topicFor('+'), (err) => {
                if (err) this.logger.error(`MQTT subscribe failed: ${err.message}`);
                else this.logger.info(`MQTT subscribed to ${this.topicFor('+')}`);
            });
        });
        this.client.on('error', (err) => this.logger.warn(`MQTT error: ${err.message}`));
        this.client.on('offline', () => this.logger.warn('MQTT offline; reconnecting'));
        this.client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));
    }

    onMessage(topic, payload) {
        const name = this.nameFromTopic(topic);
        if (!name) return;
        const text = payload.trim().toLowerCase();
        let value;
        if (['true', '1', 'on', 'yes'].includes(text)) value = true;
        else if (['false', '0', 'off', 'no', 'null'].includes(text)) value = false;
        else {
            try { value = Boolean(JSON.parse(payload)); } catch { return; }
        }
        this.setState(name, value);
    }

    setState(name, value) {
        const previous = this.states.get(name);
        this.states.set(name, value);

        clearTimeout(this.holdTimers.get(name));
        if (value && this.opts.holdSeconds > 0) {
            this.holdTimers.set(name, setTimeout(() => {
                this.logger.info(`${name}: motion hold expired after ${this.opts.holdSeconds}s, clearing`);
                this.setState(name, false);
            }, this.opts.holdSeconds * 1000));
        }

        if (previous === value) return;
        this.logger.info(`${name}: motion ${value ? 'started' : 'ended'}`);
        for (const fn of this.listeners.get(name) || []) fn(value);
    }

    isMotion(name) {
        return this.states.get(name) === true;
    }

    on(name, fn) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(fn);
    }
}

/* ---------------------------------------------------------------------- */
/* Per-camera Events service                                               */
/* ---------------------------------------------------------------------- */

class EventsServer {
    /**
     * @param {object} opts
     * @param {string} opts.hostname    virtual IP to bind
     * @param {number} opts.port        events HTTP port
     * @param {string} opts.cameraName  display name
     * @param {string} opts.source      MQTT camera name (arlo-streamer name)
     * @param {MotionSource} opts.motion
     * @param {boolean} [opts.emitMotionAlarm]
     * @param {object} opts.logger
     */
    constructor(opts) {
        this.opts = opts;
        this.logger = opts.logger;
        this.subs = new Map();
        this.servicePath = '/onvif/events_service';
        this.xaddr = `http://${opts.hostname}:${opts.port}${this.servicePath}`;
        opts.motion.on(opts.source, (value) => this.broadcast(value, 'Changed'));
    }

    start() {
        this.server = http.createServer((req, res) => this.handle(req, res));
        this.server.on('error', (err) => this.logger.error(`[${this.opts.cameraName}] events server error: ${err.message}`));
        this.server.listen(this.opts.port, this.opts.hostname, () => {
            this.logger.info(`[${this.opts.cameraName}] ONVIF events at ${this.xaddr} (source ${this.opts.source})`);
        });
        this.reaper = setInterval(() => this.reap(), 30 * 1000);
    }

    /* ---- subscriptions ---- */

    createSubscription(terminationMs, id) {
        const now = Date.now();
        const sub = {
            id: id || crypto.randomUUID(),
            termination: now + terminationMs,
            queue: [],
            waiters: [],
        };
        this.subs.set(sub.id, sub);
        // Property events start with the current state so the client knows it.
        this.enqueue(sub, this.buildMessages(this.opts.motion.isMotion(this.opts.source), 'Initialized'));
        this.logger.info(`[${this.opts.cameraName}] subscription ${sub.id} created (${Math.round(terminationMs / 1000)}s)`);
        return sub;
    }

    subscriptionAddress(sub) {
        return `http://${this.opts.hostname}:${this.opts.port}/onvif/events/sub/${sub.id}`;
    }

    findSubscription(req, body) {
        const fromPath = /\/onvif\/events\/sub\/([\w-]+)/.exec(req.url || '');
        const to = tag(body, 'To') || '';
        const fromTo = /\/onvif\/events\/sub\/([\w-]+)/.exec(to);
        const id = (fromPath && fromPath[1]) || (fromTo && fromTo[1]) || null;
        if (id && this.subs.has(id)) return this.subs.get(id);
        if (id) {
            // Unknown id (we probably restarted): revive it rather than faulting,
            // so an NVR that keeps pulling on an old reference recovers.
            this.logger.warn(`[${this.opts.cameraName}] reviving unknown subscription ${id}`);
            return this.createSubscription(DEFAULT_TERMINATION_MS, id);
        }
        if (this.subs.size === 1) return this.subs.values().next().value;
        return null;
    }

    reap() {
        const now = Date.now();
        for (const [id, sub] of this.subs) {
            if (sub.termination < now - 60 * 1000) {
                this.subs.delete(id);
                for (const w of sub.waiters) w([]);
                this.logger.info(`[${this.opts.cameraName}] subscription ${id} expired`);
            }
        }
    }

    enqueue(sub, messages) {
        sub.queue.push(...messages);
        if (sub.queue.length > MAX_QUEUE) sub.queue.splice(0, sub.queue.length - MAX_QUEUE);
        const waiters = sub.waiters;
        sub.waiters = [];
        for (const w of waiters) w();
    }

    broadcast(value, operation) {
        for (const sub of this.subs.values()) this.enqueue(sub, this.buildMessages(value, operation));
    }

    /* ---- message bodies ---- */

    buildMessages(isMotion, operation) {
        const time = isoNow();
        const msgs = [
            `<wsnt:NotificationMessage>` +
            `<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>` +
            `<wsnt:Message><tt:Message UtcTime="${time}" PropertyOperation="${operation}">` +
            `<tt:Source>` +
            `<tt:SimpleItem Name="VideoSourceConfigurationToken" Value="video_src_config_token"/>` +
            `<tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="analytics_config_token"/>` +
            `<tt:SimpleItem Name="Rule" Value="MotionDetectorRule"/>` +
            `</tt:Source>` +
            `<tt:Data><tt:SimpleItem Name="IsMotion" Value="${isMotion}"/></tt:Data>` +
            `</tt:Message></wsnt:Message></wsnt:NotificationMessage>`,
        ];
        if (this.opts.emitMotionAlarm) {
            msgs.push(
                `<wsnt:NotificationMessage>` +
                `<wsnt:Topic Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:VideoSource/MotionAlarm</wsnt:Topic>` +
                `<wsnt:Message><tt:Message UtcTime="${time}" PropertyOperation="${operation}">` +
                `<tt:Source><tt:SimpleItem Name="Source" Value="video_src_token"/></tt:Source>` +
                `<tt:Data><tt:SimpleItem Name="State" Value="${isMotion}"/></tt:Data>` +
                `</tt:Message></wsnt:Message></wsnt:NotificationMessage>`
            );
        }
        return msgs;
    }

    envelope(action, relatesTo, bodyXml) {
        const relates = relatesTo ? `<wsa:RelatesTo>${escapeXml(relatesTo)}</wsa:RelatesTo>` : '';
        return `<?xml version="1.0" encoding="UTF-8"?>` +
            `<s:Envelope xmlns:s="${NS.s}" xmlns:wsa="${NS.wsa}" xmlns:wsnt="${NS.wsnt}" xmlns:wstop="${NS.wstop}" ` +
            `xmlns:tev="${NS.tev}" xmlns:tt="${NS.tt}" xmlns:tns1="${NS.tns1}" xmlns:xs="${NS.xs}">` +
            `<s:Header><wsa:Action>${action}</wsa:Action>${relates}` +
            `<wsa:To>http://www.w3.org/2005/08/addressing/anonymous</wsa:To></s:Header>` +
            `<s:Body>${bodyXml}</s:Body></s:Envelope>`;
    }

    fault(code, reason, detailXml) {
        return `<?xml version="1.0" encoding="UTF-8"?>` +
            `<s:Envelope xmlns:s="${NS.s}" xmlns:wsnt="${NS.wsnt}" xmlns:ter="http://www.onvif.org/ver10/error">` +
            `<s:Body><s:Fault><s:Code><s:Value>s:${code}</s:Value></s:Code>` +
            `<s:Reason><s:Text xml:lang="en">${escapeXml(reason)}</s:Text></s:Reason>` +
            (detailXml ? `<s:Detail>${detailXml}</s:Detail>` : '') +
            `</s:Fault></s:Body></s:Envelope>`;
    }

    eventPropertiesBody() {
        return `<tev:GetEventPropertiesResponse>` +
            `<tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>` +
            `<wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>` +
            `<wstop:TopicSet>` +
            `<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true">` +
            `<tt:MessageDescription IsProperty="true">` +
            `<tt:Source>` +
            `<tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>` +
            `<tt:SimpleItemDescription Name="VideoAnalyticsConfigurationToken" Type="tt:ReferenceToken"/>` +
            `<tt:SimpleItemDescription Name="Rule" Type="xs:string"/>` +
            `</tt:Source>` +
            `<tt:Data><tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/></tt:Data>` +
            `</tt:MessageDescription>` +
            `</Motion></CellMotionDetector></tns1:RuleEngine>` +
            (this.opts.emitMotionAlarm
                ? `<tns1:VideoSource><MotionAlarm wstop:topic="true">` +
                  `<tt:MessageDescription IsProperty="true">` +
                  `<tt:Source><tt:SimpleItemDescription Name="Source" Type="tt:ReferenceToken"/></tt:Source>` +
                  `<tt:Data><tt:SimpleItemDescription Name="State" Type="xs:boolean"/></tt:Data>` +
                  `</tt:MessageDescription></MotionAlarm></tns1:VideoSource>`
                : '') +
            `</wstop:TopicSet>` +
            `<wsnt:TopicExpressionDialect>http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet</wsnt:TopicExpressionDialect>` +
            `<wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete</wsnt:TopicExpressionDialect>` +
            `<tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect>` +
            `<tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation>` +
            `</tev:GetEventPropertiesResponse>`;
    }

    /* ---- HTTP ---- */

    handle(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'text/plain' });
            res.end('ONVIF events service: POST SOAP only\n');
            return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
            this.dispatch(req, res, body).catch((err) => {
                this.logger.error(`[${this.opts.cameraName}] events error: ${err.stack || err}`);
                this.send(res, 500, this.fault('Receiver', 'Internal error'));
            });
        });
    }

    send(res, status, xml) {
        res.writeHead(status, {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(xml),
        });
        res.end(xml);
    }

    async dispatch(req, res, body) {
        const op = detectOperation(body);
        const messageId = tag(body, 'MessageID');
        const reply = (op, xml) => this.send(res, 200, this.envelope(ACTIONS[op], messageId, xml));
        this.logger.debug && this.logger.debug(`[${this.opts.cameraName}] events ${op} from ${req.socket.remoteAddress}`);

        switch (op) {
            case 'GetServiceCapabilities':
                return reply(op,
                    `<tev:GetServiceCapabilitiesResponse><tev:Capabilities ` +
                    `WSSubscriptionPolicySupport="false" WSPullPointSupport="true" ` +
                    `WSPausableSubscriptionManagerInterfaceSupport="false" ` +
                    `MaxNotificationProducers="10" MaxPullPoints="10" PersistentNotificationStorage="false"/>` +
                    `</tev:GetServiceCapabilitiesResponse>`);

            case 'GetEventProperties':
                return reply(op, this.eventPropertiesBody());

            case 'CreatePullPointSubscription': {
                const ms = Math.min(parseTerminationMs(tag(body, 'InitialTerminationTime'), DEFAULT_TERMINATION_MS), MAX_TERMINATION_MS);
                const sub = this.createSubscription(ms);
                return reply(op,
                    `<tev:CreatePullPointSubscriptionResponse>` +
                    `<tev:SubscriptionReference><wsa:Address>${this.subscriptionAddress(sub)}</wsa:Address></tev:SubscriptionReference>` +
                    `<wsnt:CurrentTime>${isoNow()}</wsnt:CurrentTime>` +
                    `<wsnt:TerminationTime>${isoNow(new Date(sub.termination))}</wsnt:TerminationTime>` +
                    `</tev:CreatePullPointSubscriptionResponse>`);
            }

            case 'PullMessages': {
                const sub = this.findSubscription(req, body);
                if (!sub) return this.send(res, 400, this.fault('Sender', 'Unknown subscription', '<wsnt:ResourceUnknownFault/>'));
                const timeoutMs = Math.min(parseDurationMs(tag(body, 'Timeout') || 'PT10S') ?? 10000, MAX_PULL_TIMEOUT_MS);
                const limit = Math.max(1, parseInt(tag(body, 'MessageLimit') || '100', 10) || 100);
                if (sub.queue.length === 0 && timeoutMs > 0) {
                    await new Promise((resolve) => {
                        const timer = setTimeout(resolve, timeoutMs);
                        sub.waiters.push(() => { clearTimeout(timer); resolve(); });
                    });
                }
                const messages = sub.queue.splice(0, limit);
                return reply(op,
                    `<tev:PullMessagesResponse>` +
                    `<tev:CurrentTime>${isoNow()}</tev:CurrentTime>` +
                    `<tev:TerminationTime>${isoNow(new Date(sub.termination))}</tev:TerminationTime>` +
                    messages.join('') +
                    `</tev:PullMessagesResponse>`);
            }

            case 'SetSynchronizationPoint': {
                const sub = this.findSubscription(req, body);
                if (sub) this.enqueue(sub, this.buildMessages(this.opts.motion.isMotion(this.opts.source), 'Initialized'));
                return reply(op, `<tev:SetSynchronizationPointResponse/>`);
            }

            case 'Renew': {
                const sub = this.findSubscription(req, body);
                if (!sub) return this.send(res, 400, this.fault('Sender', 'Unknown subscription', '<wsnt:ResourceUnknownFault/>'));
                const ms = Math.min(parseTerminationMs(tag(body, 'TerminationTime'), DEFAULT_TERMINATION_MS), MAX_TERMINATION_MS);
                sub.termination = Date.now() + ms;
                return reply(op,
                    `<wsnt:RenewResponse>` +
                    `<wsnt:TerminationTime>${isoNow(new Date(sub.termination))}</wsnt:TerminationTime>` +
                    `<wsnt:CurrentTime>${isoNow()}</wsnt:CurrentTime>` +
                    `</wsnt:RenewResponse>`);
            }

            case 'Unsubscribe': {
                const sub = this.findSubscription(req, body);
                if (sub) {
                    this.subs.delete(sub.id);
                    for (const w of sub.waiters) w();
                    this.logger.info(`[${this.opts.cameraName}] subscription ${sub.id} unsubscribed`);
                }
                return reply(op, `<wsnt:UnsubscribeResponse/>`);
            }

            case 'Subscribe':
                // WS-BaseNotification push subscriptions are not offered (capabilities say so).
                return this.send(res, 400, this.fault('Sender', 'Only PullPoint subscriptions are supported',
                    '<wsnt:UnacceptableInitialTerminationTimeFault/>'));

            default:
                return this.send(res, 400, this.fault('Sender', `Unsupported operation${op ? ' ' + op : ''}`));
        }
    }
}

module.exports = { MotionSource, EventsServer, parseDurationMs };
