# Orbital-Compatible API Server Specification

## 1. Scope and status

This document specifies the server required by Neato robots. It is not an HTTP/OpenAPI API: the robot uses a persistent, bidirectional TLS/TCP connection with length-prefixed JSON messages.

The words **MUST**, **SHOULD**, and **MAY** describe compatibility requirements. The structures below distinguish fields constructed or validated by Tron software from fields passed through to the robot IPC.

This specification does not define a mobile-app API, account authentication, or an administrative API.

## 2. Endpoint and transport

The client opens an IPv4 TCP connection on port `3443` and upgrades it directly to TLS (there is no HTTP or WebSocket handshake). The production hostname is derived as follows:

- Production: `orbital.<vendor-host>`
- Other environments: `orbital-<environment>.<vendor-host>`

Known configured hosts are `neatocloud.com` for vendor `N`, `ksecosys.com` for vendor `3`, and `orbital.professional.vorwerk.com` for vendors `1` and `2`. The prefixing rule is literal: for example, production vendor `N` becomes `orbital.neatocloud.com`, while production vendors `1` and `2` become `orbital.orbital.professional.vorwerk.com`. Deployments MAY override the client configuration instead of reproducing public DNS.

The server certificate MUST validate against the certificate configured for the vendor and  MUST match the selected hostname.

## 3. Framing

Every application frame is:

```text
+----------------------+--------------------------+
| 4-byte payload size  | payload                  |
| unsigned, big-endian | exactly size bytes       |
+----------------------+--------------------------+
```

Normal payloads are UTF-8 encoded JSON objects. Two one-byte control payloads are reserved:

| Payload | Meaning |
| --- | --- |
| `0x06` | Heartbeat |
| `0x00` | Graceful close |

The length prefix for either control frame is therefore `00 00 00 01`. The server MUST handle partial TCP/TLS reads and multiple frames in one read. It SHOULD send the prefix and payload together because the client assumes its four-byte header arrives in one socket read. A zero-length frame MUST NOT be sent.

Writes on one connection MUST be serialized so concurrent responses cannot interleave. Implementations SHOULD impose a configurable defensive frame limit; the client itself imposes none.

## 4. Session lifecycle and login

The session state is `TLS connected -> login pending -> authenticated -> closed`.

The first frame is a login object without a `type` field:

```json
{
  "vendor": "N",
  "datetime": "2026-10-06T12:34:56.123456Z",
  "serial": "BOARD-SERIAL",
  "signature": "BASE64_RSA_SIGNATURE",
  "firmware": "4.5.3-189"
}
```

Despite its name, `serial` contains the **board serial number**, not the consumer-facing robot serial. The signature is Base64-encoded RSA PKCS#1 v1.5 with SHA-256 over these exact UTF-8 bytes:

```text
lowercase(vendor) + "\n" + lowercase(board_serial) + "\n" + datetime
```

The server MUST maintain a robot registry keyed by vendor and board serial with the corresponding RSA public key. It MUST verify the signature before accepting the session. It SHOULD parse the UTC timestamp, enforce a small clock-skew window, and reject replayed login tuples.

Successful login response:

```json
{
  "code": 200,
  "body": {
    "ip_address": "203.0.113.10",
    "timezone": "Europe/London"
  }
}
```

`body.ip_address` is optional. `body.timezone` SHOULD be a valid non-empty IANA time-zone name; it MAY be `null`. Any code other than `200` causes disconnect and retry. The response does not need a `type` or `id`.

Immediately after login the client sends its current state. The server MUST accept authenticated sessions for robots not yet associated with a user because `robots.link` happens after login.

The robot normally sends a heartbeat every 60 seconds and disconnects if it receives no frame for more than 70 seconds. The server MUST send a heartbeat or another frame at least once per 60 seconds. Receipt of `0x00` SHOULD close the session without sending another application message. Unexpected EOF, invalid JSON, or an authentication failure SHOULD close the connection.

## 5. Authenticated message envelope

### Request

```json
{
  "type": "request",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "to": {"service": "firmware.check"},
  "body": {}
}
```

### Response

```json
{
  "type": "response",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "code": 200,
  "body": {}
}
```

### Event

```json
{
  "type": "event",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "to": {"service": "peer.state"},
  "body": {}
}
```

IDs are strings, normally UUIDs. A response MUST copy the request ID exactly. Fields whose value would be `null` are commonly omitted. `body` may contain any JSON value, although server-to-robot ability requests MUST use an object.

The robot accepts only `request` and `response` messages from the server. A server-originated `event`, unknown `type`, non-object top level, or malformed JSON causes message processing to fail and normally reconnect. The server MUST NOT send events to the robot.

Request IDs are correlated per direction. The server SHOULD keep independent pending-request maps for server-originated and robot-originated calls. It MUST allow concurrent calls and out-of-order responses. Robot-originated calls time out after 30 seconds, so the server SHOULD reply well before then.

## 6. Server-to-robot ability commands

To invoke a robot ability, send a request whose body contains `ability`. The `to` field is ignored by the client and SHOULD be omitted.

```json
{
  "type": "request",
  "id": "server-generated-id",
  "body": {
    "ability": "cleaning.pause"
  }
}
```

The server MUST send a non-empty string `id` and an object `body` containing a string `ability` in `<group>.<action>` form. For IPC-backed abilities Tron forwards the complete body unchanged, including `ability` and any extra fields, and copies the IPC response code and body into the Orbital response. Unless explicitly marked optional or nullable, every field shown in a command structure is required. Requirements may be enforced by Tron or by the matching robot IPC implementation, as noted.

The following scalar conventions are used in the command schemas:

| Name | JSON representation |
| --- | --- |
| UUID | Non-empty string. The current code uses UUID-shaped values but does not validate their syntax. |
| UTC timestamp | String in `YYYY-MM-DDTHH:MM:SSZ` form. |
| Encoded map | Base64 string containing compressed PGM map bytes. |
| Cleaning mode | `"eco"`, `"turbo"`, `"auto"`, or `"max"`. |
| Navigation mode | `"normal"` or `"gentle"`. |

An encoded map is the standard Base64 encoding (RFC 4648 alphabet with `=` padding, no line breaks) of the raw bytes of one of the robot's compressed PGM map files (`.pgm.nz`). It appears as `rank_binary` and `real_binary` in `maps.create`, `maps.promote_floorplan`, and `maps.update_floorplan`, and as `binary` in `nogo_track`/`cleaning_tracks` and as `track_binary` in `maps.save_track`. The client never parses this content: for `maps.create` and its own promotion call it Base64-encodes the local files unchanged, and for the track fields it passes the string to the robot IPC untouched. Tron therefore imposes no content, size, or decodability requirements of its own — a binary that is not valid Base64, or not a PGM file the robot accepts, fails only at the robot IPC. Conversely, a server that stores a binary and later returns it in `maps.promote_floorplan` or `maps.update_floorplan` MUST send it back byte-for-byte as received; the client's own promotion re-encodes the same local files, so what the robot accepts for a floor plan is exactly what it uploaded. The PGM layout itself (header, cell values, compression) is defined by the robot's mapping stack, not by Tron, and is outside this specification.

The configured command surface is:

| Ability/version | Actions |
| --- | --- |
| `debug` 1.0.0 | `echo_body`, `send_map` |
| `state` 1.1.1 | `show` |
| `cleaning` 1.2.1 | `start`, `pause`, `cancel`, `resume`, `show` |
| `extraction` 1.0.0 | `start` |
| `navigation` 1.0.0 | `return_to_base` |
| `scheduling` 1.0.0 | `show`, `add`, `update`, `delete` |
| `info` 1.0.0 | `abilities`, `robot`, `wifi` |
| `utilities` 1.1.0 | `find_me`, `light_ring`, `switch_env` |
| `maps` 1.2.0 | `promote_floorplan`, `demote_floorplan`, `update_floorplan`, `save_track`, `delete_track` |
| `settings` 1.1.0 | `robot_language`, `set_robot_language`, `sounds`, `set_sounds`, `factory_reset`, `cleaning_options`, `set_cleaning_options`, `ota_updates`, `set_ota_updates` |
| `logs` 1.0.0 | `request_upload` |
| `ota_update` 1.1.0 | `start`, `show` |

### 6.1 Cleaning and state commands

The shared cleaning structures are:

```text
CleaningSettings = {
  "mode": CleaningMode,
  "navigation_mode": NavigationMode
}

CleaningMap = {
  "rank_id": UUID,
  "track_id": UUID | null,
  "nogo_enabled": boolean
}

CleaningRun = {
  "settings": CleaningSettings,
  "map": CleaningMap | null
}
```

`map:null` selects non-persistent cleaning. A non-null map selects the promoted floor plan in `rank_id`; `track_id:null` means the entire floor plan and a non-null `track_id` means one zone. In a multi-zone request every run MUST use the same non-null `rank_id`, every referenced floor plan and track MUST already exist on the robot, and each track MUST belong to that floor plan.

`cleaning.start` has this body:

```json
{
  "ability": "cleaning.start",
  "force_floorplan": false,
  "runs": [
    {
      "settings": {
        "mode": "eco",
        "navigation_mode": "normal"
      },
      "map": {
        "rank_id": "fb7f8145-0615-4a32-8f0d-8d833cd51a5e",
        "track_id": null,
        "nogo_enabled": true
      }
    }
  ]
}
```

`runs` is required, non-null, and MUST be a non-empty array of `CleaningRun`. Tron only checks that it is non-null; an empty or malformed array fails later and normally returns `503`. `force_floorplan` is optional and defaults to `false`, but an Orbital-initiated start is classified as app-started and the robot replaces this value with its saved `settings.cleaning_options.force_floorplan` setting. Success is `200` with `{}`; invalid or unavailable maps return `422` with `{}`.

The `200` acknowledges the command, not the cleaning (verified against firmware 1.7.0-2933): the robot's command layer forwards a start to the navigation stack even when it already knows the start data is unusable, and a floor plan or track that then fails to load raises the `pm_load_fail` alert (severity `error`) and the run fails to start cleaning — after the `200` was sent. A server learns of the failure only asynchronously: through the `robots.error_codes` event and `robots.notify` message carrying `pm_load_fail`, through `pm_load_fail` appearing in `peer.state` `errors`, and through `cleaning.show` returning `503` because no session exists. A server MUST treat these signals, not the `200`, as the outcome of a start.

The other cleaning/state controls have no fields beyond `ability` unless stated:

| Ability | Successful response |
| --- | --- |
| `state.show` | `200` with the state structure in section 7.1, excluding the event-only `ability` field. |
| `cleaning.pause` | `200` with `{}`. |
| `cleaning.cancel` | `200` with `{}`. |
| `cleaning.resume` | `200` with `{}`. |
| `navigation.return_to_base` | `200` with `{}`. |
| `extraction.start` | `200` with `{}` after requesting extraction from a cleaning-center base. |
| `cleaning.show` | `200` with `CleaningSession` while cleaning is active; otherwise `503` with `{}`. |

`CleaningSession` has the following exact shape:

