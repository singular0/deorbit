"""Home Assistant through MQTT: each robot is a device that Home Assistant finds by MQTT discovery, with its state, and what Home Assistant asks of a robot is sent on to it."""

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import re
from datetime import datetime
from importlib import metadata
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo

import aiomqtt

from .auth import RobotId
from .commands import COMMANDS, MODES, cleaning
from .session import Session, describe
from .store import StoreError

if TYPE_CHECKING:
    from .server import Server

log = logging.getLogger(__name__)

# How long to wait before trying the broker again, after it could not be reached or the connection to it ended.
_RETRY = 10.0
# How long a robot has to answer what Home Assistant asked of it. Nobody waits for the answer but the log.
_COMMAND_TIMEOUT = 10.0
# How long a server that stops tries to tell the broker so.
_STOP_TIMEOUT = 2.0
# How often a task that is to end is cancelled again until it does (see ``_end``).
_END_AGAIN = 0.1
# Everything is published at least once: a state or an alert that is lost on the way would not come again.
_QOS = 1

# The mode a start from Home Assistant cleans in until it is given another as
# the vacuum's fan speed: that of the web UI's Start. The fan speed is kept
# while the server runs, and not in the database.
_MODE = "eco"
# What Home Assistant's vacuum sends on its command topic, but for ``start``,
# and the command of ``COMMANDS`` each is.
_PAYLOADS = {"pause": "pause", "stop": "cancel", "return_to_base": "return_to_base", "locate": "find_me"}
# What the vacuum offers, in Home Assistant's words: ``locate`` is Find me.
_FEATURES = ["start", "pause", "stop", "return_home", "locate", "fan_speed"]
# The severities of a ``robots.error_codes`` (section 7.1 of the spec), which are the event types of the Alert entity.
_SEVERITIES = ("warning", "error", "critical")
# The ``message_code`` of each ``robots.notify`` that section 7.1 of the spec
# lists. These and ``other`` are the event types of the Notification entity,
# the last for any code but these, which an alert of the severity error or
# critical gives as its own.
_NOTICES = (
    "fuel_less_than_10",
    "nav_floorplan_zone_unreachable",
    "routine_cleaning_start",
    "routine_cleaning_start_offbase_error",
    "routine_cleaning_start_low_battery_error",
    "persistent_relocalization_fail_clean",
    "persistent_relocalization_fail_cancel",
)
_OTHER = "other"
# Who made a robot of a vendor, by the host the spec gives the vendor's cloud
# (section 2): neatocloud.com for N, and a host of vorwerk.com for 1 and 2.
_MAKERS = {"n": "Neato", "1": "Vorwerk", "2": "Vorwerk"}
# The longest state Home Assistant takes for a sensor.
_STATE_MAX = 255
# A number above the ``id`` of every map, which ``Store.floorplan_maps`` gives every map of a floor plan below.
_EVERY = 2**63 - 1

try:
    _ORIGIN = {"name": "deorbit", "sw_version": metadata.version("deorbit")}
except metadata.PackageNotFoundError:  # run from a copy that was not installed
    _ORIGIN = {"name": "deorbit"}


def _node(robot: RobotId) -> str:
    """What a robot is in topics and in the IDs Home Assistant is given: its vendor and serial, made of letters and digits that cannot be read otherwise."""
    parts = (robot.vendor, robot.serial)
    node = "_".join(re.sub(r"[^a-z0-9]", "_", part) for part in parts)
    if all(re.fullmatch(r"[a-z0-9]*", part) for part in parts):
        return node
    # Two robots whose names come to the same once made safe, "_" between them included, are told apart by what they were.
    digest = hashlib.sha256("\n".join(parts).encode()).hexdigest()
    return f"{node}_{digest[:8]}"


async def _end(task: asyncio.Task, patience: float) -> None:
    """Cancel ``task`` and wait for it to end, cancelling it again every ``patience`` seconds until it does.

    Once is not always enough: on Python 3.11, ``asyncio.wait_for``, which
    aiomqtt waits for the broker with, lets a cancellation go by when what it
    waits for comes at the same time, and the task goes on.
    """
    while not task.done():
        task.cancel()
        await asyncio.wait([task], timeout=patience)


