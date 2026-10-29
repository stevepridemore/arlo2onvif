"""
Video motion detection for the Arlo bridge.

Arlo suppresses its own motion detection while a camera is live streaming,
and the bridge keeps the cameras streaming all the time, so motion has to be
found in the video itself. For each camera this reads the relay's RTSP
stream with ffmpeg, keyframes only, scaled to a tiny greyscale frame, and
compares consecutive frames. When enough pixels change it publishes "true"
on the motion topic; after MOTION_END_SECONDS without change it publishes
"false". The ONVIF events service turns those into camera motion events for
Protect.

Environment (set by run.sh from the add-on options):
  MQTT_BROKER, MQTT_PORT, MQTT_USER, MQTT_PASS
  MOTION_CAMERAS       comma-separated camera names (relay path names)
  MOTION_RTSP_URL      relay base, e.g. rtsp://192.168.40.7:8555
  MOTION_TOPIC         e.g. bridge/motion/{name}
  MOTION_SENSITIVITY   1..100 (higher = more sensitive), default 50
  MOTION_END_SECONDS   seconds of stillness before "false", default 8
  MOTION_DEBUG         "true" to log the change fraction of every frame
"""

import asyncio
import json
import logging
import os
import time

import aiomqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] motion: %(message)s",
)
log = logging.getLogger("motion")

CAMERAS = [c.strip() for c in os.environ.get("MOTION_CAMERAS", "").split(",") if c.strip()]
RTSP_BASE = os.environ.get("MOTION_RTSP_URL", "rtsp://127.0.0.1:8554").rstrip("/")
TOPIC = os.environ.get("MOTION_TOPIC", "bridge/motion/{name}")
SENSITIVITY = max(1, min(100, int(os.environ.get("MOTION_SENSITIVITY", "50") or 50)))
END_SECONDS = max(1, int(os.environ.get("MOTION_END_SECONDS", "8") or 8))
DEBUG = os.environ.get("MOTION_DEBUG", "false").lower() == "true"

BROKER = os.environ["MQTT_BROKER"]
PORT = int(os.environ.get("MQTT_PORT", "1883"))
USER = os.environ.get("MQTT_USER") or None
PASSWORD = os.environ.get("MQTT_PASS") or None

# Analysis frame: small enough that a person is still a few pixels wide and
# the per-frame maths is trivial.
WIDTH, HEIGHT = 64, 36
FRAME_BYTES = WIDTH * HEIGHT
PIXEL_DELTA = 20            # 0..255 change needed to count a pixel as changed
GLOBAL_CHANGE = 0.70        # more than this fraction changed = lighting/IR flip, not motion
# Sensitivity 100 -> 0.5% of pixels, 50 -> 5%, 1 -> ~10%.
AREA_THRESHOLD = 0.005 + (100 - SENSITIVITY) / 100 * 0.095


def changed_fraction(prev: bytes, cur: bytes) -> float:
    changed = 0
    for a, b in zip(prev, cur):
        if abs(a - b) > PIXEL_DELTA:
            changed += 1
    return changed / FRAME_BYTES


class CameraMotion:
    def __init__(self, name, publish):
        self.name = name
        self.publish = publish
        self.active = False
        self.last_motion = 0.0
        self.url = f"{RTSP_BASE}/{name}"

    async def run(self):
        while True:
            try:
                await self.watch()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001
                log.warning("%s: detector error: %s", self.name, err)
            if self.active:
                await self.set_active(False)
            await asyncio.sleep(5)

    async def watch(self):
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-rtsp_transport", "tcp", "-skip_frame", "nokey",
            "-fflags", "+genpts", "-use_wallclock_as_timestamps", "1",
            "-i", self.url,
            "-an", "-vf", f"scale={WIDTH}:{HEIGHT},format=gray",
            "-fps_mode", "passthrough",   # one output frame per decoded keyframe, no duplicates
            "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        log.info("%s: watching %s", self.name, self.url)
        prev = None
        try:
            while True:
                frame = await asyncio.wait_for(proc.stdout.readexactly(FRAME_BYTES), timeout=60)
                now = time.monotonic()
                if prev is not None:
                    fraction = changed_fraction(prev, frame)
                    if DEBUG:
                        log.info("%s: changed %.1f%%", self.name, fraction * 100)
                    if fraction >= GLOBAL_CHANGE:
                        pass  # whole-frame change: lighting or IR switch
                    elif fraction >= AREA_THRESHOLD:
                        self.last_motion = now
                        if not self.active:
                            await self.set_active(True)
                if self.active and now - self.last_motion > END_SECONDS:
                    await self.set_active(False)
                prev = frame
        except asyncio.IncompleteReadError:
            err = (await proc.stderr.read()).decode(errors="replace").strip()
            log.warning("%s: stream ended%s", self.name, f": {err[-200:]}" if err else "")
        except asyncio.TimeoutError:
            log.warning("%s: no frames for 60s, restarting reader", self.name)
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    async def set_active(self, value):
        self.active = value
        log.info("%s: motion %s", self.name, "started" if value else "ended")
        await self.publish(self.name, value)


async def main():
    if not CAMERAS:
        log.error("No cameras in MOTION_CAMERAS; nothing to do.")
        return
    log.info("sensitivity %d -> motion when >= %.1f%% of pixels change; end after %ds still",
             SENSITIVITY, AREA_THRESHOLD * 100, END_SECONDS)

    queue: asyncio.Queue = asyncio.Queue()

    async def publish(name, value):
        await queue.put((name, value))

    cams = [CameraMotion(name, publish) for name in CAMERAS]
    tasks = [asyncio.create_task(c.run()) for c in cams]

    while True:
        try:
            async with aiomqtt.Client(hostname=BROKER, port=PORT, username=USER, password=PASSWORD) as client:
                log.info("Connected to MQTT at %s:%d; publishing %s", BROKER, PORT, TOPIC)
                # Re-announce current states after a reconnect.
                for c in cams:
                    await client.publish(TOPIC.format(name=c.name), payload=json.dumps(c.active), retain=True)
                while True:
                    name, value = await queue.get()
                    await client.publish(TOPIC.format(name=name), payload=json.dumps(value), retain=True)
        except aiomqtt.MqttError as err:
            log.warning("MQTT error: %s; reconnecting in 5s", err)
            await asyncio.sleep(5)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
