"""
Snapshot thumbnails for the Arlo bridge.

For each camera this keeps a JPEG of the latest keyframe from the relay
stream and serves it over HTTP, so the virtual ONVIF cameras can advertise a
real snapshot URL instead of the static placeholder logo. UniFi Protect and
Home Assistant use that image for camera tiles and event thumbnails.

Environment (set by run.sh from the add-on options):
  SNAPSHOT_CAMERAS     comma-separated camera names (relay path names)
  SNAPSHOT_RTSP_URL    relay base, e.g. rtsp://192.168.40.7:8555
  SNAPSHOT_INTERVAL    seconds between snapshots, default 10
  SNAPSHOT_PORT        HTTP port inside the container, default 8580
  SNAPSHOT_DIR         where JPEGs are written, default /tmp/snapshots
  MEDIAMTX_API_URL     relay API; used to wait until a stream exists (optional)

Serves GET /<camera>.jpg (404 until the first frame has been captured) and
GET / with a short status page.
"""

import asyncio
import json
import logging
import os
import time
import urllib.error
import urllib.request

from aiohttp import web

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] snapshots: %(message)s",
)
log = logging.getLogger("snapshots")

CAMERAS = [c.strip() for c in os.environ.get("SNAPSHOT_CAMERAS", "").split(",") if c.strip()]
RTSP_BASE = os.environ.get("SNAPSHOT_RTSP_URL", "rtsp://127.0.0.1:8554").rstrip("/")
INTERVAL = max(2, int(os.environ.get("SNAPSHOT_INTERVAL", "10") or 10))
PORT = int(os.environ.get("SNAPSHOT_PORT", "8580") or 8580)
OUT_DIR = os.environ.get("SNAPSHOT_DIR", "/tmp/snapshots")
API_BASE = os.environ.get("MEDIAMTX_API_URL", "").rstrip("/")
RETRY_SECONDS = 15


def path_ready(name) -> bool:
    if not API_BASE:
        return True
    try:
        with urllib.request.urlopen(f"{API_BASE}/v3/paths/get/{name}", timeout=5) as resp:
            return bool(json.load(resp).get("ready"))
    except urllib.error.HTTPError as err:
        return err.code != 404
    except Exception:
        return True


class Grabber:
    """One ffmpeg per camera, writing the latest keyframe to <name>.jpg."""

    def __init__(self, name):
        self.name = name
        self.url = f"{RTSP_BASE}/{name}"
        self.file = os.path.join(OUT_DIR, f"{name}.jpg")
        self.updated = 0.0

    async def run(self):
        waiting_logged = False
        while True:
            if not await asyncio.to_thread(path_ready, self.name):
                if not waiting_logged:
                    log.info("%s: waiting for the stream to appear on the relay", self.name)
                    waiting_logged = True
                await asyncio.sleep(RETRY_SECONDS)
                continue
            waiting_logged = False
            try:
                await self.grab()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001
                log.warning("%s: grabber error: %s", self.name, err)
            await asyncio.sleep(RETRY_SECONDS)

    async def grab(self):
        cmd = [
            "ffmpeg", "-nostdin", "-loglevel", "error",
            "-rtsp_transport", "tcp", "-skip_frame", "nokey",
            "-fflags", "+genpts", "-use_wallclock_as_timestamps", "1",
            "-i", self.url,
            "-an", "-vf", f"fps=1/{INTERVAL}",
            "-q:v", "4", "-update", "1", "-atomic_writing", "1", "-y",
            self.file,
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        log.info("%s: grabbing a keyframe every %ds from %s", self.name, INTERVAL, self.url)
        try:
            # Watch the file's mtime so we can log the first frame and detect stalls.
            first = True
            stalled_for = 0
            while proc.returncode is None:
                await asyncio.sleep(INTERVAL)
                try:
                    mtime = os.path.getmtime(self.file)
                except OSError:
                    mtime = 0
                if mtime > self.updated:
                    self.updated = mtime
                    stalled_for = 0
                    if first:
                        log.info("%s: first snapshot written", self.name)
                        first = False
                else:
                    stalled_for += INTERVAL
                    if stalled_for >= 60:
                        log.warning("%s: no new snapshot for 60s, restarting grabber", self.name)
                        break
                try:
                    await asyncio.wait_for(proc.wait(), timeout=0.01)
                except asyncio.TimeoutError:
                    pass
            if proc.returncode is not None:
                err = (await proc.stderr.read()).decode(errors="replace").strip()
                log.warning("%s: grabber exited (code %s)%s", self.name, proc.returncode,
                            f": {err[-200:]}" if err else "")
        finally:
            try:
                if proc.returncode is None:
                    proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass


async def serve(grabbers):
    by_name = {g.name: g for g in grabbers}

    async def snapshot(request):
        name = request.match_info["name"]
        g = by_name.get(name)
        if g is None:
            raise web.HTTPNotFound(text=f"unknown camera {name}")
        try:
            with open(g.file, "rb") as fh:
                data = fh.read()
        except OSError:
            raise web.HTTPNotFound(text="no snapshot yet")
        if not data.startswith(b"\xff\xd8"):
            raise web.HTTPServiceUnavailable(text="snapshot being written")
        return web.Response(body=data, content_type="image/jpeg",
                            headers={"Cache-Control": "no-store"})

    async def index(request):
        now = time.time()
        lines = [f"{g.name}.jpg  {'%.0fs ago' % (now - g.updated) if g.updated else 'none yet'}"
                 for g in grabbers]
        return web.Response(text="\n".join(lines) + "\n")

    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/{name}.jpg", snapshot)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    log.info("serving snapshots on port %d for %s", PORT, ", ".join(by_name))
    while True:
        await asyncio.sleep(3600)


async def main():
    if not CAMERAS:
        log.error("No cameras in SNAPSHOT_CAMERAS; nothing to do.")
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    grabbers = [Grabber(name) for name in CAMERAS]
    await asyncio.gather(serve(grabbers), *(g.run() for g in grabbers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