def _payload(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def activity(row: dict[str, object]) -> str:
    """What Home Assistant's vacuum shows of a robot, as the store reads it: cleaning, docked, idle, paused, returning or error."""
    state, action = row.get("state"), row.get("action")
    if state == "error":
        return "error"
    if state == "paused":
        return "paused"
    if state == "busy" and action in ("cleaning", "cleaning_standby"):
        return "cleaning"
    if state == "busy" and action == "docking":
        return "returning"
    # Idle, or busy with something that is no cleaning, such as a software update: then where it is.
    return "docked" if row.get("is_docked") else "idle"


def _charge(row: dict[str, object]) -> float | None:
    charge = row.get("charge")
    whole = isinstance(charge, int) and not isinstance(charge, bool)
    # SQLite reads an infinity out of a whole number too long for it, which JSON cannot carry.
    return charge if whole or (isinstance(charge, float) and math.isfinite(charge)) else None


def _errors(row: dict[str, object]) -> str:
    """The codes of the errors a robot reports, or ``none``."""
    errors = row.get("errors")
    try:
        errors = json.loads(errors) if isinstance(errors, str) else errors
    except ValueError:  # json_extract gives text that a robot sent in place of a list as it is
        return errors[:_STATE_MAX]
    if not isinstance(errors, list):
        return "none"
    codes = [error["code"] for error in errors if isinstance(error, dict) and isinstance(error.get("code"), str)]
    return ", ".join(codes)[:_STATE_MAX] or "none"


def _told(row: dict[str, object]) -> tuple[str, dict] | None:
    """What an event of the log is told Home Assistant as: the entity, and the event of it. ``None`` for one that is not."""
    try:
        body = json.loads(row["body_json"]) if row["body_json"] else None
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return None
    if row["service"] == "robots.error_codes":
        severity, code = body.get("severity"), body.get("code")
        if severity not in _SEVERITIES or not isinstance(code, str):
            return None
        return "alert", {"event_type": severity, "code": code}
    code = body.get("message_code")
    if not isinstance(code, str):
        return None
    return "notification", {"event_type": code if code in _NOTICES else _OTHER, "code": code, "payload": body.get("payload")}


class Mqtt:
    """The robots in Home Assistant: a client of an MQTT broker that it keeps connected while the server runs."""

    def __init__(self, server: "Server") -> None:
        self._config = server.config
        self._store = server.store
        self._sessions = server.sessions
        self._base = self._config.mqtt_topic
        self._status = f"{self._base}/status"  # whether this server is there, which every entity goes by
        self._birth = f"{self._config.mqtt_discovery_prefix}/status"  # Home Assistant's, when it starts
        self._task: asyncio.Task | None = None
        self._client: aiomqtt.Client | None = None
        # The robots whose messages are to be published again, and what says that there are some.
        self._dirty: set[RobotId] = set()
        self._wake = asyncio.Event()
        # What the broker holds as retained, by topic, as this server published it. None for what it
        # held when the connection ended, which it may have lost since: that is published again.
        self._sent: dict[str, bytes | None] = {}
        # The robots announced to Home Assistant, by what topics call them, so that a command finds its robot.
        self._nodes: dict[str, RobotId] = {}
        self._modes: dict[RobotId, str] = {}  # the fan speed Home Assistant set, which is the mode a start cleans in
        self._firmware: dict[RobotId, str] = {}  # each robot's, as its last connection gave it
        self._seen = 0  # the last event of the log that was looked at for alerts and notifications
        self._calls: set[asyncio.Task] = set()
        self._failure: str | None = None  # why the broker could not be reached last, which is logged once
        self._store.watch(self._changed)

    def start(self) -> None:
        # What happened before is no news.
        self._seen = self._store.last_event()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is None:
            return
        client = self._client
        if client is not None:
            # The broker publishes the last will only for a connection that is lost, so a server that stops says it itself.
            with contextlib.suppress(aiomqtt.MqttError, TimeoutError):
                await client.publish(self._status, b"offline", qos=_QOS, retain=True, timeout=_STOP_TIMEOUT)
        for task in self._calls:
            task.cancel()
        # Given time to say goodbye to the broker as the client is left, which waits for the broker to hear it.
        await _end(self._task, _STOP_TIMEOUT)
        await asyncio.gather(*self._calls, return_exceptions=True)

    def _changed(self, robot: RobotId) -> None:
        self._dirty.add(robot)
        self._wake.set()

    async def _run(self) -> None:
        host, port = self._config.mqtt_host, self._config.mqtt_port
        while True:
            client = aiomqtt.Client(
                host,
                port,
                username=self._config.mqtt_username or None,
                password=self._config.mqtt_password or None,
                # Every entity goes with this server, which the broker says is gone when the connection is lost.
                will=aiomqtt.Will(self._status, b"offline", qos=_QOS, retain=True),
            )
            try:
                async with client:
                    self._client = client
                    await self._connected(client)
            except aiomqtt.MqttError as exc:
                failure = describe(exc)
                if failure != self._failure:  # once, and not every few seconds while the broker is away
                    log.warning("Home Assistant: no connection to the MQTT broker at %s:%d: %s; trying again every %g s",
                                host, port, failure, _RETRY)
                self._failure = failure
            except Exception:
                # Home Assistant is not worth the robots' server: it is tried again, as after a lost connection.
                log.exception("Home Assistant: the connection to the MQTT broker failed")
            finally:
                self._client = None
            await asyncio.sleep(_RETRY)

    async def _connected(self, client: aiomqtt.Client) -> None:
        commands = [(f"{self._base}/+/{name}", 0) for name in ("command", "fan_speed", "clean_segments")]
        await client.subscribe([*commands, (self._birth, 0)])
        await client.publish(self._status, b"online", qos=_QOS, retain=True)
        log.info("Home Assistant: connected to the MQTT broker at %s:%d", self._config.mqtt_host, self._config.mqtt_port)
        self._failure = None
        try:
            # What happened while there was no connection is no news either.
            self._seen = self._store.last_event()
        except StoreError as exc:
            log.error("Home Assistant: %s", exc)
        self._announce()
        # Until either ends, which is when the connection does. Not in a TaskGroup, which waits for good for a
        # task that let its cancellation go by.
        tasks = (asyncio.create_task(self._publish(client)), asyncio.create_task(self._receive(client)))
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                await _end(task, _END_AGAIN)
        for error in [task.exception() for task in tasks if not task.cancelled()]:
            if error is not None:
                raise error

    async def _receive(self, client: aiomqtt.Client) -> None:
        async for message in client.messages:
            self._heard(message)

    def _announce(self) -> None:
        """Have every robot published again, as the broker may have lost what it held."""
        self._sent = dict.fromkeys(self._sent)
        try:
            robots = [RobotId(row["vendor"], row["serial"]) for row in self._store.robots()]
        except StoreError as exc:
            log.error("Home Assistant: %s", exc)
            robots = []
        # Those announced before are among them, so that one that is gone from the database is taken away.
        self._dirty.update(robots, self._nodes.values())
        self._wake.set()

    async def _publish(self, client: aiomqtt.Client) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._dirty:
                await self._update(client, self._dirty.pop())
            await self._tell(client)

    async def _update(self, client: aiomqtt.Client, robot: RobotId) -> None:
        """Publish what has changed of what the broker retains of the robot, and take it all away once the robot is gone from the database."""
        node = _node(robot)
        try:
            wanted = self._wanted(robot, node)
        except StoreError as exc:
            log.error("Home Assistant: [%s] %s", robot, exc)
            return
        if wanted:
            self._nodes[node] = robot
        for topic in self._retained(node):
            payload = wanted.get(topic, b"")
            if self._sent.get(topic, b"") == payload:
                continue
            await client.publish(topic, payload, qos=_QOS, retain=True)  # an empty one takes the retained message away
            if payload:
                self._sent[topic] = payload
            else:
                self._sent.pop(topic, None)
        if not wanted and self._nodes.pop(node, None) is not None:
            log.info("Home Assistant: [%s] taken away", robot)
            self._modes.pop(robot, None)
            self._firmware.pop(robot, None)

    def _retained(self, node: str) -> tuple[str, ...]:
        base = f"{self._base}/{node}"
        return (self._discovery_topic(node), f"{base}/availability", f"{base}/vacuum", f"{base}/state")

    def _discovery_topic(self, node: str) -> str:
        return f"{self._config.mqtt_discovery_prefix}/device/deorbit_{node}/config"

    def _wanted(self, robot: RobotId, node: str) -> dict[str, bytes]:
        """Every retained message of the robot's as it now is, or none for a robot that is not in the database."""
        row = self._store.robot(robot)
        if row is None:
            return {}
        session = self._sessions.get(robot)
        if session is not None and session.firmware:
            self._firmware[robot] = session.firmware
        vacuum = {"state": activity(row), "fan_speed": self._modes.get(robot, _MODE), "segments": self._segments(robot)}
        state = {
            "battery": _charge(row),
            "charging": bool(row["is_charging"]),
            "docked": bool(row["is_docked"]),
            "errors": _errors(row),
            "connected": session is not None,
        }
        discovery, availability, vacuum_topic, state_topic = self._retained(node)
        return {
            discovery: _payload(self._discovery(robot, node, row)),
            availability: b"online" if session is not None else b"offline",
            vacuum_topic: _payload(vacuum),
            state_topic: _payload(state),
        }

    def _discovery(self, robot: RobotId, node: str, row: dict[str, object]) -> dict:
        """The robot as Home Assistant's MQTT discovery has a device: the vacuum, its sensors and its events."""
        base = f"{self._base}/{node}"
        # An entity is there while this server and the robot both are.
        there = {"availability": [{"topic": self._status}, {"topic": f"{base}/availability"}], "availability_mode": "all"}

        def entity(key: str, platform: str, name: str | None, **options: object) -> dict:
            return {"platform": platform, "unique_id": f"deorbit_{node}_{key}", "name": name, **there, **options}

        def sensor(key: str, platform: str, name: str, template: str, **options: object) -> dict:
            return entity(key, platform, name, state_topic=f"{base}/state", value_template=template, **options)

        def switch(key: str) -> str:
            return f"{{{{ 'ON' if value_json.{key} else 'OFF' }}}}"

        components = {
            # Named as the device is, being what the device is.
            "vacuum": entity(
                "vacuum",
                "vacuum",
                None,
                state_topic=f"{base}/vacuum",
                command_topic=f"{base}/command",
                supported_features=_FEATURES,
                fan_speed_list=list(MODES),
                set_fan_speed_topic=f"{base}/fan_speed",
                clean_segments_command_topic=f"{base}/clean_segments",
            ),
            # A charge that is not known is published as null, which the template writes as None: an unknown state.
            "battery": sensor("battery", "sensor", "Battery", "{{ value_json.battery }}",
                              device_class="battery", unit_of_measurement="%", state_class="measurement"),
            "charging": sensor("charging", "binary_sensor", "Charging", switch("charging"), device_class="battery_charging"),
            "docked": sensor("docked", "binary_sensor", "Docked", switch("docked"), icon="mdi:home-import-outline"),
            "errors": sensor("errors", "sensor", "Errors", "{{ value_json.errors }}", icon="mdi:alert-circle-outline"),
            "alert": entity("alert", "event", "Alert", state_topic=f"{base}/alert", event_types=list(_SEVERITIES)),
            "notification": entity("notification", "event", "Notification", state_topic=f"{base}/notification",
                                   event_types=[*_NOTICES, _OTHER]),
        }
        # Whether the robot is connected is known while this server is there, whether or not the robot is.
        connected = sensor("connected", "binary_sensor", "Connected", switch("connected"),
                           device_class="connectivity", entity_category="diagnostic")
        del connected["availability_mode"]
        components["connected"] = {**connected, "availability": [{"topic": self._status}]}
        device = {
            "identifiers": [f"deorbit_{node}"],
            "name": row["name"] or robot.serial,  # as the web UI calls it
            "serial_number": robot.serial,
        }
        if robot.vendor in _MAKERS:
            device["manufacturer"] = _MAKERS[robot.vendor]
        if robot in self._firmware:
            device["sw_version"] = self._firmware[robot]
        return {"device": device, "origin": _ORIGIN, "components": components}

    def _segments(self, robot: RobotId) -> dict[str, str]:
        """The zones of the robot's floor plans, by what the robot knows each by, which Home Assistant cleans as segments of the robot's map.

        Where the zones are of more than one floor plan, each says its floor plan too.
        """
        plans = {plan["rank_uuid"]: plan for plan in self._store.floorplans(robot)}
        zones = [track for track in self._store.tracks(robot) if track["type"] == "cleaning" and track["rank_uuid"] in plans]
        if len({zone["rank_uuid"] for zone in zones}) <= 1:
            return {zone["track_uuid"]: zone["name"] or zone["track_uuid"] for zone in zones}
        maps = {row["id"]: row for row in self._store.floorplan_maps(robot, _EVERY)}
        return {
            zone["track_uuid"]: f"{zone['name'] or zone['track_uuid']} ({self._plan(plans[zone['rank_uuid']], maps)})"
            for zone in zones
        }

    def _plan(self, plan: dict[str, object], maps: dict[int, dict[str, object]]) -> str:
        """What a floor plan is called, as the web UI calls it: what the map it was made of is called, or else when that map's run began."""
        made = maps.get(plan["map_id"])
        if made is not None and made["name"]:
            return made["name"]
        try:
            timing = json.loads(made["map_json"]).get("timing") if made is not None else None
            start = datetime.fromisoformat(timing["start"].replace("Z", "+00:00"))
            return start.astimezone(ZoneInfo(self._config.timezone)).strftime("%d.%m.%Y %H:%M")
        except (AttributeError, KeyError, TypeError, ValueError):  # a map without a start that is a time
            return plan["rank_uuid"][:8]

    async def _tell(self, client: aiomqtt.Client) -> None:
        """Publish the alerts and the notifications robots sent since those published last."""
        try:
            rows = self._store.alerts(self._seen)
        except StoreError as exc:
            log.error("Home Assistant: %s", exc)
            return
        for row in rows:
            self._seen = row["id"]
            told = _told(row)
            node = _node(RobotId(row["vendor"], row["serial"]))
            if told is not None and node in self._nodes:  # one that is not announced has no entity to tell
                entity, event = told
                await client.publish(f"{self._base}/{node}/{entity}", _payload(event), qos=_QOS)

    def _heard(self, message: aiomqtt.Message) -> None:
        topic = message.topic.value
        payload = message.payload
        text = payload.decode("utf-8", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload or "")
        if topic == self._birth:
            if text == "online":
                # Home Assistant has started, and is told of every robot again, as it asks to be.
                self._announce()
            return
        node, _, what = topic.removeprefix(f"{self._base}/").partition("/")
        if message.retain:
            # Kept by the broker for whoever subscribes, so an old one, which is not carried out again at each connection.
            log.warning("Home Assistant: %s that the broker retained is ignored", topic)
            return
        robot = self._nodes.get(node)
        if robot is None:
            log.warning("Home Assistant: %s, for no robot that it was told of", topic)
            return
        try:
            if what == "command":
                self._command(robot, text)
            elif what == "fan_speed":
                self._fan_speed(robot, text)
            elif what == "clean_segments":
                self._clean(robot, text)
        except StoreError as exc:
            log.error("Home Assistant: [%s] %s", robot, exc)

    def _command(self, robot: RobotId, text: str) -> None:
        if text == "start":
            # Home Assistant's start resumes a robot that is paused.
            row = self._store.robot(robot)
            if row is not None and row["can_resume"]:
                ability, params = COMMANDS["resume"]
            else:
                settings = {"mode": self._modes.get(robot, _MODE), "navigation_mode": "normal"}
                ability, params = cleaning([{"settings": settings, "map": None}])
        elif text in _PAYLOADS:
            ability, params = COMMANDS[_PAYLOADS[text]]
        else:
            log.warning("Home Assistant: [%s] no such command: %r", robot, text)
            return
        self._send(robot, ability, params)

    def _fan_speed(self, robot: RobotId, text: str) -> None:
        if text not in MODES:
            log.warning("Home Assistant: [%s] no such fan speed: %r", robot, text)
            return
        log.info("Home Assistant: [%s] starts in %s mode", robot, text)
        self._modes[robot] = text
        self._changed(robot)

    def _clean(self, robot: RobotId, text: str) -> None:
        """Have the robot clean the zones Home Assistant gives, as the segments of its map that they are."""
        try:
            given = json.loads(text)
        except (ValueError, RecursionError):
            given = None
        if not isinstance(given, list) or not given or not all(isinstance(each, str) for each in given):
            log.warning("Home Assistant: [%s] segments to clean that are no list of them: %r", robot, text)
            return
        tracks = self._store.tracks(robot)
        zones = {track["track_uuid"]: track for track in tracks if track["type"] == "cleaning"}
        unknown = [each for each in given if each not in zones]
        if unknown:
            log.warning("Home Assistant: [%s] no such zone to clean: %s", robot, ", ".join(unknown))
            return
        # One start cleans the zones of one floor plan (section 6.1 of the spec).
        if len({zones[each]["rank_uuid"] for each in given}) > 1:
            log.warning("Home Assistant: [%s] zones of more than one floor plan are not cleaned in one go", robot)
            return
        # As on the web UI, a robot starts on a floor plan only from its base.
        row = self._store.robot(robot)
        if row is None or not row["is_docked"]:
            log.warning("Home Assistant: [%s] the robot cleans zones only from its base, and is not on it", robot)
            return
        nogo = {track["rank_uuid"] for track in tracks if track["type"] == "no-go"}
        runs = [
            {
                # Each zone in the mode it was given, which is what it has the mode for.
                "settings": {"mode": zones[each]["mode"], "navigation_mode": "normal"},
                # And minding the floor plan's no-go lines where there are some.
                "map": {"rank_id": zones[each]["rank_uuid"], "track_id": each, "nogo_enabled": zones[each]["rank_uuid"] in nogo},
            }
            for each in dict.fromkeys(given)
        ]
        try:
            ability, params = cleaning(runs)
        except ValueError as exc:
            log.warning("Home Assistant: [%s] %s", robot, exc)
            return
        self._send(robot, ability, params)

    def _send(self, robot: RobotId, ability: str, params: dict) -> None:
        session = self._sessions.get(robot)
        if session is None:
            log.warning("Home Assistant: [%s] %s not sent: the robot is not connected", robot, ability)
            return
        log.info("Home Assistant: [%s] %s", robot, ability)
        task = asyncio.create_task(self._call(robot, session, ability, params))
        self._calls.add(task)
        task.add_done_callback(self._calls.discard)

    async def _call(self, robot: RobotId, session: Session, ability: str, params: dict) -> None:
        try:
            answer = await session.call(ability, params, timeout=_COMMAND_TIMEOUT)
        except TimeoutError:
            log.warning("Home Assistant: [%s] %s: the robot did not answer within %g s", robot, ability, _COMMAND_TIMEOUT)
        except OSError as exc:  # the session ended first
            log.warning("Home Assistant: [%s] %s: no answer from the robot: %s", robot, ability, describe(exc))
        else:
            # A start that the robot accepts may still fail, which it tells as an alert.
            if answer.get("code") != 200:
                log.warning("Home Assistant: [%s] %s: the robot answered %r", robot, ability, answer.get("code"))