```json
{
  "started_by": "app",
  "floorplan_uuid": "fb7f8145-0615-4a32-8f0d-8d833cd51a5e",
  "timing": {
    "start": "2026-10-06T12:00:00Z",
    "end": null,
    "charging": 0,
    "error": 0,
    "paused": 12
  },
  "cleaning_type": "zone",
  "runs": [
    {
      "track_uuid": "888aa432-1067-2a25-9fd7-432169d2d556",
      "track_name": "Kitchen",
      "state": "in_progress",
      "timing": {
        "start": "2026-10-06T12:00:00Z",
        "end": null,
        "charging": 0,
        "error": 0,
        "paused": 12
      },
      "stats": {"area": 8.5, "pickup_count": 42},
      "settings": {"mode": "eco", "navigation_mode": "normal"}
    }
  ]
}
```

`started_by` is `app`, `button`, `schedule`, or `internal`; `cleaning_type` is `non_persistent`, `persistent`, or `zone`; and run `state` is `not_started`, `done`, `in_progress`, `not_reachable`, `canceled`, `paused`, `suspend_charging`, or `error`. `floorplan_uuid`, `track_uuid`, `track_name`, and each `end` may be `null`. Timing counters are integer seconds, `area` is numeric, and `pickup_count` is an integer.

### 6.2 Scheduling commands

`scheduling.add` and `scheduling.update` use the same body. `event.id` MAY be omitted to create a new event and SHOULD be supplied to replace an existing event. A successful response is `200` with `{}` and does not return the allocated ID; call `scheduling.show` to retrieve it.

```json
{
  "ability": "scheduling.add",
  "event": {
    "enabled": true,
    "days": ["mon", "wed", "fri"],
    "time": "09:30",
    "command": {
      "ability": "cleaning.start",
      "runs": [
        {
          "settings": {"mode": "eco", "navigation_mode": "normal"},
          "map": null
        }
      ]
    }
  }
}
```

