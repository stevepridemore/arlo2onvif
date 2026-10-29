#!/usr/bin/env bash
# Entrypoint for the Arlo Bridge Virtual ONVIF Cameras add-on.
#
# 1. Creates one macvlan interface per camera on the host's LAN interface,
#    each with its own MAC and IP, so UniFi Protect sees separate devices.
# 2. Generates /onvif.yaml from the add-on options.
# 3. Runs onvif-server (device + media services, RTSP proxy to the relay)
#    and the ONVIF Events service (motion from Arlo over MQTT) side by side.
set -euo pipefail

OPTIONS=/data/options.json
if [ ! -f "$OPTIONS" ]; then
    echo "ERROR: $OPTIONS not found; is this running as a Home Assistant add-on?" >&2
    exit 1
fi

PARENT=$(jq -r '.parent_interface // ""' "$OPTIONS")
if [ -z "$PARENT" ]; then
    PARENT=$(ip -o -4 route show default | awk '{print $5}' | head -n 1)
fi
if [ -z "$PARENT" ]; then
    echo "ERROR: could not detect the LAN interface; set parent_interface in the options." >&2
    exit 1
fi
PREFIX=$(ip -o -4 addr show dev "$PARENT" | awk '{print $4}' | head -n 1 | cut -d/ -f2)
PREFIX=${PREFIX:-24}

MTX_HOST=$(jq -r '.mediamtx_host' "$OPTIONS")
MTX_PORT=$(jq -r '.mediamtx_rtsp_port' "$OPTIONS")
RTSP_PORT=$(jq -r '.rtsp_port' "$OPTIONS")
PORT_BASE=$(jq -r '.onvif_port_base' "$OPTIONS")
EVENTS_ENABLED=$(jq -r '.events_enabled // true' "$OPTIONS")
SNAP_ENABLED=$(jq -r '.snapshots_enabled // true' "$OPTIONS")
AUDIO_ENABLED=$(jq -r '.audio_enabled // true' "$OPTIONS")
AUDIO_ENCODING=$(jq -r '.audio_encoding // "AAC"' "$OPTIONS")
SNAP_PORT=$(jq -r '.snapshot_port // 8580' "$OPTIONS")
SNAP_TARGET_PORT=$(jq -r '.snapshot_target_port // 8581' "$OPTIONS")
COUNT=$(jq '.cameras | length' "$OPTIONS")

if [ "$COUNT" -eq 0 ]; then
    echo "ERROR: no cameras configured." >&2
    exit 1
fi

# MQTT settings for the events service (motion source).
export EVENTS_MQTT_URL="mqtt://$(jq -r '.mqtt_host' "$OPTIONS"):$(jq -r '.mqtt_port // 1883' "$OPTIONS")"
export EVENTS_MQTT_USER=$(jq -r '.mqtt_user // ""' "$OPTIONS")
export EVENTS_MQTT_PASS=$(jq -r '.mqtt_pass // ""' "$OPTIONS")
export EVENTS_MQTT_TOPIC=$(jq -r '.mqtt_motion_topic // "bridge/motion/{name},arlo/motion/{name}"' "$OPTIONS")
export EVENTS_MOTION_HOLD=$(jq -r '.motion_hold_seconds // 90' "$OPTIONS")
export EVENTS_EMIT_MOTION_ALARM=$(jq -r '.emit_motion_alarm // false' "$OPTIONS")
export EVENTS_DEBUG=$(jq -r '.debug // false' "$OPTIONS")

echo "Parent interface: $PARENT (/$PREFIX); relay: ${MTX_HOST}:${MTX_PORT}; ${COUNT} camera(s); events: ${EVENTS_ENABLED}"

# Make each virtual MAC answer ARP only for its own IP. Without this, Protect
# can see the host's MAC for every camera and merge them into one.
# /proc/sys is mounted read-only in add-on containers; with SYS_ADMIN we can
# remount it read-write for the two writes we need.
mount -o remount,rw /proc/sys 2>/dev/null || true
if sysctl -w net.ipv4.conf.all.arp_ignore=1 net.ipv4.conf.all.arp_announce=2 >/dev/null 2>&1; then
    echo "ARP sysctls set (arp_ignore=1, arp_announce=2)."
else
    echo "WARNING: could not set arp_ignore/arp_announce (SYS_ADMIN capability missing?)." >&2
    echo "         If Protect shows the same video for every camera, this is why." >&2
