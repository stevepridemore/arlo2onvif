"""
Build-time patch for arlo-streamer's camera.py.

The proxy ffmpeg (the long-running process that publishes to the relay) reads
an MPEG-TS pipe fed alternately by the idle-video process and the live Arlo
process. Arlo's cloud streams carry timestamp jumps, and every switch between
idle and live restarts timestamps from zero. The RTSP muxer is strict about
monotonic timestamps, so the proxy dies on each jump, restarts, and the relay
path flaps. Regenerating timestamps from the wall clock on the proxy's input
makes them monotonic regardless of what arrives on the pipe.

Fails the build if the upstream line no longer matches.
Usage: python3 patch-arlo-streamer.py /app/camera.py
"""
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/app/camera.py"
src = open(path, encoding="utf-8").read()

PATCHES = [
    # 1. Proxy ffmpeg: the long-running publisher reading the shared pipe.
    (
        "*(['ffmpeg', '-i', 'pipe:'] + self.ffmpeg_out),",
        "*(['ffmpeg', '-fflags', '+genpts+discardcorrupt',\n"
        "                  '-use_wallclock_as_timestamps', '1',\n"
        "                  '-i', 'pipe:'] + self.ffmpeg_out),",
        "proxy ffmpeg line",
    ),
    # 2. Live ffmpeg: reads the Arlo cloud rtsps stream, whose timestamps jump
    #    backwards; the MPEG-TS muxer is strict and exits on that.
    (
        "*['ffmpeg', '-i', stream, '-c:v', 'copy',",
        "*['ffmpeg', '-fflags', '+genpts+discardcorrupt',\n"
        "                  '-use_wallclock_as_timestamps', '1',\n"
        "                  '-rtsp_transport', 'tcp',\n"
        "                  '-i', stream, '-c:v', 'copy',",
        "live ffmpeg line",
    ),
]

for anchor, replacement, label in PATCHES:
    count = src.count(anchor)
    if count != 1:
        print(f"patch-arlo-streamer: expected exactly one {label}, found {count}", file=sys.stderr)
        sys.exit(1)
    src = src.replace(anchor, replacement)

open(path, "w", encoding="utf-8").write(src)
print(f"patch-arlo-streamer: patched {path} ({len(PATCHES)} edits)")
