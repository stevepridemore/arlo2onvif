#!/usr/bin/env bash
# Entrypoint for the Arlo Bridge Streamer add-on.
# Turns /data/options.json into the environment arlo-streamer expects,
# then runs arlo-streamer and the keepalive side by side.
set -euo pipefail
cd /app

OPTIONS=/data/options.json
if [ ! -f "$OPTIONS" ]; then
    echo "ERROR: $OPTIONS not found; is this running as a Home Assistant add-on?" >&2
    exit 1
fi

# Export add-on options as environment variables.
eval "$(python3 - "$OPTIONS" <<'PY'
import json, shlex, sys
o = json.load(open(sys.argv[1]))

publish = o["rtsp_publish_url"].rstrip("/")
env = {
    "ARLO_USER": o["arlo_user"],
    "ARLO_PASS": o["arlo_pass"],
    "IMAP_HOST": o["imap_host"],
    "IMAP_USER": o["imap_user"],
    "IMAP_PASS": o["imap_pass"],
    "MQTT_BROKER": o["mqtt_host"],
    "MQTT_PORT": o["mqtt_port"],
    "MQTT_USER": o.get("mqtt_user") or "",
    "MQTT_PASS": o.get("mqtt_pass") or "",
    # Video is copied as-is; audio is re-encoded to match what the ONVIF
    # profile declares (aac by default; g711 = PCM mu-law 8 kHz; none).
    "FFMPEG_OUT": (
        "-c:v copy "
        + (f"-af volume={int(o.get('audio_gain_db', 0) or 0)}dB " if int(o.get("audio_gain_db", 0) or 0) else "")
        + {"aac": "-c:a aac -ar 16000 -b:a 32k ",
           "g711": "-c:a pcm_mulaw -ar 8000 -ac 1 ",
           "none": "-an "}.get(str(o.get("audio_codec", "aac")).lower(), "-c:a aac -ar 16000 -b:a 32k ")
        + f"-f rtsp -rtsp_transport tcp {publish}/{{name}}"
    ),
    "MOTION_TIMEOUT": o["motion_timeout"],
    "STATUS_INTERVAL": o["status_interval"],
    "PYAARLO_BACKEND": o["pyaarlo_backend"],
    "PYAARLO_REFRESH_DEVICES": o["pyaarlo_refresh_devices"],
    "PYAARLO_STREAM_TIMEOUT": o["pyaarlo_stream_timeout"],
    "PYAARLO_RECONNECT_EVERY": o["pyaarlo_reconnect_every"],
    "PYAARLO_STORAGE_DIR": "/data/pyaarlo",
    "DEBUG": str(bool(o["debug"])).lower(),
    "KEEPALIVE_CAMERAS": ",".join(o["cameras"]),
    "KEEPALIVE_INTERVAL": o["keepalive_interval"],
    "STALL_SECONDS": o["stall_seconds"],
    "MEDIAMTX_API_URL": o["mediamtx_api_url"],
    # Video motion detection (motion.py)
    "VIDEO_MOTION": str(bool(o.get("video_motion", True))).lower(),
    "MOTION_CAMERAS": ",".join(o["cameras"]),
    "MOTION_RTSP_URL": publish,
    "MOTION_TOPIC": o.get("motion_topic") or "bridge/motion/{name}",
    "MOTION_SENSITIVITY": o.get("motion_sensitivity", 50),
    "MOTION_END_SECONDS": o.get("motion_end_seconds", 8),
    "MOTION_DEBUG": str(bool(o.get("motion_debug", False))).lower(),
    # Snapshot thumbnails (snapshots.py)
    "SNAPSHOTS": str(bool(o.get("snapshots", True))).lower(),
    "SNAPSHOT_CAMERAS": ",".join(o["cameras"]),
    "SNAPSHOT_RTSP_URL": publish,
    "SNAPSHOT_INTERVAL": o.get("snapshot_interval", 10),
    "SNAPSHOT_PORT": 8580,
    "SNAPSHOT_DIR": "/tmp/snapshots",
}
for key, value in env.items():
    # Leave MQTT auth unset (not empty) so arlo-streamer connects anonymously.
    if key in ("MQTT_USER", "MQTT_PASS") and value == "":
        continue
    print(f"export {key}={shlex.quote(str(value))}")
PY
)"

for required in ARLO_USER ARLO_PASS IMAP_USER IMAP_PASS; do
    if [ -z "${!required:-}" ]; then
        echo "ERROR: option for $required is empty; fill it in on the add-on's Configuration tab." >&2
        exit 1
    fi
done

mkdir -p /data/pyaarlo

echo "Starting arlo-streamer (publishing to ${FFMPEG_OUT##* })"
python3 main.py &
MAIN_PID=$!

echo "Starting keepalive for cameras: ${KEEPALIVE_CAMERAS}"
python3 keepalive.py &
KEEP_PID=$!
PIDS=("$MAIN_PID" "$KEEP_PID")

if [ "${VIDEO_MOTION}" = "true" ]; then
    echo "Starting video motion detection (sensitivity ${MOTION_SENSITIVITY}, topic ${MOTION_TOPIC})"
    python3 motion.py &
    PIDS+=("$!")
fi

if [ "${SNAPSHOTS}" = "true" ]; then
    echo "Starting snapshot thumbnails (every ${SNAPSHOT_INTERVAL}s, port ${SNAPSHOT_PORT})"
    python3 snapshots.py &
    PIDS+=("$!")
fi

shutdown() {
    echo "Stopping..."
    kill -TERM "${PIDS[@]}" 2>/dev/null || true
    wait "${PIDS[@]}" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

# If any process dies, exit non-zero so the Supervisor watchdog restarts us.
wait -n "${PIDS[@]}"
echo "A child process exited unexpectedly; shutting down." >&2
kill -TERM "${PIDS[@]}" 2>/dev/null || true
exit 1