fi
mount -o remount,ro /proc/sys 2>/dev/null || true

LINKS=()
PIDS=()
cleanup() {
    echo "Stopping..."
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
    done
    echo "Removing virtual interfaces..."
    for link in "${LINKS[@]:-}"; do
        [ -n "$link" ] && ip link del "$link" 2>/dev/null || true
    done
}
trap 'cleanup; exit 0' TERM INT

# --- 1. Virtual interfaces -------------------------------------------------
for ((i = 0; i < COUNT; i++)); do
    name=$(jq -r ".cameras[$i].name" "$OPTIONS")
    mac=$(jq -r ".cameras[$i].mac" "$OPTIONS" | tr 'A-F' 'a-f')
    ip_addr=$(jq -r ".cameras[$i].ip" "$OPTIONS")
    link="onvif${i}"

    ip link del "$link" 2>/dev/null || true
    if ! ip link add "$link" link "$PARENT" address "$mac" type macvlan mode bridge; then
        echo "ERROR: cannot create virtual interface $link on $PARENT." >&2
        echo "       The add-on lacks the NET_ADMIN capability. Make sure you are running add-on" >&2
        echo "       version 1.0.1 or later (Add-on Store > Check for updates), then start it again." >&2
        exit 1
    fi
    ip addr add "${ip_addr}/${PREFIX}" dev "$link"
    ip link set "$link" up
    LINKS+=("$link")
    echo "  $link -> $name  $mac  $ip_addr"
done

# --- 2. onvif-server config --------------------------------------------------
{
    echo "onvif:"
    for ((i = 0; i < COUNT; i++)); do
        name=$(jq -r ".cameras[$i].name" "$OPTIONS")
        path=$(jq -r ".cameras[$i].path" "$OPTIONS")
        mac=$(jq -r ".cameras[$i].mac" "$OPTIONS" | tr 'A-F' 'a-f')
        uuid=$(jq -r ".cameras[$i].uuid" "$OPTIONS")
        width=$(jq -r ".cameras[$i].width" "$OPTIONS")
        height=$(jq -r ".cameras[$i].height" "$OPTIONS")
        fps=$(jq -r ".cameras[$i].framerate" "$OPTIONS")
        bitrate=$(jq -r ".cameras[$i].bitrate" "$OPTIONS")
        port=$((PORT_BASE + i))
        cat <<EOF
  - mac: "${mac}"
    ports:
      server: ${port}
      rtsp: ${RTSP_PORT}
EOF
        if [ "$SNAP_ENABLED" = "true" ]; then
            cat <<EOF
      snapshot: ${SNAP_PORT}
EOF
        fi
        if [ "$EVENTS_ENABLED" = "true" ]; then
            cat <<EOF
    events:
      source: ${path}
EOF
        fi
        snap_line=""
        snap_target=""
        if [ "$SNAP_ENABLED" = "true" ]; then
            snap_line="      snapshot: /${path}.jpg"
            snap_target="        snapshot: ${SNAP_TARGET_PORT}"
        fi
        cat <<EOF
    name: "${name}"
    uuid: ${uuid}
    audio: ${AUDIO_ENABLED}
    audioEncoding: ${AUDIO_ENCODING}
    highQuality:
      rtsp: /${path}
${snap_line}
      width: ${width}
      height: ${height}
      framerate: ${fps}
      bitrate: ${bitrate}
      quality: 4
    lowQuality:
      rtsp: /${path}
${snap_line}
      width: ${width}
      height: ${height}
      framerate: ${fps}
      bitrate: ${bitrate}
      quality: 1
    target:
      hostname: ${MTX_HOST}
      ports:
        rtsp: ${MTX_PORT}
${snap_target}
EOF
    done
} > /onvif.yaml

# --- 3. Run ------------------------------------------------------------------
cd /app
# The events service runs inside onvif-server (events-bridge.js), on the
# device port, when EVENTS_MQTT_URL is set. Clear it to disable events.
if [ "$EVENTS_ENABLED" != "true" ]; then
    unset EVENTS_MQTT_URL
fi
if [ "$EVENTS_DEBUG" = "true" ]; then
    node main.js -d /onvif.yaml &
else
    node main.js /onvif.yaml &
fi
PIDS+=("$!")

# If any process dies, stop everything so the Supervisor watchdog restarts us.
wait -n "${PIDS[@]}" || true
echo "A process exited unexpectedly; shutting down." >&2
cleanup
exit 1
