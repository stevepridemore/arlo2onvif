# Arlo to UniFi Protect bridge (Home Assistant add-ons)

A Home Assistant add-on repository with three add-ons that take the wired Arlo cameras (front
door doorbell, front yard, back yard) and present each one to UniFi Protect
as a virtual ONVIF camera, so Protect records them on the UDM SE alongside
the G5 Bullet.

```
Arlo cloud ──(pyaarlo login, same as the aarlo integration)──┐
                                                             ▼
  [2] Streamer ── ffmpeg ──► [1] RTSP Relay (MediaMTX) ──► [3] Virtual ONVIF cameras
        │  motion + keepalive          :8555                    192.168.40.41/.42/.43
        └── Mosquitto ── arlo/motion/<cam> ──────────────────────┤ ONVIF + RTSP :8554
                                                                 │ ONVIF Events :8181+
                                                                 ▼
                                                          UniFi Protect (UDM SE)
```

| Folder | Add-on | Does |
|---|---|---|
| `arlo_mediamtx` | Arlo Bridge 1 - RTSP Relay | MediaMTX. Receives the streams, serves plain RTSP on port 8555. |
| `arlo_streamer` | Arlo Bridge 2 - Streamer | arlo-streamer (pyaarlo + ffmpeg) plus a keepalive that holds the wired cameras in continuous streaming and restarts a stalled stream. |
| `arlo_onvif_proxy` | Arlo Bridge 3 - Virtual ONVIF Cameras | onvif-server. One macvlan interface per camera with its own MAC and IP, ONVIF discovery, RTSP proxy to the relay, plus an ONVIF Events service that turns Arlo's own motion detection (via MQTT) into standard camera motion events for Protect. |

Everything stays on the Home Assistant box. Nothing is exposed to the
internet. The virtual cameras are reachable only on the LAN.

## Before you start

- Home Assistant OS with the **Samba share** and **Mosquitto broker** add-ons
  (both already installed here).
- UniFi Protect 5.0 or newer. The UDM SE is on 7.3.70.
- The three Arlo cameras on mains power. Battery-only cameras cannot stream
  continuously and will not behave in Protect.
- An MQTT user for the bridge. In Home Assistant go to Settings > People >
  Users, add a user such as `arlo_bridge` (not an administrator), and give it
  a password. The Mosquitto add-on accepts Home Assistant users.
- A Gmail **app password** for the account that receives Arlo's 2FA codes.
  The aarlo integration already uses one; the same IMAP login works here.
  Arlo's 2FA email must be set to that mailbox.

## Install

### From this repository (normal way)

1. In Home Assistant: Settings > Add-ons > Add-on Store > three-dot menu >
   **Repositories**. Paste the repository URL
   (`https://github.com/stevepridemore/arlo2onvif`) and click Add.
2. The store now shows an "Arlo to UniFi Protect bridge" section with the
   three add-ons. If it does not appear, use the three-dot menu >
   **Check for updates**.
3. Install them in order 1, 2, 3. Each one builds from its Dockerfile on the
   box, which takes a few minutes the first time.

The Supervisor clones the repository anonymously, so it must be public (or
reachable without credentials). Nothing in it is secret; the credentials go
in the add-on options, not the repository.

### Local copy (alternative, no GitHub needed)