`event.id`, when present, is a decimal string. `enabled` is Boolean, `days` is an array containing only `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, and `sun`, and `time` is a 24-hour `HH:MM` string from `00:00` through `23:59`. `event.command.ability` MUST be `cleaning.start`; `event.command.runs` uses `CleaningRun`. The `force_floorplan` and deprecated `auto_localization` fields may appear in the command returned by `scheduling.show`, but updates ignore both and use the robot's current cleaning option at execution time.

`scheduling.show` takes only `ability` and returns:

```json
{
  "enabled": true,
  "events": [
    {
      "id": "1",
      "enabled": true,
      "days": ["mon", "wed", "fri"],
      "time": "09:30",
      "command": {
        "ability": "cleaning.start",
        "auto_localization": false,
        "force_floorplan": false,
        "runs": [
          {
            "settings": {"mode": "eco", "navigation_mode": "normal"},
            "map": null
          }
        ]
      }
    }
  ]
}
```

`scheduling.delete` requires string `id` and returns `200` with `{}`. Invalid schedule data is reported by the robot IPC as `500` with `{}` rather than as field-level validation errors.

### 6.3 Map commands

All five maps actions are pure passthroughs in the client: Tron performs no validation of its own and forwards the body unchanged to the robot IPC, copying the IPC code and body back, so every requirement in this section is enforced by the robot IPC implementation for maps ability `1.2.0`, not by Tron. The client's ability history records that maps `1.1.0` added `maps.update_floorplan` and the `cleaning_mode` field of `maps.save_track`, and that maps `1.2.0` extended `maps.save_track` and `maps.delete_track` to multiple tracks in one call; earlier versions took a single track per call.

`maps.promote_floorplan` requires exactly the following nested `base` and track shapes. Extra top-level fields are tolerated, but extra or missing keys inside `base`, `nogo_track`, or `cleaning_tracks` make the request invalid.

```json
{
  "ability": "maps.promote_floorplan",
  "rank_uuid": "414fb561-91a7-4a95-8fc7-200169d2d5af",
  "rank_binary": "BASE64_COMPRESSED_PGM",
  "real_binary": "BASE64_COMPRESSED_PGM",
  "old_rank_uuid": null,
  "base": {"x": 20, "y": 200, "dir": 45.0},
  "date_created": "2026-10-06T12:34:56Z",
  "nogo_track": {
    "track_uuid": "888aa432-1067-2a25-9fd7-432169d2d555",
    "binary": "BASE64_COMPRESSED_PGM"
  },
  "cleaning_tracks": [
    {
      "track_uuid": "888aa432-1067-2a25-9fd7-432169d2d556",
      "binary": "BASE64_COMPRESSED_PGM"
    }
  ]
}
```

`rank_uuid` and track UUIDs are strings; binaries are Base64 strings; `base.x` and `base.y` are integer millimetres; `base.dir` is a numeric heading in degrees; and `date_created` is a UTC timestamp. `old_rank_uuid` is `null` for a new promotion or the UUID of the promoted floor plan being superseded. `nogo_track` may be `null`, and `cleaning_tracks` may be `null` or an array. Success is `200` with `{}`; malformed top-level data returns `400`, while a failure after validation returns `422`.

On the robot (verified against firmware 1.7.0-2933), `date_created` is not merely metadata: it is reformatted `YYYY-MM-DD_HH-MM-SS` (UTC) and prefixed to the secure-store identities of the two map files (`<date>_rank_<rank_uuid>` and `<date>_real_<rank_uuid>`), and it is stored as the floor plan's `end_time`. The navigation stack later reconstructs the same file names from that stored value, so a `date_created` that differs from the upload's `timing.end` does not break loading, localization, or tracks — the robot's own promotion reuses `timing.end` only by convention. The value MUST still parse as a UTC timestamp, or promotion fails. Promoting a `rank_uuid` the robot already stores succeeds only if both binaries are byte-identical to the stored ones; different binaries under an existing `rank_uuid` fail with `422`. `base` is stored as sent and handed to the navigation stack without range validation.

`maps.update_floorplan` supersedes an existing promoted floor plan and requires this reduced structure:

```json
{
  "ability": "maps.update_floorplan",
  "rank_uuid": "NEW-FLOORPLAN-UUID",
  "rank_binary": "BASE64_COMPRESSED_PGM",
  "real_binary": "BASE64_COMPRESSED_PGM",
  "old_rank_uuid": "EXISTING-FLOORPLAN-UUID",
  "base": {"x": 20, "y": 200, "dir": 45.0},
  "date_created": "2026-10-06T12:34:56Z"
}
```

`old_rank_uuid` MUST be non-null. Success is `200` with `{}`; malformed data returns `400` and update failures return `422`.

`maps.save_track` creates or replaces one or more zone/no-go maps:

```json
{
  "ability": "maps.save_track",
  "tracks": [
    {
      "rank_uuid": "414fb561-91a7-4a95-8fc7-200169d2d5af",
      "track_uuid": "888aa432-1067-2a25-9fd7-432169d2d556",
      "track_name": "Kitchen",
      "track_binary": "BASE64_COMPRESSED_PGM",
      "type": "cleaning",
      "cleaning_mode": "eco"
    }
  ]
}
```

`tracks` MUST be a non-empty array, all tracks MUST use the same currently promoted `rank_uuid`, and every item requires all six shown fields. `type` is `cleaning` or `no-go`. A cleaning track requires a non-null `track_name` and a valid `cleaning_mode`; a no-go track conventionally uses `null` for both fields. Success is `200` with `{}`, a malformed structure returns `400`, and an unknown floor plan or invalid stored data returns `422`.

On the robot (verified against firmware 1.7.0-2933), this validation is all that happens: the robot checks exactly the six keys, the cleaning-track name and mode, and that the floor plan exists and is promoted. A no-go track is accepted with any `track_name` and `cleaning_mode`, including non-null values. `track_binary` is Base64-decoded leniently — characters outside the Base64 alphabet are silently ignored rather than rejected — and the bytes are stored without ever being parsed: no PGM, dimension, or content check runs at this point, so a corrupt or misencoded binary surfaces only when the floor plan is next loaded for a run (see "Track map files and floor-plan loading" below). Saving a track with an existing `track_uuid` replaces it completely: the stored file is overwritten and the database row replaced, and if the track is referenced by a schedule, the schedule's cleaning mode is updated to the new one. A floor plan has at most one no-go track: saving a no-go track deletes the floor plan's previous no-go track from the maps database.

`maps.delete_track` requires `tracks`, an array of existing track UUID strings, and returns `200` with `{}`; if any listed UUID does not exist, the whole request returns `422` with `{}`. Each deleted track's database row and stored file are removed, and schedules referencing it lose the zone — so deleting a corrupt track makes its floor plan loadable again, without demoting and re-promoting. `maps.demote_floorplan` requires `rank_uuid`; it deletes that floor plan's rank and real files and every stored track file belonging to it, removes the floor plan from the maps database, and disables routines that used it or its zones. It returns `200` with `{}` even when the floor plan is already absent or demoted.

Zones (cleaning tracks) and no-go lines (the no-go track) belong to exactly one floor plan and are never shared between floor plans, so replacing the underlying map has these consequences for them:

- A new promotion (`maps.promote_floorplan` with `old_rank_uuid:null`) starts the floor plan with only the tracks supplied in the request. The client's auto-promotion after a `maps.create` response with `floorplan:true` (section 7.3) supplies `nogo_track:null` and `cleaning_tracks:[]`, so such a floor plan starts with no zones and no no-go lines.
- A replacement (`maps.update_floorplan`) carries no track fields, so it neither replaces nor deletes the existing tracks: the zones and no-go lines of the superseded floor plan in `old_rank_uuid` are expected to remain in effect for the updated floor plan. This preservation is implemented by the robot IPC layer and is not separately verified against firmware 1.7.0-2933.
- A demotion (`maps.demote_floorplan`) removes the floor plan and all of its zones and no-go lines, as described above.

#### 6.3.1 Track map files and floor-plan loading (firmware 1.7.0-2933)

The robot's navigation stack loads map files only when a run starts on a floor plan: the rank and real maps for any persistent run, the no-go track only when `nogo_enabled` is true, and a cleaning track only for a run that names its `track_id`. A file that then fails to load raises the `pm_load_fail` alert (severity `error`), which reaches the server as a `robots.error_codes` event, a `robots.notify` message, and an entry in `peer.state` `errors` — not as a command failure; see the `cleaning.start` acknowledgment caveat in section 6.1. Consequently, a corrupt cleaning track breaks only runs that use its `track_id`, a corrupt no-go track breaks only runs with `nogo_enabled`, and corrupt rank/real maps break every persistent run on the floor plan; whole-floor runs do not load cleaning tracks at all.

The file format, as parsed by the robot's own reader (verified against firmware 1.7.0-2933):

- zlib-compressed (RFC 1950) binary PGM. Any compression level is accepted; the robot's own files use zlib's default.
- The first line must contain `P5` (a substring match, not strict equality).
- Lines starting with `#` are comments. A comment line containing `# Neato metadata` is parsed for `origin_x=%d origin_y=%d resolution=%d alignment=%f`; at least three of the four assignments must parse for the metadata to be used, and an omitted `alignment` defaults to `0`. The comment is optional: without it the raster still loads, but the map has no geographic reference. `origin_x`/`origin_y` locate the map in millimetres, `resolution` is the side of a cell in millimetres, and `alignment` is a rotation in radians, normalized into [0, 2π). Floor-plan training gives the `rank_binary` a non-zero alignment (for example `1.535890`) while the `real_binary` of the same run carries `0.000000`. Header lines are read into a 128-byte buffer, so every header line must be shorter than that.
- The first non-comment line gives width and height as decimal numbers; width × height must not exceed the destination layer (2000×2000 for floor-plan maps on 1.7.0-2933).
- The next line gives the maxval, and its range selects the layer kind. Byte-per-cell layers — the rank and real maps — require a maxval from 129 through 255 (the robot writes 255). The 16-bit layers used by **track maps** require a maxval from 32769 through 65536 (65535 is the value to write); their raster is two bytes per cell, little-endian. A file whose maxval fits neither range fails the load.
- The raster begins one or two whitespace bytes (space or carriage return) after the maxval digits — the robot writes a single `\r`. A load fails, and the run later raises `pm_load_fail`, when any of these structural checks fails.
- The first raster row in the file is the map's last row: x runs across a row and y runs upward, so the file's first row is the far end of the y axis and cell (0, 0) sits at (`origin_x`, `origin_y` + height × `resolution`) in millimetre space.
- Rank cells are occupancy confidence: `128` is unseen, lower values are increasingly certain clear floor (`0` clearest), higher values increasingly certain obstacle (`255` a wall). Real-map cells use `0` for uncleaned, `3` and `4` for cleaned (together they sum to the run's `stats.area`), and `6` for a small square around the robot's trail; the two layouts are not interchangeable.

Track placement and content:

- Tracks are positioned against the **real** map, not the rank map. The navigation stack requires the zone map, the zone mask it derives, and the loaded persistent real ("global track") map to have identical dimensions, and merges the zone into the real map's frame. A track's width and height MUST therefore equal the floor plan's (2000×2000 on 1.7.0-2933), and its header SHOULD be that of the floor plan's `real_binary` — origin, resolution, and `alignment` — rather than of `rank_binary`, whose non-zero alignment belongs to the rotated rank frame, with only the maxval changed to the track file's `65535`.
- A cell of a zone is marked with the 16-bit value **1024** (`0x400`): the zone loader rewrites every freshly loaded cell equal to `0x400` into its zone flag, exactly, and nothing else marks a cell. No-go tracks share the same 16-bit loader and file format; their cells are applied to the track map as virtual obstacles, and while the same loader makes an 8-bit file fail identically, the exact no-go marking value is not separately verified — 1024 is the value to use, as for a zone.
- Internally a zone is treated as an area with an interior: after load, the ZoneManager scans the zone for usable interior cells (cleanable floor inside the zone) and flood-fills the region, failing the run when it finds none ("No valid interior zone cell found").
- As confirmation of the load path, on 1.7.0-2933 a cleaning track drawn as a byte-per-cell file (maxval `255`, a rectangle filled with `255`) was accepted by `maps.save_track` but made a zone run on it fail with `pm_load_fail` the moment the run started, while the same floor plan loaded normally for whole-floor and scheduled runs: the file died in the 16-bit reader's maxval check, before any cell was read.

When a run starts on a floor plan, the robot first localizes into the loaded map and reports the `recovering_location` warning while doing so. This is normal at the start of persistent and zone runs and clears when the position is recovered; if localization fails, the robot raises `persistent_relocalization_fail`, which Tron reports as `persistent_relocalization_fail_clean` or `persistent_relocalization_fail_cancel` according to `force_floorplan` (see section 7.1).

### 6.4 Settings, information, utilities, and maintenance

| Ability | Request fields beyond `ability` | Successful response body |
| --- | --- | --- |
| `info.abilities` | None | Object mapping configured ability names to version strings. |
| `info.robot` | None | `{"serial_number":string,"firmware":string}`. |
| `info.wifi` | None | Object with `SSID` (string or null), `MAC` (`12:12:12:12`), and `ip` (`192.168.1.1`). Only `SSID` is read from the current connection; the other values are provisional and fixed. |
| `settings.robot_language` | None | Object with `language` (string or null) and `available_languages` (string array); Vorwerk variants also include `gender` (string or null). |
| `settings.set_robot_language` | `language`: non-empty string from the preceding `available_languages` array, matched case-insensitively | `{}`. |
| `settings.cleaning_options` | None | `{"force_floorplan":boolean}`. |
| `settings.set_cleaning_options` | Optional `force_floorplan`: Boolean | `{}`. An omitted setting is a no-op. |
| `settings.sounds` | None | Object with Boolean `enabled`, `voice` (`on` or `off`), and integer `volume`; volume is conventionally `0` through `100`. |
| `settings.set_sounds` | Required `enabled`: Boolean; optional `voice`: `"on"` or `"off"`; optional `volume`: integer defaulting to `100` | `{}`. |
| `settings.ota_updates` | None | `{"auto":boolean}`. |
| `settings.set_ota_updates` | Required `auto`: Boolean | `{}`; a missing or non-Boolean value returns `400` with `{}`. |
| `settings.factory_reset` | None | `{}` after initiating a local factory reset. |
| `utilities.find_me` | None | `{}` after requesting the audible locator. |
| `utilities.light_ring` | No fields defined by Tron | Vendor-specific IPC result; this action is only available on supported Vorwerk builds. |
| `extraction.start` | None | `{}` after requesting cleaning-center extraction. |
| `ota_update.start` | Optional `silent`: Boolean, default `false` | `{}` immediately; checking, download, and installation continue asynchronously. |
| `ota_update.show` | None | `{"state":string,"download_percent":number}`. |
| `debug.echo_body` | Any JSON members | The complete request body, unchanged. |

Tron-managed values for `ota_update.show.state` are `checking_for_update`, `downloading_update`, `error_checking_for_update`, `error_downloading_update`, `no_recent_update_check`, `no_update_available`, and `update_downloaded`. During installation the field is replaced by the robot's string status, including `swu_started`, `swu_started_silent`, `swu_success`, `swu_new_version_detected`, `swu_error_low_battery`, `swu_error_internal`, and the specific `swu_error_*` installer failures. `download_percent` is normally from `0.0` through `100.0`.

`utilities.switch_env` requires `env` to be `playground`, `qa`, `staging`, or `production`. Success sends `200` with `{}` before disconnecting and reconnecting to the new hostname. Missing, invalid, or unchanged environments return `400` with an `error` string.

`logs.request_upload` requires `range.from` and `range.to` as `YYYY-MM-DD` strings plus `type` as `robot`, `system`, or `all`; see section 7.4 for the resulting transaction. Success returns `200` with `{"message":string}`. A concurrent upload returns `400`, invalid arguments return `404`, and no matching files returns `403`; these error bodies contain `{"message":string}`.

`debug.send_map` imports test modules absent from this snapshot and MUST NOT be used for conformance.

### 6.5 Command routing errors

Generic routing errors are:

| Condition | Code/body |
| --- | --- |
| Missing body or `ability` | `400` (body may be absent). |
| Unknown ability/action | `422`, `{"errors":{"ability":["invalid"]}}`. |
| `cleaning.start` missing or null `runs` | `422`, `{"errors":{"missing_params":["runs"]}}`. |
| Ability raises unexpectedly | `503`, `{"message":string}` containing an internal traceback. |

Malformed top-level field types can fail before the protected ability call and make the client drop the request without a response. Servers MUST validate their command bodies locally and MUST NOT rely on the robot's traceback response as input validation.

## 7. Robot-to-server services

The server routes a robot request/event by `to.service` on its authenticated connection.

| Service | Envelope | Reply? | Required behavior |
| --- | --- | --- | --- |
| `peer.state` | event | No | Store/publish the latest robot state. |
| `robots.error_codes` | event | No | Store an error occurrence. |
| `robots.notify` | request | **No** | Dispatch a push notification. |
| `robots.link` | request | Yes | Associate the authenticated robot with a user. |
| `firmware.check` | request | Yes | Return an applicable firmware artifact or no-update code. |
| `maps.create` | request | Yes | Persist uploaded map data and decide floorplan promotion. |
| `logs.list_files` | request | Yes | Create log records and presigned HTTP PUT URLs. |
| `logs.update_status` | request | Yes | Update one log upload record. |

`robots.notify` is intentionally fire-and-forget even though its envelope type is `request`. Responding is unnecessary and produces an “unknown request ID” warning on the robot.

### 7.1 State and notifications

`peer.state` is an event and MUST NOT receive a response. Its body is the robot's `state.show` result plus `"ability":"state.show"`:

```json
{
  "type": "event",
  "id": "robot-generated-id",
  "to": {"service": "peer.state"},
  "body": {
    "state": "idle",
    "action": "invalid",
    "errors": null,
    "available_commands": {
      "start": true,
      "cancel": false,
      "pause": false,
      "resume": false,
      "return_to_base": false
    },
    "details": {
      "is_charging": false,
      "is_docked": false,
      "charge": 78,
      "base_type": "standard",
      "is_quickboost": false,
      "quickboost_estimate": -1
    },
    "cleaning_center": {
      "base_error": null,
      "bag_status": "bag_ok",
      "is_extracting": false
    },
    "autonomy_states": {},
    "ability": "state.show"
  }
}
```

The state fields are:

| Field | Type and values |
| --- | --- |
| `state` | `idle`, `busy`, `paused`, or `error`. |
| `action` | `invalid`, `cleaning`, `cleaning_standby`, `docking`, `diagnostic_test`, or `updating_software`. |
| `errors` | `null` or an array of error objects. Every object has string `code` and `severity`; `severity` is `warning`, `error`, or `critical`. `nav_floorplan_zone_unreachable` also has `zone_name`, which is string or `null`. |
| `available_commands` | Object containing exactly the five Boolean fields shown above. |
| `details.is_charging`, `details.is_docked`, `details.is_quickboost` | Booleans. |
| `details.charge` | Integer battery percentage, normally `0` through `100`. |
| `details.base_type` | `unknown`, `standard`, or `cleaning_center`. |
| `details.quickboost_estimate` | Signed integer target charge percentage; `-1` means no estimate. |
| `cleaning_center.base_error` | `null`, `comm_error`, `critical_error`, or `perm_error`. |
| `cleaning_center.bag_status` | Normally `bag_ok`, `no_bag`, `bag_half`, or `bag_full`; the matched IPC layer emits `NULL` for an unclassified cleaning-center error status. |
| `cleaning_center.is_extracting` | Boolean. |
| `autonomy_states` | `{}` until data is available; otherwise contains Boolean `started_on_base` and dynamic state-name keys whose values are signed integer timestamps (`-1` means unseen). |
| `ability` | Always `state.show` in the event; absent from a direct `state.show` response. |

Tron removes `routine_cleaning_start`, `routine_cleaning_start_offbase_error`, and `routine_cleaning_start_low_battery_error` from `errors` before sending state. If no errors remain, it sends `errors:null`. The workstation dummy supplies a reduced state object, and other robot IPC builds may add fields; a server MUST preserve unknown fields.

`robots.error_codes` is an event sent once when an alert code newly appears. It MUST NOT receive a response. Its body always contains all three fields:

```json
{
  "code": "dustbin_missing",
  "severity": "warning",
  "created": null
}
```

`code` and `severity` are strings. The current call site does not supply `created`, so the wire value is JSON `null`; `send_error_code` also accepts a caller-supplied value without parsing it. A code can be sent again after it disappears and subsequently reappears.

`robots.notify` is a request-shaped, fire-and-forget notification. The body always contains `message_code` and `payload`, including when the latter is `null`:

```json
{
  "type": "request",
  "id": "robot-generated-id",
  "to": {"service": "robots.notify"},
  "body": {
    "message_code": "fuel_less_than_10",
    "payload": null
  }
}
```

The server MUST dispatch the notification and MUST NOT send a response. `message_code` is a string. Known locally generated values and payloads are:

| Condition | `message_code` | `payload` |
| --- | --- | --- |
| Low-battery event, once per low-battery episode while not charging | `fuel_less_than_10` | `null` |
| A zone cannot be reached | `nav_floorplan_zone_unreachable` | Object containing `zone_name` as string or null |
| A routine begins | `routine_cleaning_start` | `null` |
| A routine cannot start off-base | `routine_cleaning_start_offbase_error` | `null` |
| A routine cannot start due to low battery | `routine_cleaning_start_low_battery_error` | `null` |
| Persistent localization fails and `force_floorplan` is true | `persistent_relocalization_fail_clean` | `null` |
| Persistent localization fails and `force_floorplan` is false | `persistent_relocalization_fail_cancel` | `null` |

Other newly appearing alerts with severity `error` or `critical` use their alert `code` as `message_code`. `swu_error_low_battery`, `picked_up`, `dustbin_missing`, and `busy_charging` never generate `robots.notify`. For error-derived notifications, Tron removes `code` and `severity` from the error object and sends any remaining members as `payload`; if none remain, it sends `null`.

### 7.2 Linking and firmware

`robots.link.body` contains non-empty `user_id` and `timezone`. Return `201` on success; any other code becomes the BLE linking state. The association SHOULD be idempotent for the same robot/user pair.

`firmware.check.body` contains string `version` and Boolean `only_mandatory`. If an update applies, return:

```json
{"type":"response","id":"<same-id>","code":200,"body":{"url":"https://downloads.example/fw.bin"}}
```

Any non-`200` code means no update. The URL MUST support HTTP GET, and its basename becomes the local filename. The client does not verify an artifact hash or HTTP status, so a production server SHOULD use authenticated HTTPS and an artifact format verified by the robot installer.

### 7.3 Map creation

The robot sends `maps.create` when its IPC layer reports a `map_available` event (a completed or interrupted cleaning that produced map data). The client copies that internal event unchanged except for `map`: the wire `map` object contains exactly `origin`, `rank_binary`, and `real_binary`, and the robot-internal `local_path` is never sent. Any other top-level fields the IPC build adds are passed through, so the server MUST preserve unknown fields. The client reads the two binaries from `<map.local_path>/<tstamp>_rank_<rank_uuid>.pgm.nz` and `<tstamp>_real_<rank_uuid>.pgm.nz`, where `tstamp` is `timing.end` reformatted as `YYYY-MM-DD_HH-MM-SS`; a received upload therefore always carries a parseable UTC `timing.end`, and a map event without one — or one whose files are missing — fails locally and is never sent. Its body is:

```json
{
  "version": "1.0.0",
  "rank_uuid": "414fb561-91a7-4a95-8fc7-200169d2d5af",
  "persistent_rank_uuid": null,
  "started_by": "app",
  "force_floorplan": false,
  "cleaning_complete": true,
  "is_valid_quick_boost_data": true,
  "timing": {
    "start": "2026-10-06T12:00:00Z",
    "end": "2026-10-06T12:45:00Z",
    "charging": 0,
    "error": 0,
    "pause": 12
  },
  "map": {
    "origin": {"x": -120, "y": 85},
    "rank_binary": "BASE64_COMPRESSED_PGM",
    "real_binary": "BASE64_COMPRESSED_PGM"
  },
  "robot": {
    "pos": {"x": 100, "y": 200, "dir": 90.0},
    "base": {"x": 20, "y": 200, "dir": 45.0}
  },
  "battery_consumed": 24,
  "runs": [
    {
      "timing": {
        "start": "2026-10-06T12:00:00Z",
        "end": "2026-10-06T12:45:00Z",
        "charging": 0,
        "error": 0,
        "pause": 12
      },
      "track_uuid": "",
      "state": "done",
      "autonomous_dock": true,
      "stats": {"area": 48.2, "pickup_count": 120},
      "settings": {"mode": "eco", "navigation_mode": "normal"}
    }
  ]
}
```

`version` is currently `1.0.0` (`unknown` is used for an unrecognized producer version). `persistent_rank_uuid` is string or `null`; `started_by` has the values defined for `CleaningSession`; `force_floorplan`, `cleaning_complete`, and `is_valid_quick_boost_data` are Booleans; coordinates are integer millimetres; headings are numeric degrees; and timing counters are integer seconds. `battery_consumed` is a non-negative integer. `runs` may be empty and uses the cleaning mode, navigation mode, run state, timing, and statistics values defined in section 6.1. Unlike `CleaningSession`, map timing uses the key `pause`, not `paused`, and a whole-floor run uses an empty string for `track_uuid`, not `null`.

`robot.base` uses a sentinel when the run never established a base pose (observed on firmware 1.7.0-2933): `x` and `y` are then `2147483647` (INT32_MAX, the navigation stack's unset marker) and `dir` is `0.0`. This is typical of non-persistent runs started off the base, which also carry `persistent_rank_uuid: null`. The value is stored and passed through as-is, and a floor plan promoted with it is accepted; but the base pose feeds the navigation stack's persistent-map record, and the effects of the sentinel beyond storage are not verified, so a server SHOULD promote maps with a real base pose when one is available.

`rank_binary` and `real_binary` are Base64 strings containing the compressed PGM files. They can be large and SHOULD be decoded or streamed to binary storage rather than retained in structured logs.

Delivery is queued and retried on connection loss. If the client is not logged in when the map becomes available, or the connection drops while the upload is in flight, the upload is placed on a bounded reconnect queue (default length 20) and sent after a later login. Queued uploads run only on a reconnection, not on the client's first login after startup, so a map produced before that first login is sent only after the next reconnect; a `maps.create` can therefore arrive long after its `timing.end`. Because the request may have reached the server before a connection drop, the server MUST tolerate a retransmitted upload with the same `rank_uuid` and SHOULD treat it as a duplicate. Only connection loss re-queues an upload: a non-`201` response or a response timeout (about 31 seconds) is logged and the map is never sent again.

Return `201` with a mandatory Boolean:

```json
{"type":"response","id":"<same-id>","code":201,"body":{"floorplan":false}}
```

When `floorplan` is true, the client immediately promotes the uploaded maps on the robot with a local IPC call built as follows. This call is not sent to the server, and its result is neither reported to nor retried with the server.

```json
{
  "ability": "maps.promote_floorplan",
  "rank_uuid": "<the upload's rank_uuid>",
  "rank_binary": "<the uploaded map file, re-encoded>",
  "real_binary": "<the uploaded map file, re-encoded>",
  "old_rank_uuid": null,
  "base": {"x": 20, "y": 200, "dir": 45.0},
  "date_created": "<the upload's timing.end>",
  "nogo_track": null,
  "cleaning_tracks": []
}
```

`base` is copied from the upload's `robot.base`, and `date_created` is the run's `timing.end`, not the promotion time. Other response codes are treated as upload failure. A `201` response missing `body.floorplan` raises an exception in the client.

### 7.4 Log upload transaction

The server begins the flow with:

```json
{
  "type":"request",
  "id":"upload-job-id",
  "body":{
    "ability":"logs.request_upload",
    "range":{"from":"2026-10-01","to":"2026-10-06"},
    "type":"all"
  }
}
```

`type` is `robot`, `system`, or `all`; dates use `YYYY-MM-DD` and `from <= to`. The robot first returns `200` with `{"message":string}`, then sends a new request with a new robot-generated ID:

```json
{
  "type": "request",
  "id": "list-files-request-id",
  "to": {"service": "logs.list_files"},
  "body": {
    "files": [
      {
        "path": "/user/black_box/power.csv",
        "last_mtime": "2026-10-06",
        "size": 48123,
        "type": "robot"
      }
    ]
  }
}
```

`files` is a non-empty array. `path` is an absolute string, `last_mtime` is a `YYYY-MM-DD` string in the robot's local time, `size` is a positive integer byte count, and file `type` is `robot` or `system`.

The server MUST answer `logs.list_files` with `200` and:

```json
{
  "urls":[
    {"path":"/user/black_box/power.csv","url":"https://upload.example/...","log_id":"log-123"}
  ]
}
```

Each `urls` item requires string `path`, `url`, and `log_id`. `path` MUST exactly match a listed path. The array MUST be non-empty; the robot ignores a non-`200` response and aborts when `body.urls` is missing or empty. The URL MUST accept an unauthenticated or presigned HTTP `PUT` with `Content-Type: application/octet-stream` and the file's `Content-Length`, and MUST return status `200` (not `201` or `204`).

After each attempted upload the robot sends:

```json
{
  "type": "request",
  "id": "upload-job-id",
  "to": {"service": "logs.update_status"},
  "body": {
    "log_id": "log-123",
    "state": "completed",
    "errors": []
  }
}
```

`log_id` is copied from the matching URL item. `state` is `completed` or `failed`; `errors` is empty on success or a one-element array containing the string form of the upload exception. The request deliberately reuses the original server command's `upload-job-id`. The server MUST return code `200` for every status update and MUST tolerate several requests reusing that ID during one job.

## 8. Persistence and operational behavior

A useful minimum data model contains:

- robot identity: vendor, board serial, RSA public key, firmware, user link, timezone;
- live session: connection ID, login time, last receive time, and pending calls;
- latest state plus append-only error and notification records;
- firmware rules and downloadable artifacts;
- maps and their floorplan decision;
- log-upload jobs, files, URLs, and status.

Only one active connection per robot SHOULD control commands. On duplicate login, the server SHOULD atomically replace the older session or reject the newer one. Pending server calls MUST fail when their connection closes and MUST NOT be replayed automatically unless the operation is known to be idempotent.

The server SHOULD log connection identity, message direction/type/service/id, response code, latency, and disconnect reason without recording private keys, signatures, firmware binaries, map binaries, or log contents. It SHOULD enforce authentication rate limits, timestamp replay protection, frame-size limits, per-robot command authorization, and upload URL expiry.

## 9. Minimum conformance suite

An implementation is compatible when automated tests demonstrate that it:

1. accepts a fragmented TLS frame and parses the four-byte big-endian length;
2. accepts a valid signed login and rejects an altered vendor, serial, timestamp, or signature;
3. keeps an idle session alive with framed `0x06` heartbeats for longer than 70 seconds;
4. receives the immediate `peer.state` event after login without replying;
5. invokes `debug.echo_body` and correlates the response ID;
6. invokes an unknown ability and receives `422`;
7. handles several concurrent ability calls with out-of-order responses;
8. responds to `robots.link`, `firmware.check`, and `maps.create` within 30 seconds;
9. completes the multi-message log upload transaction, including repeated job IDs;
10. does not respond to `peer.state`, `robots.error_codes`, or `robots.notify`;
11. cleanly handles heartbeat, close, invalid JSON, timeout, and abrupt disconnect;
12. reconnects a robot after `utilities.switch_env` without treating it as a new identity.

## 10. Source-of-truth limitations

The wire behavior and the robot-originated service contracts are those of the robot's client, Tron. The passthrough command structures and real-robot state/map response structures additionally follow the matching external `lego_python.robot_tron_if` implementation for the ability versions the client is configured with. That dependency is not part of the client and can vary by robot/vendor image.

The client comes with no protocol tests, dependency manifests, or server code. Implementations SHOULD preserve unknown response/event fields and SHOULD capture real client/server transcripts as regression fixtures before claiming production parity with a particular firmware image.
