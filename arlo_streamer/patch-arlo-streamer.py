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
    # 3. Live ffmpeg: always capture stderr (drained by _log_stderr, which
    #    keeps the last lines), watch the process, and say so at WARNING level
    #    when Arlo gives no stream.
    (
        "                stdin=subprocess.DEVNULL,\n"
        "                stdout=self.proxy_writer,\n"
        "                stderr=subprocess.PIPE if DEBUG else subprocess.DEVNULL\n"
        "                )\n"
        "\n"
        "            if DEBUG:\n"
        "                asyncio.create_task(\n"
        "                    self._log_stderr(self.stream, 'live_stream')\n"
        "                    )\n"
        "        else:\n"
        "            logging.debug(f\"{self.name}: No stream available.\")",
        "                stdin=subprocess.DEVNULL,\n"
        "                stdout=self.proxy_writer,\n"
        "                stderr=subprocess.PIPE\n"
        "                )\n"
        "\n"
        "            asyncio.create_task(\n"
        "                self._log_stderr(self.stream, 'live_stream')\n"
        "                )\n"
        "            asyncio.create_task(self._watch_live(self.stream))\n"
        "        else:\n"
        "            logging.warning(f\"{self.name}: No stream available from Arlo.\")",
        "live ffmpeg stderr/else block",
    ),
    # 4. _log_stderr keeps the last few lines per label for the exit report.
    (
        "                line = await stream.stderr.readline()\n"
        "                if line:\n"
        "                    logging.debug(\n"
        "                        f\"{self.name} - {label}: {line.decode().strip()}\"\n"
        "                        )",
        "                line = await stream.stderr.readline()\n"
        "                if line:\n"
        "                    text = line.decode(errors='replace').strip()\n"
        "                    if not hasattr(self, '_stderr_tail'):\n"
        "                        self._stderr_tail = {}\n"
        "                    tail = self._stderr_tail.setdefault(label, [])\n"
        "                    tail.append(text)\n"
        "                    del tail[:-5]\n"
        "                    logging.debug(\n"
        "                        f\"{self.name} - {label}: {text}\"\n"
        "                        )",
        "_log_stderr line handling",
    ),
    # 5. Restart the live ffmpeg if it exits while the camera should stream.
    (
        "    async def _stream_timeout(self):",
        "    async def _watch_live(self, proc):\n"
        "        \"\"\"\n"
        "        Restart the live ffmpeg if it exits while we still want to stream\n"
        "        (Arlo ended the stream, network hiccup, muxer error...).\n"
        "        \"\"\"\n"
        "        code = await proc.wait()\n"
        "        if self.stream is not proc or self.get_state() != 'streaming':\n"
        "            return\n"
        "        tail = getattr(self, '_stderr_tail', {}).get('live_stream', [])\n"
        "        logging.warning(\n"
        "            f\"{self.name}: live stream ffmpeg exited (code {code}); \"\n"
        "            f\"last output: {' | '.join(tail[-3:]) or 'none'}\"\n"
        "            )\n"
        "        await asyncio.sleep(3)\n"
        "        if self.stream is proc and self.get_state() == 'streaming':\n"
        "            logging.info(f\"{self.name}: restarting live stream\")\n"
        "            await self._start_stream()\n"
        "\n"
        "    async def _stream_timeout(self):",
        "_stream_timeout anchor for _watch_live",
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
