"""
Keepalive and watchdog for arlo-streamer.

arlo-streamer only streams a camera while it is in the "streaming" state,
which it leaves after MOTION_TIMEOUT seconds of no motion.  This script
listens to arlo-streamer's status topic over MQTT and sends START whenever
a listed camera is not streaming, so wired cameras stay live.

It also watches MediaMTX's control API.  If a camera's path stops receiving
bytes for STALL_SECONDS, it sends STOP then START to force arlo-streamer to
reopen the stream.

Environment (set by run.sh from the add-on options):
  MQTT_BROKER, MQTT_PORT, MQTT_USER, MQTT_PASS
  KEEPALIVE_CAMERAS   comma-separated arlo-streamer camera names
  KEEPALIVE_INTERVAL  seconds between checks
  STALL_SECONDS       seconds without new bytes before a restart
  MEDIAMTX_API_URL    e.g. http://192.168.40.7:9997 (empty disables stall checks)
"""

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request

import aiomqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] keepalive: %(message)s",
)
log = logging.getLogger("keepalive")

CAMERAS = [c.strip() for c in os.environ.get("KEEPALIVE_CAMERAS", "").split(",") if c.strip()]
INTERVAL = int(os.environ.get("KEEPALIVE_INTERVAL", "30"))
STALL = int(os.environ.get("STALL_SECONDS", "120"))
API = os.environ.get("MEDIAMTX_API_URL", "").rstrip("/")

BROKER = os.environ["MQTT_BROKER"]
PORT = int(os.environ.get("MQTT_PORT", "1883"))
USER = os.environ.get("MQTT_USER") or None
PASSWORD = os.environ.get("MQTT_PASS") or None

CONTROL_TOPIC = "arlo/control/{name}"
STATUS_TOPIC = "arlo/status/{name}"


UNREACHABLE = object()
_api_warned = False


def path_bytes(name):
    """
    bytesReceived for a ready MediaMTX path.
    None  -> the path exists but is not ready, or does not exist (404).
    UNREACHABLE -> the API itself could not be queried (down, 401, ...);
                   stall detection is skipped so healthy streams are left alone.
    """
    global _api_warned
    if not API:
        return UNREACHABLE
    try:
        with urllib.request.urlopen(f"{API}/v3/paths/get/{name}", timeout=5) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        if not _api_warned:
            log.warning("MediaMTX API returned HTTP %s; stall detection disabled "
                        "(check the relay's API allow-list)", err.code)
            _api_warned = True
        return UNREACHABLE
    except Exception as err:
        if not _api_warned:
            log.warning("MediaMTX API unreachable (%s); stall detection disabled", err)
            _api_warned = True
        return UNREACHABLE
    _api_warned = False
    if not data.get("ready"):
        return None
    return data.get("bytesReceived")


async def status_reader(client, states):
    async with client.messages() as messages:
        await client.subscribe(STATUS_TOPIC.format(name="+"))
        async for message in messages:
            name = message.topic.value.rsplit("/", 1)[-1]
            try:
                state = json.loads(message.payload).get("state")
            except (ValueError, AttributeError):
                continue
            states[name] = (state, time.monotonic())


async def publish(client, name, command):
    log.info("%s -> %s", name, command)
    await client.publish(CONTROL_TOPIC.format(name=name), payload=command)


async def supervise(client, states):
    last_bytes = {}
    last_change = {}
    last_kick = {}

    while True:
        now = time.monotonic()
        for cam in CAMERAS:
            state, _ = states.get(cam, (None, 0.0))

            # Stall detection via MediaMTX.
            received = await asyncio.to_thread(path_bytes, cam)
            if received is UNREACHABLE:
                last_change[cam] = now  # blind: do not accumulate stall time
                stalled = False
            else:
                if received is not None and received != last_bytes.get(cam):
                    last_bytes[cam] = received
                    last_change[cam] = now
                last_change.setdefault(cam, now)
                stalled = (now - last_change[cam]) > STALL

            since_kick = now - last_kick.get(cam, 0.0)

            if stalled and state == "streaming" and since_kick > STALL:
                log.warning("%s: no bytes for %ds, restarting stream", cam, STALL)
                await publish(client, cam, "STOP")
                await asyncio.sleep(5)
                await publish(client, cam, "START")
                last_kick[cam] = now
                last_change[cam] = now
            elif state is not None and state != "streaming":
                await publish(client, cam, "START")
                last_kick[cam] = now
            elif state is None and since_kick > STALL:
                # No status seen yet; nudge in case arlo-streamer is up but idle.
                await publish(client, cam, "START")
                last_kick[cam] = now

        await asyncio.sleep(INTERVAL)


async def main():
    if not CAMERAS:
        log.error("No cameras listed in KEEPALIVE_CAMERAS; nothing to do.")
        return
    states = {}
    while True:
        try:
            async with aiomqtt.Client(
                hostname=BROKER, port=PORT, username=USER, password=PASSWORD
            ) as client:
                log.info("Connected to MQTT at %s:%d; keeping %s streaming",
                         BROKER, PORT, ", ".join(CAMERAS))
                reader = asyncio.create_task(status_reader(client, states))
                try:
                    await supervise(client, states)
                finally:
                    reader.cancel()
        except aiomqtt.MqttError as err:
            log.warning("MQTT error: %s; reconnecting in 5s", err)
            await asyncio.sleep(5)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