Copy the three add-on folders (`arlo_mediamtx`, `arlo_streamer`,
`arlo_onvif_proxy`) into the `addons` Samba share on the Home Assistant box
(`\\192.168.40.7\addons\`), then Add-on Store > three-dot menu >
**Check for updates**. They appear under "Local add-ons".

## Configure and start

### 1. RTSP Relay

No options. Start it. On the Info tab, make sure both ports are enabled
(8555 and 9997). Turn on **Start on boot** and **Watchdog**.

The streams have no credentials. The control API on 9997 only answers
callers from the add-on network (172.30.32.0/23) and the house LAN
(192.168.40.0/24); that list is in `mediamtx.yml` if the LAN ever changes.

### 2. Streamer

Fill in on the Configuration tab. The password fields are stored by the
Supervisor on the box and never shown again.

| Option | Value |
|---|---|
| `arlo_user` / `arlo_pass` | The Arlo account login, same as the aarlo integration uses. |
| `imap_host` / `imap_user` / `imap_pass` | `imap.gmail.com`, the Gmail address, the Gmail app password. |
| `mqtt_host` / `mqtt_port` | `core-mosquitto` and `1883`. |
| `mqtt_user` / `mqtt_pass` | The `arlo_bridge` Home Assistant user. |
| `rtsp_publish_url` | `rtsp://192.168.40.7:8555` (the relay, by the box's LAN IP). |
| `mediamtx_api_url` | `http://192.168.40.7:9997`. |
| `cameras` | arlo-streamer names: the Arlo camera name, lower-cased, spaces to underscores. The defaults match "Front Door", "Front Yard" and "Back yard". |

The rest can stay at their defaults. `motion_timeout` is set high (3600) so
a motion event cannot knock a camera out of continuous streaming for more
than a minute before the keepalive puts it back.

Start it, then watch the Log tab. Expect, in order: the Arlo login
(including "tfa" lines while it fetches the email code), "Camera added:
front_door" etc., "front_door availaible, starting stream", then
"front_door state: streaming" within about a minute as the keepalive kicks
in. Turn on **Start on boot** and **Watchdog**.

If the first login fails with a 2FA error, check that Arlo's 2FA method is
email to the IMAP mailbox and that the app password is right. The session
is cached under the add-on's data folder, so later restarts do not need a
new code.

### 3. Virtual ONVIF Cameras

Defaults are set for this network. Check these before starting:

| Option | Default | Notes |
|---|---|---|
| `parent_interface` | empty (auto) | The box's LAN interface, detected from the default route. Set it only if the log says it could not detect one. |
| `mediamtx_host` / `mediamtx_rtsp_port` | `192.168.40.7` / `8555` | The relay. |
| `events_enabled` / `events_port_base` | `true` / `8181` | ONVIF Events service, one port per camera (8181, 8182, 8183). This is how Protect gets motion; see below. |
| `mqtt_host` / `mqtt_port` / `mqtt_user` / `mqtt_pass` | `192.168.40.7` / `1883` | Mosquitto, by the box's LAN IP (this add-on runs on the host network, so `core-mosquitto` does not resolve). Same `arlo_bridge` user as the Streamer. |
| `mqtt_motion_topic` | `arlo/motion/{name}` | Where the Streamer publishes motion; `{name}` is the camera `path`. |
| `motion_hold_seconds` | `90` | If Arlo never sends "motion ended", clear it after this long. |
| `emit_motion_alarm` | `false` | Also send the older `tns1:VideoSource/MotionAlarm` topic. Try it only if Protect ignores the default `RuleEngine/CellMotionDetector/Motion` topic. |
| `cameras[].ip` | `.41`, `.42`, `.43` | Must be outside the UniFi DHCP pool (which starts at `.51`) and unused. |
| `cameras[].mac` | `a2:a2:a2:a2:a2:a1` to `a3` | Locally administered MACs. Change only if they collide with something. |
| `cameras[].path` | `front_door` ... | Must match the Streamer's camera names. |
| `cameras[].width/height/framerate/bitrate` | doorbell 1080x1080, yards 1920x1080, 24 fps, 2048 kb/s | Protect only uses these for display. If a stream looks wrong, check the real values in VLC against `rtsp://192.168.40.7:8555/front_door`. |

The add-on asks for the NET_ADMIN, NET_RAW and SYS_ADMIN capabilities (the
first two create the virtual interfaces, the third lets it set two ARP
sysctls on the host so Protect does not see the host's MAC for every camera
and merge them into one). Protection mode can stay on; the Supervisor
grants these from the add-on's own configuration.

Start it. The log should show each `onvifN` interface being created, then
"Starting virtual onvif server for Arlo Front Door on 192.168.40.41:8081"
and so on, a TCP proxy from 8554 to the relay, then "ONVIF events at
http://192.168.40.41:8181/onvif/events_service" for each camera and "MQTT
connected". Turn on **Start on boot** and **Watchdog**.

Open UniFi Network and confirm three new clients appear with the virtual
MACs. Giving each a fixed IP in UniFi is optional since they are static
already, but it stops UniFi flagging them.

## Adopt in Protect

1. Protect > Devices. The three cameras appear as "Onvif Cardinal" devices
   waiting for adoption. If they do not show within a minute, use
   Add Device > Third-party camera and enter the IP (`192.168.40.41`) and
   port (`8081`, `8082`, `8083` respectively).
2. Username and password: anything, for example `arlo` / `arlo`. The virtual
   device does not check them.
3. Rename each camera in Protect to match the real one.
4. Set the recording mode. Continuous is fine; the stream is always on.
   "Detections" mode also works, because motion comes from Arlo (next
   section).

## How motion reaches Protect

Since Protect 7.1, Protect takes motion for third-party cameras from the
camera's own ONVIF Events service and does no motion detection of its own
on the video. The bridge therefore runs an Events service per virtual
camera. When Arlo detects motion, the Streamer publishes it on
`arlo/motion/<camera>`, the ONVIF add-on turns that into the standard
`tns1:RuleEngine/CellMotionDetector/Motion` property event (the same shape
Hikvision cameras send, which Protect is known to accept), and Protect marks
the timeline, records in Detections mode, and can raise alarms. Smart
detections (person, vehicle) are not passed through; Protect ignores them
from third-party cameras.

To check it is flowing, watch the ONVIF add-on log while someone walks past
a camera: you should see "front_door: motion started" when Arlo reports it
and a subscription line from Protect's address (192.168.40.1) shortly after
adoption. If Protect never subscribes, re-adopt the camera after the add-on
is up, so Protect sees the Events capability.

## What to expect

- Arlo's cloud still ends every live stream after roughly 30 minutes. The
  Streamer reopens it within seconds; Protect shows a brief gap each time.
- Video is passed through unchanged (H.264 at whatever the Arlo cloud sends,
  normally 1080p). Audio is re-encoded to AAC.
- Each camera is a second login on the Arlo account, next to the aarlo
  integration. If Arlo logs one of them out, both add-on and integration
  recover on their own, but you may see a 2FA email.
- Protect's smart detections do not run on third-party cameras. Motion
  events come from Arlo through the Events service, so motion recording and
  timeline markers work, with Arlo's own detection zones and sensitivity.

## Troubleshooting

| Symptom | Check |
|---|---|
| Streamer log says "No stream available" repeatedly | The camera is offline in Arlo, or Arlo is refusing streams. Open it in the Arlo app once. |
| Camera stays in `idle` in the Streamer log | Keepalive cannot reach MQTT. Check `mqtt_user`/`mqtt_pass` and that Mosquitto is running. |
| ONVIF add-on log says "RTNETLINK answers: Operation not permitted" | It cannot create the virtual interfaces. Update to 1.0.1 or later (Add-on Store > Check for updates), then start it again. |
| Every Protect camera shows the same video | The ARP sysctls failed (the ONVIF add-on log says so). Update to 1.0.3 or later, which remounts /proc/sys to set them. |
| Protect says the stream is unavailable | From a PC, open `rtsp://192.168.40.41:8554/front_door` in VLC. If that works, re-adopt in Protect. If not, check the relay at `rtsp://192.168.40.7:8555/front_door`. |
| Stream freezes and never recovers | The keepalive restarts a stream after `stall_seconds` with no bytes. Lower it, or raise `pyaarlo_reconnect_every` to 110 if the Streamer log shows the Arlo event channel going quiet. |
| Virtual interfaces missing after a reboot | The add-on recreates them every start. If it is not starting on boot, enable Start on boot. |
| No motion in Protect | ONVIF add-on log: is "MQTT connected" there, and does "motion started" appear when the Arlo app shows motion? If MQTT is fine but Protect shows nothing, re-adopt the camera, then try `emit_motion_alarm: true`. |
| Motion in Protect never ends | Arlo did not send "motion ended"; `motion_hold_seconds` clears it. Lower it if clips run long. |

## Removing it

Stop and uninstall the three add-ons; the macvlan interfaces are removed when
the ONVIF add-on stops. Remove the cameras from Protect. Delete the
`arlo_bridge` user if you created one. The Arlo session cache lives in the
Streamer add-on's data folder and is deleted with the add-on.

## Sources

- arlo-streamer: https://github.com/kaffetorsk/arlo-streamer (pinned to v0.10.3)
- onvif-server: https://github.com/daniela-hase/onvif-server (main branch)
- MediaMTX: https://github.com/bluenviron/mediamtx (1.21.3)
