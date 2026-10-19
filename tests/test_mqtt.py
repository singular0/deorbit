"""Home Assistant tests: a real ``Mqtt`` beside a real ``Server``, connected to a broker that records what it is sent."""

import asyncio
import contextlib
import json
import re
import socket
import unittest
from unittest import mock

from deorbit import __main__ as cli
from deorbit import mqtt
from deorbit.auth import RobotId
from deorbit.commands import MODES, cleaning
from deorbit.config import Config
from deorbit.mqtt import Mqtt, activity
from tests.test_server import ServerTestCase
from tests.test_store import MAP, TIMING

# What a robot sends, as section 7.1 of the specification has it.
STATE = {
    "state": "idle",
    "action": "invalid",
    "errors": None,
    "available_commands": {"start": True, "cancel": False, "pause": False, "resume": False, "return_to_base": False},
    "details": {"is_charging": True, "is_docked": True, "charge": 81},
}
NODE = "n_board1"  # the robot of ``ServerTestCase`` in topics
DISCOVERY = f"homeassistant/device/deorbit_{NODE}/config"
# Two floor plans, the second with a run that began a day later.
PLAN = MAP["rank_uuid"]
OTHER_PLAN = "6a1d4b4e-6f0e-4a8b-9f2b-3d5c7e9a1b2c"
OTHER_MAP = {**MAP, "rank_uuid": OTHER_PLAN, "timing": {**TIMING, "start": "2026-10-07T08:30:00Z"}}
KITCHEN, HALL, STUDY = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
NOGO = "44444444-4444-4444-8444-444444444444"

CONNECT, CONNACK, PUBLISH, PUBACK, SUBSCRIBE, SUBACK, PINGREQ, PINGRESP, DISCONNECT = 1, 2, 3, 4, 8, 9, 12, 13, 14


def packet(kind: int, flags: int, body: bytes) -> bytes:
    """An MQTT control packet: its type and flags, the length of the rest, and the rest."""
    head, length = bytearray([kind << 4 | flags]), len(body)
    while True:
        byte, length = length & 0x7F, length >> 7
        head.append(byte | (0x80 if length else 0))
        if not length:
            return bytes(head) + body


def string(data: bytes) -> bytes:
    return len(data).to_bytes(2, "big") + data


def read_string(body: bytes, at: int) -> tuple[bytes, int]:
    size = int.from_bytes(body[at : at + 2], "big")
    return body[at + 2 : at + 2 + size], at + 2 + size


def matches(pattern: str, topic: str) -> bool:
    """Whether a topic filter, with its wildcards, takes in a topic."""
    wanted, given = pattern.split("/"), topic.split("/")
    for n, level in enumerate(wanted):
        if level == "#":
            return True
        if n >= len(given) or level not in ("+", given[n]):
            return False
    return len(wanted) == len(given)


class Broker:
    """An MQTT 3.1.1 broker of as much of it as deorbit uses, which keeps every message it is given."""

    def __init__(self, password: bytes | None = None) -> None:
        self.password = password  # the one a client must log in with, or None for any client
        self.retained: dict[str, bytes] = {}
        # Every message published by a client, or as a client's last will: its topic, its payload and whether it is retained.
        self.published: list[tuple[str, bytes, bool]] = []
        self.logins: list[tuple[bytes | None, bytes | None]] = []
        self._clients: dict[asyncio.StreamWriter, list[str]] = {}  # each connection, with the filters it subscribed to
        self._listener: asyncio.Server | None = None

    @property
    def port(self) -> int:
        return self._listener.sockets[0].getsockname()[1]

    async def start(self) -> None:
        self._listener = await asyncio.start_server(self._handle, "127.0.0.1", 0)

    async def stop(self) -> None:
        self._listener.close()
        self.drop()
        await self._listener.wait_closed()

    def drop(self) -> None:
        """End every connection as a network would, without a word."""
        for writer in list(self._clients):
            writer.transport.abort()

    def send(self, topic: str, payload: bytes, retain: bool = False) -> None:
        """Publish to the clients that subscribed to the topic, as another client would."""
        if retain:
            self.retained[topic] = payload
        for writer, filters in self._clients.items():
            if any(matches(pattern, topic) for pattern in filters):
                writer.write(packet(PUBLISH, int(retain), string(topic.encode()) + payload))

    def to(self, topic: str) -> list[bytes]:
        """What was published to the topic, oldest first."""
        return [payload for published, payload, _ in self.published if published == topic]

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        will, gone_by_word = None, False
        try:
            kind, _, body = await self._read(reader)
            assert kind == CONNECT
            _, at = read_string(body, 0)
            flags, at = body[at + 1], at + 4  # after the level, the flags and the keepalive
            _, at = read_string(body, at)  # the client's identifier
            offered = None
            if flags & 0x04:
                topic, at = read_string(body, at)
                message, at = read_string(body, at)
                offered = (topic.decode(), message, bool(flags & 0x20))
            username = password = None
            if flags & 0x80:
                username, at = read_string(body, at)
            if flags & 0x40:
                password, at = read_string(body, at)
            self.logins.append((username, password))
            if self.password is not None and password != self.password:
                writer.write(packet(CONNACK, 0, b"\x00\x05"))  # not authorised
                await writer.drain()
                return
            writer.write(packet(CONNACK, 0, b"\x00\x00"))
            self._clients[writer] = []
            will = offered  # of a connection that was taken
            while True:
                kind, flags, body = await self._read(reader)
                if kind == PUBLISH:
                    topic, at = read_string(body, 0)
                    if flags & 0x06:  # QoS 1
                        writer.write(packet(PUBACK, 0, body[at : at + 2]))
                        at += 2
                    self._publish(topic.decode(), body[at:], bool(flags & 0x01))
                elif kind == SUBSCRIBE:
                    at, granted, filters = 2, b"", []
                    while at < len(body):
                        pattern, at = read_string(body, at)
                        filters.append(pattern.decode())
                        granted, at = granted + b"\x00", at + 1
                    self._clients[writer].extend(filters)
                    writer.write(packet(SUBACK, 0, body[:2] + granted))
                    for topic, payload in self.retained.items():
                        if any(matches(pattern, topic) for pattern in filters):
                            writer.write(packet(PUBLISH, 1, string(topic.encode()) + payload))
                elif kind == PINGREQ:
                    writer.write(packet(PINGRESP, 0, b""))
                elif kind == DISCONNECT:
                    gone_by_word = True
                    return
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self._clients.pop(writer, None)
            if will is not None and not gone_by_word:
                self._publish(*will)
            writer.close()

    def _publish(self, topic: str, payload: bytes, retain: bool) -> None:
        self.published.append((topic, payload, retain))
        if retain and payload:
            self.retained[topic] = payload
        elif retain:
            self.retained.pop(topic, None)

    @staticmethod
    async def _read(reader: asyncio.StreamReader) -> tuple[int, int, bytes]:
        first, length, shift = (await reader.readexactly(1))[0], 0, 0
        while True:
            byte = (await reader.readexactly(1))[0]
            length |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return first >> 4, first & 0x0F, await reader.readexactly(length)


class MqttTestCase(ServerTestCase):
    ROBOT = RobotId("n", "board1")

    async def start(self, broker: Broker | None = None, **overrides: object) -> Mqtt:
        self.broker = broker or Broker()
        await self.broker.start()
        self.addAsyncCleanup(self.broker.stop)
        settings = {"mqtt_host": "127.0.0.1", "mqtt_port": self.broker.port, **overrides}
        server = await super().start(**settings)
        self.store = server.store
        self.mqtt = Mqtt(server)
        self.mqtt.start()
        self.addAsyncCleanup(self.mqtt.stop)
        return self.mqtt

    async def until(self, check, what: str = "the broker to be sent what was waited for"):
        """What ``check`` gives once it gives something, which it is asked for until it does."""
        try:
            async with asyncio.timeout(5):
                while not (found := check()):
                    await asyncio.sleep(0.01)
        except TimeoutError:
            self.fail(f"timed out waiting for {what}")
        return found

    async def retained(self, topic: str, check=lambda value: True) -> object:
        """The JSON the broker retains on the topic, once there is some that ``check`` takes."""
        def found() -> object:
            payload = self.broker.retained.get(topic)
            value = None if payload is None else json.loads(payload)
            return [value] if value is not None and check(value) else None

        return (await self.until(found, f"{topic} to be retained"))[0]

    async def published(self, topic: str, count: int = 1) -> list[object]:
        """The JSON of the first ``count`` messages published to the topic, once there are as many."""
        payloads = await self.until(lambda: len(self.broker.to(topic)) >= count and self.broker.to(topic), f"{count} on {topic}")
        return [json.loads(payload) for payload in payloads[:count]]

    async def announced(self) -> dict:
        """The robot's device, once it is announced."""
        return await self.retained(DISCOVERY)


class AnnounceTests(MqttTestCase):
    async def test_robot_is_announced_with_its_state(self) -> None:
        await self.start()
        self.store.save_state(self.ROBOT, STATE)
        device = await self.announced()
        self.assertEqual(self.broker.retained["deorbit/status"], b"online")
        self.assertEqual(
            device["device"],
            {"identifiers": [f"deorbit_{NODE}"], "name": "board1", "serial_number": "board1", "manufacturer": "Neato"},
        )
        self.assertEqual(device["origin"]["name"], "deorbit")
        components = device["components"]
        self.assertEqual(
            sorted(components),
            ["alert", "battery", "charging", "connected", "docked", "errors", "notification", "vacuum"],
        )
        for key, component in components.items():
            with self.subTest(key):
                self.assertEqual(component["unique_id"], f"deorbit_{NODE}_{key}")
        vacuum = components["vacuum"]
        self.assertEqual(vacuum["platform"], "vacuum")
        self.assertIsNone(vacuum["name"])
        self.assertEqual(
            {name: vacuum[name] for name in ("state_topic", "command_topic", "set_fan_speed_topic", "clean_segments_command_topic")},
            {
                "state_topic": f"deorbit/{NODE}/vacuum",
                "command_topic": f"deorbit/{NODE}/command",
                "set_fan_speed_topic": f"deorbit/{NODE}/fan_speed",
                "clean_segments_command_topic": f"deorbit/{NODE}/clean_segments",
            },
        )
        self.assertEqual(vacuum["fan_speed_list"], list(MODES))
        self.assertEqual(vacuum["supported_features"], ["start", "pause", "stop", "return_home", "locate", "fan_speed"])
        # Every entity goes with this server and the robot both, but for whether the robot is connected.
        there = [{"topic": "deorbit/status"}, {"topic": f"deorbit/{NODE}/availability"}]
        for key, component in components.items():
            with self.subTest(key):
                if key == "connected":
                    self.assertEqual(component["availability"], [{"topic": "deorbit/status"}])
                else:
                    self.assertEqual((component["availability"], component["availability_mode"]), (there, "all"))
        self.assertEqual(components["alert"]["event_types"], ["warning", "error", "critical"])
        self.assertEqual(components["notification"]["event_types"][-1], "other")
        await self.until(lambda: self.broker.retained.get(f"deorbit/{NODE}/availability") == b"offline")
        self.assertEqual(
            await self.retained(f"deorbit/{NODE}/vacuum"), {"state": "docked", "fan_speed": "eco", "segments": {}}
        )
        self.assertEqual(
            await self.retained(f"deorbit/{NODE}/state"),
            {"battery": 81, "charging": True, "docked": True, "errors": "none", "connected": False},
        )

    async def test_robots_in_the_database_are_announced_when_connected(self) -> None:
        # In the database before the server was, and announced as soon as the broker is reached.
        with mock.patch.object(Mqtt, "start"):
            await self.start()
        self.store.save_state(self.ROBOT, STATE)
        self.store.save_state(RobotId("n", "board2"), STATE)
        self.assertEqual(self.broker.published, [])
        Mqtt.start(self.mqtt)
        await self.announced()
        await self.retained("homeassistant/device/deorbit_n_board2/config")

    async def test_connected_robot_is_online(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send({"type": "event", "id": "s1", "to": {"service": "peer.state"}, "body": STATE})
        device = await self.retained(DISCOVERY, lambda device: "sw_version" in device["device"])
        self.assertEqual(device["device"]["sw_version"], "4.5.3-189")
        await self.until(lambda: self.broker.retained.get(f"deorbit/{NODE}/availability") == b"online")
        self.assertTrue((await self.retained(f"deorbit/{NODE}/state"))["connected"])
        robot.writer.close()
        await self.until(lambda: self.broker.retained.get(f"deorbit/{NODE}/availability") == b"offline")
        self.assertFalse((await self.retained(f"deorbit/{NODE}/state", lambda state: not state["connected"]))["connected"])
        # The firmware outlives the connection that gave it.
        self.assertEqual((await self.announced())["device"]["sw_version"], "4.5.3-189")

    async def test_state_follows_the_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        busy = {**STATE, "state": "busy", "action": "cleaning", "details": {"is_charging": False, "is_docked": False, "charge": 64},
                "errors": [{"code": "dustbin_missing", "severity": "warning"}, {"code": "brush_stuck", "severity": "error"}]}
        await robot.send({"type": "event", "id": "s1", "to": {"service": "peer.state"}, "body": busy})
        await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: vacuum["state"] == "cleaning")
        self.assertEqual(
            await self.retained(f"deorbit/{NODE}/state", lambda state: state["battery"] == 64),
            {"battery": 64, "charging": False, "docked": False, "errors": "dustbin_missing, brush_stuck", "connected": True},
        )

    async def test_what_is_not_changed_is_not_published_again(self) -> None:
        await self.start()
        self.store.save_state(self.ROBOT, STATE)
        await self.retained(f"deorbit/{NODE}/state")
        for _ in range(3):
            self.store.save_heartbeat(self.ROBOT)
        self.store.save_state(self.ROBOT, {**STATE, "details": {**STATE["details"], "charge": 82}})
        await self.retained(f"deorbit/{NODE}/state", lambda state: state["battery"] == 82)
        self.assertEqual(len(self.broker.to(f"deorbit/{NODE}/state")), 2)
        self.assertEqual(len(self.broker.to(DISCOVERY)), 1)

    async def test_named_robot(self) -> None:
        await self.start()
        self.store.save_state(self.ROBOT, STATE)
        await self.announced()
        self.store.save_name(self.ROBOT, "Living room")
        await self.retained(DISCOVERY, lambda device: device["device"]["name"] == "Living room")

    async def test_deleted_robot_is_taken_away(self) -> None:
        # Deleting the robot deletes its key, so out of a copy of the keys.
        await self.start(keys=self.registry())
        self.store.save_state(self.ROBOT, STATE)
        await self.retained(f"deorbit/{NODE}/state")  # the last of what is announced
        with self.assertLogs("deorbit.mqtt", "INFO") as logs:
            await self.server.delete(self.ROBOT)
            await self.until(lambda: not any(NODE in topic for topic in self.broker.retained))
            await self.until(lambda: logs.output)
        self.assertIn("[n/board1] taken away", logs.output[-1])

    async def test_announced_again_when_home_assistant_starts(self) -> None:
        await self.start()
        self.store.save_state(self.ROBOT, STATE)
        await self.announced()
        self.broker.send("homeassistant/status", b"online")
        await self.until(lambda: len(self.broker.to(DISCOVERY)) == 2)
        # Home Assistant going away asks for nothing.
        self.broker.send("homeassistant/status", b"offline")
        self.broker.send(f"deorbit/{NODE}/fan_speed", b"max")
        await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: vacuum["fan_speed"] == "max")
        self.assertEqual(len(self.broker.to(DISCOVERY)), 2)

    async def test_lost_connection_is_made_again(self) -> None:
        with mock.patch.object(mqtt, "_RETRY", 0.05):
            await self.start()
            self.store.save_state(self.ROBOT, STATE)
            await self.announced()
            with self.assertLogs("deorbit.mqtt", "INFO") as logs:
                self.broker.drop()
                # The broker publishes the last will, and the server comes back and says it is there.
                await self.until(lambda: self.broker.to("deorbit/status")[-1:] == [b"offline"])
                await self.until(lambda: self.broker.to("deorbit/status")[-1:] == [b"online"])
                # And it publishes all again, which the broker may have lost.
                await self.until(lambda: len(self.broker.to(DISCOVERY)) == 2)
        self.assertIn("no connection to the MQTT broker", logs.output[0])
        self.assertIn("connected to the MQTT broker", logs.output[-1])

    async def test_robot_deleted_while_there_was_no_connection(self) -> None:
        with mock.patch.object(mqtt, "_RETRY", 0.3):
            await self.start(keys=self.registry())
            self.store.save_state(self.ROBOT, STATE)
            await self.announced()
            with self.assertLogs("deorbit.mqtt", "WARNING"):
                self.broker.drop()
                await self.until(lambda: self.broker.to("deorbit/status")[-1:] == [b"offline"])
                await self.server.delete(self.ROBOT)
                await self.until(lambda: self.broker.to("deorbit/status")[-1:] == [b"online"])
            await self.until(lambda: DISCOVERY not in self.broker.retained)

    async def test_stopped_server_says_it_is_gone(self) -> None:
        await self.start()
        await self.until(lambda: self.broker.retained.get("deorbit/status") == b"online")
        await self.mqtt.stop()
        self.assertEqual(self.broker.retained["deorbit/status"], b"offline")
        self.assertEqual(self.broker.to("deorbit/status"), [b"online", b"offline"])

    async def test_broker_that_cannot_be_reached(self) -> None:
        with socket.create_server(("127.0.0.1", 0)) as taken:
            port = taken.getsockname()[1]
        with mock.patch.object(mqtt, "_RETRY", 0.05), self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            await self.start(mqtt_port=port)
            await asyncio.sleep(0.3)
        # Tried again and again, and said once.
        (line,) = logs.output
        self.assertRegex(line, rf"no connection to the MQTT broker at 127\.0\.0\.1:{port}: .+; trying again every 0\.05 s$")
        # And the web UI is told why.
        status = self.mqtt.status()
        self.assertFalse(status["connected"])
        self.assertIn(f": {status['error']}; trying again", line)

    async def test_status_follows_the_connection(self) -> None:
        with mock.patch.object(Mqtt, "start"):
            await self.start()
        # Not connected before the first try, and with nothing to say why.
        self.assertEqual(self.mqtt.status(), {"connected": False, "error": None})
        with mock.patch.object(mqtt, "_RETRY", 0.3):
            Mqtt.start(self.mqtt)
            await self.until(lambda: self.mqtt.status()["connected"], "the broker to be connected")
            self.assertEqual(self.mqtt.status(), {"connected": True, "error": None})
            with self.assertLogs("deorbit.mqtt", "INFO") as logs:
                self.broker.drop()
                lost = await self.until(lambda: not self.mqtt.status()["connected"] and self.mqtt.status(), "the loss")
                await self.until(lambda: self.mqtt.status()["connected"], "the broker to be connected again")
        self.assertIn(f": {lost['error']}; trying again", logs.output[0])
        self.assertEqual(self.mqtt.status(), {"connected": True, "error": None})

    async def test_status_after_what_was_not_foreseen(self) -> None:
        with mock.patch.object(mqtt, "_RETRY", 0.3), mock.patch.object(Mqtt, "_announce", side_effect=RuntimeError("bug")):
            with self.assertLogs("deorbit.mqtt", "ERROR"):
                await self.start()
                await self.until(lambda: self.mqtt.status()["error"], "the failure")
        self.assertEqual(self.mqtt.status(), {"connected": False, "error": "an unexpected error, which is in the server's log"})

    async def test_login(self) -> None:
        await self.start(Broker(password=b"secret"), mqtt_username="deorbit", mqtt_password="secret")
        await self.until(lambda: self.broker.retained.get("deorbit/status") == b"online")
        self.assertEqual(self.broker.logins, [(b"deorbit", b"secret")])

    async def test_login_refused(self) -> None:
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            await self.start(Broker(password=b"secret"), mqtt_username="deorbit", mqtt_password="wrong")
            await self.until(lambda: logs.output)
        self.assertIn("no connection to the MQTT broker", logs.output[0])
        self.assertNotIn("deorbit/status", self.broker.retained)

    async def test_no_login_without_a_username(self) -> None:
        await self.start()
        await self.until(lambda: self.broker.logins)
        self.assertEqual(self.broker.logins, [(None, None)])

    async def test_other_topics(self) -> None:
        await self.start(mqtt_topic="home/robots", mqtt_discovery_prefix="ha")
        self.store.save_state(self.ROBOT, STATE)
        device = await self.retained(f"ha/device/deorbit_{NODE}/config")
        self.assertEqual(device["components"]["vacuum"]["command_topic"], f"home/robots/{NODE}/command")
        await self.until(lambda: self.broker.retained.get("home/robots/status") == b"online")
        # Home Assistant's birth message is under the prefix too.
        self.broker.send("ha/status", b"online")
        await self.until(lambda: len(self.broker.to(f"ha/device/deorbit_{NODE}/config")) == 2)

    async def test_robot_with_names_that_topics_cannot_carry(self) -> None:
        await self.start()
        for serial in ("a/b+c#", "a_b_c"):
            self.store.save_state(RobotId("x_y", serial), STATE)
        await self.until(lambda: len([topic for topic in self.broker.retained if topic.endswith("/config")]) == 2)
        nodes = sorted(topic.split("/")[2] for topic in self.broker.retained if topic.endswith("/config"))
        for node in nodes:
            self.assertRegex(node, r"^deorbit_x_y_a_b_c__?[0-9a-f]{8}$")
        self.assertNotEqual(*nodes)
        self.assertEqual(mqtt._node(RobotId("n", "board1")), "n_board1")


class ActivityTests(unittest.TestCase):
    def test_what_home_assistant_shows(self) -> None:
        cases = [
            ({"state": "idle", "action": "invalid", "is_docked": 1}, "docked"),
            ({"state": "idle", "action": "invalid", "is_docked": 0}, "idle"),
            ({"state": "busy", "action": "cleaning", "is_docked": 0}, "cleaning"),
            ({"state": "busy", "action": "cleaning_standby", "is_docked": 1}, "cleaning"),
            ({"state": "busy", "action": "docking", "is_docked": 0}, "returning"),
            ({"state": "busy", "action": "updating_software", "is_docked": 1}, "docked"),
            ({"state": "busy", "action": "diagnostic_test", "is_docked": 0}, "idle"),
            ({"state": "paused", "action": "cleaning", "is_docked": 0}, "paused"),
            ({"state": "error", "action": "invalid", "is_docked": 1}, "error"),
            ({"state": None, "action": None, "is_docked": None}, "idle"),
            ({"state": "asleep", "action": "dreaming", "is_docked": 1}, "docked"),
        ]
        for row, shown in cases:
            with self.subTest(row):
                self.assertEqual(activity(row), shown)

    def test_errors(self) -> None:
        cases = [
            (None, "none"),
            ("[]", "none"),
            ('[{"code":"dustbin_missing","severity":"warning"}]', "dustbin_missing"),
            ('[{"severity":"warning"},"x",{"code":5}]', "none"),
            ("not json", "not json"),
            (json.dumps([{"code": "x" * 300}]), "x" * 255),
        ]
        for errors, shown in cases:
            with self.subTest(errors):
                self.assertEqual(mqtt._errors({"errors": errors}), shown)

    def test_charge(self) -> None:
        for charge, shown in ((81, 81), (80.5, 80.5), (float("inf"), None), (True, None), ("81", None), (None, None)):
            with self.subTest(charge):
                self.assertEqual(mqtt._charge({"charge": charge}), shown)


class RobotTestCase(MqttTestCase):
    """With the robot connected and its state announced."""

    async def start(self, broker: Broker | None = None, state: dict = STATE, **overrides: object) -> Mqtt:
        await super().start(broker, **overrides)
        self.robot, _ = await self.login()
        await self.robot.send({"type": "event", "id": "s1", "to": {"service": "peer.state"}, "body": state})
        await self.until(lambda: self.broker.retained.get(f"deorbit/{NODE}/availability") == b"online")
        return self.mqtt

    async def asked(self, topic: str, payload: bytes, answer: dict | None = None) -> dict:
        """Publish ``payload`` as Home Assistant would, and return the body of the request the robot is sent, which it answers."""
        self.broker.send(f"deorbit/{NODE}/{topic}", payload)
        request = await self.robot.recv()
        await self.robot.send({"type": "response", "id": request["id"], **(answer or {"code": 200, "body": {}})})
        return request["body"]

    async def nothing_sent(self) -> None:
        """Check that the robot was sent nothing, by asking it something else and having that come first."""
        self.assertEqual(await self.asked("command", b"locate"), {"ability": "utilities.find_me"})


class CommandTests(RobotTestCase):
    async def test_commands(self) -> None:
        await self.start()
        cases = {
            b"pause": {"ability": "cleaning.pause"},
            b"stop": {"ability": "cleaning.cancel"},
            b"return_to_base": {"ability": "navigation.return_to_base"},
            b"locate": {"ability": "utilities.find_me"},
            b"start": {"ability": "cleaning.start",
                       "runs": [{"settings": {"mode": "eco", "navigation_mode": "normal"}, "map": None}]},
        }
        for payload, sent in cases.items():
            with self.subTest(payload):
                self.assertEqual(await self.asked("command", payload), sent)

    async def test_start_resumes_a_robot_that_is_paused(self) -> None:
        paused = {**STATE, "state": "paused", "available_commands": {**STATE["available_commands"], "resume": True}}
        await self.start(state=paused)
        await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: vacuum["state"] == "paused")
        self.assertEqual(await self.asked("command", b"start"), {"ability": "cleaning.resume"})

    async def test_fan_speed_is_the_mode_of_a_start(self) -> None:
        await self.start()
        with self.assertLogs("deorbit.mqtt", "INFO") as logs:
            self.broker.send(f"deorbit/{NODE}/fan_speed", b"turbo")
            await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: vacuum["fan_speed"] == "turbo")
            self.broker.send(f"deorbit/{NODE}/fan_speed", b"loud")
            sent = await self.asked("command", b"start")
        self.assertEqual(sent["runs"][0]["settings"], {"mode": "turbo", "navigation_mode": "normal"})
        self.assertIn("no such fan speed: 'loud'", "\n".join(logs.output))
        self.assertEqual((await self.retained(f"deorbit/{NODE}/vacuum"))["fan_speed"], "turbo")

    async def test_what_is_not_carried_out(self) -> None:
        await self.start()
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            self.broker.send(f"deorbit/{NODE}/command", b"clean_spot")
            self.broker.send("deorbit/n_board9/command", b"start")
            await self.nothing_sent()
        self.assertIn("no such command: 'clean_spot'", logs.output[0])
        self.assertIn("deorbit/n_board9/command, for no robot that it was told of", logs.output[1])

    async def test_retained_command_is_not_carried_out(self) -> None:
        broker = Broker()
        broker.retained[f"deorbit/{NODE}/command"] = b"start"
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            await self.start(broker)
            await self.nothing_sent()
        self.assertIn(f"deorbit/{NODE}/command that the broker retained is ignored", logs.output[0])

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        self.robot.writer.close()
        await self.until(lambda: self.broker.retained.get(f"deorbit/{NODE}/availability") == b"offline")
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            self.broker.send(f"deorbit/{NODE}/command", b"pause")
            await self.until(lambda: logs.output)
        self.assertIn("[n/board1] cleaning.pause not sent: the robot is not connected", logs.output[0])

    async def test_what_the_robot_refuses_is_logged(self) -> None:
        await self.start()
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            await self.asked("command", b"pause", {"code": 409, "body": {}})
            await self.until(lambda: logs.output)
        self.assertIn("[n/board1] cleaning.pause: the robot answered 409", logs.output[0])


class SegmentTests(RobotTestCase):
    """Zones of the floor plans the robot keeps, which Home Assistant cleans as segments."""

    def plans(self, *, second: bool = False) -> None:
        self.store.save_map(self.ROBOT, MAP)
        self.store.save_floorplan(self.ROBOT, PLAN, 1)
        self.store.save_track(self.ROBOT, PLAN, KITCHEN, "cleaning", "Kitchen", "turbo", [1, 2, 3, 4])
        self.store.save_track(self.ROBOT, PLAN, HALL, "cleaning", "Hall", "eco", [5, 6, 7, 8])
        self.store.save_track(self.ROBOT, PLAN, NOGO, "no-go", None, None, [[1, 1, 5, 1]])
        if second:
            self.store.save_map(self.ROBOT, OTHER_MAP)
            self.store.save_floorplan(self.ROBOT, OTHER_PLAN, 2)
            self.store.save_track(self.ROBOT, OTHER_PLAN, STUDY, "cleaning", "Study", "max", [1, 1, 2, 2])

    async def segments(self, count: int) -> dict[str, str]:
        vacuum = await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: len(vacuum["segments"]) == count)
        return vacuum["segments"]

    async def test_zones_are_segments(self) -> None:
        await self.start()
        self.plans()
        self.assertEqual(await self.segments(2), {KITCHEN: "Kitchen", HALL: "Hall"})
        self.store.delete_tracks(self.ROBOT, [HALL])
        self.assertEqual(await self.segments(1), {KITCHEN: "Kitchen"})

    async def test_zones_of_several_floor_plans_say_which(self) -> None:
        await self.start()
        self.plans(second=True)
        # As the web UI calls a floor plan: by when the run of its map began, in the robot's time zone.
        self.assertEqual(
            await self.segments(3),
            {KITCHEN: "Kitchen (06.10.2026 13:00)", HALL: "Hall (06.10.2026 13:00)", STUDY: "Study (07.10.2026 09:30)"},
        )
        self.store.save_map_name(self.ROBOT, 2, "Upstairs")
        await self.retained(f"deorbit/{NODE}/vacuum", lambda vacuum: vacuum["segments"][STUDY] == "Study (Upstairs)")

    async def test_zones_are_cleaned(self) -> None:
        await self.start()
        self.plans()
        await self.segments(2)
        sent = await self.asked("clean_segments", json.dumps([HALL, KITCHEN, HALL]).encode())
        self.assertEqual(sent, {
            "ability": "cleaning.start",
            "runs": [
                {"settings": {"mode": "eco", "navigation_mode": "normal"},
                 "map": {"rank_id": PLAN, "track_id": HALL, "nogo_enabled": True}},
                {"settings": {"mode": "turbo", "navigation_mode": "normal"},
                 "map": {"rank_id": PLAN, "track_id": KITCHEN, "nogo_enabled": True}},
            ],
        })

    async def test_zones_without_no_go_lines(self) -> None:
        await self.start()
        self.plans(second=True)
        await self.segments(3)
        sent = await self.asked("clean_segments", json.dumps([STUDY]).encode())
        self.assertEqual(sent["runs"], [{"settings": {"mode": "max", "navigation_mode": "normal"},
                                         "map": {"rank_id": OTHER_PLAN, "track_id": STUDY, "nogo_enabled": False}}])

    async def test_zones_that_are_not_cleaned(self) -> None:
        await self.start()
        self.plans(second=True)
        await self.segments(3)
        cases = {
            b"[]": "segments to clean that are no list of them: '[]'",
            b'"kitchen"': "segments to clean that are no list of them",
            b"[1]": "segments to clean that are no list of them",
            b"not json": "segments to clean that are no list of them",
            json.dumps([KITCHEN, "elsewhere"]).encode(): "no such zone to clean: elsewhere",
            json.dumps([NOGO]).encode(): f"no such zone to clean: {NOGO}",
            json.dumps([KITCHEN, STUDY]).encode(): "zones of more than one floor plan are not cleaned in one go",
        }
        for payload, problem in cases.items():
            with self.subTest(payload), self.assertLogs("deorbit.mqtt", "WARNING") as logs:
                self.broker.send(f"deorbit/{NODE}/clean_segments", payload)
                await self.until(lambda: logs.output)
            self.assertIn(problem, logs.output[0])
        await self.nothing_sent()

    async def test_zones_are_cleaned_only_from_the_base(self) -> None:
        await self.start(state={**STATE, "details": {**STATE["details"], "is_docked": False}})
        self.plans()
        await self.segments(2)
        with self.assertLogs("deorbit.mqtt", "WARNING") as logs:
            self.broker.send(f"deorbit/{NODE}/clean_segments", json.dumps([KITCHEN]).encode())
            await self.nothing_sent()
        self.assertIn("the robot cleans zones only from its base, and is not on it", logs.output[0])


class AlertTests(RobotTestCase):
    async def message(self, kind: str, service: str, body: dict) -> None:
        await self.robot.send({"type": kind, "id": "m1", "to": {"service": service}, "body": body})

    async def test_alerts_and_notifications_are_events(self) -> None:
        await self.start()
        await self.message("event", "robots.error_codes", {"code": "dustbin_missing", "severity": "warning", "created": None})
        await self.message("request", "robots.notify", {"message_code": "fuel_less_than_10", "payload": None})
        await self.message("request", "robots.notify", {"message_code": "pm_load_fail", "payload": {"x": 1}})
        await self.message("event", "robots.error_codes", {"code": "pm_load_fail", "severity": "error", "created": None})
        alerts = await self.published(f"deorbit/{NODE}/alert", 2)
        self.assertEqual(alerts, [{"event_type": "warning", "code": "dustbin_missing"},
                                  {"event_type": "error", "code": "pm_load_fail"}])
        notifications = await self.published(f"deorbit/{NODE}/notification", 2)
        self.assertEqual(notifications, [
            {"event_type": "fuel_less_than_10", "code": "fuel_less_than_10", "payload": None},
            {"event_type": "other", "code": "pm_load_fail", "payload": {"x": 1}},
        ])
        # An event is news, and is not kept for whoever subscribes later.
        retained = {topic: retain for topic, _, retain in self.broker.published if topic.endswith(("/alert", "/notification"))}
        self.assertEqual(retained, {f"deorbit/{NODE}/alert": False, f"deorbit/{NODE}/notification": False})

    async def test_what_is_not_an_event(self) -> None:
        await self.start()
        await self.message("event", "robots.error_codes", {"code": "dustbin_missing", "severity": "dire"})
        await self.message("event", "robots.error_codes", {"severity": "error"})
        await self.message("request", "robots.notify", {"payload": None})
        await self.message("request", "robots.notify", ["not", "an", "object"])
        await self.message("event", "robots.error_codes", {"code": "last", "severity": "critical"})
        self.assertEqual(await self.published(f"deorbit/{NODE}/alert"), [{"event_type": "critical", "code": "last"}])
        self.assertEqual(self.broker.to(f"deorbit/{NODE}/notification"), [])

    async def test_what_happened_before_is_no_news(self) -> None:
        broker = Broker()
        with mock.patch.object(Mqtt, "start"):
            await MqttTestCase.start(self, broker)
        self.store.add_event(self.ROBOT, "event", "robots.error_codes", {"code": "old", "severity": "error"})
        self.store.save_state(self.ROBOT, STATE)
        Mqtt.start(self.mqtt)
        await self.announced()
        self.store.add_event(self.ROBOT, "event", "robots.error_codes", {"code": "new", "severity": "error"})
        self.assertEqual(await self.published(f"deorbit/{NODE}/alert"), [{"event_type": "error", "code": "new"}])


class CleaningTests(unittest.TestCase):
    """``commands.cleaning``, the start of several runs that cleaning segments sends."""

    def test_runs_are_checked(self) -> None:
        run = {"settings": {"mode": "eco", "navigation_mode": "normal"}, "map": {"rank_id": PLAN, "track_id": KITCHEN, "nogo_enabled": False}}
        self.assertEqual(cleaning([run, run]), ("cleaning.start", {"runs": [run, run]}))
        cases = {
            "runs must be a list of one or more runs": [],
            "runs[0].settings.mode must be one of": [{**run, "settings": {"mode": "loud", "navigation_mode": "normal"}}],
            "runs, when more than one, must each have a map of the same rank_id": [run, {**run, "map": {**run["map"], "rank_id": OTHER_PLAN}}],
        }
        for problem, runs in cases.items():
            with self.subTest(problem), self.assertRaisesRegex(ValueError, f"^{re.escape(problem)}"):
                cleaning(runs)


class ServeTests(ServerTestCase):
    """``_serve`` with Home Assistant: the robots' listener and the MQTT client together."""

    async def test_mqtt_until_cancelled(self) -> None:
        broker = Broker()
        await broker.start()
        self.addAsyncCleanup(broker.stop)
        config = Config(
            cert=self.dir / "certs" / "server.crt",
            key=self.dir / "certs" / "server.key",
            host="127.0.0.1",
            port=0,
            web=False,
            database=self.dir / "db" / f"{self.id()}.db",
            mqtt_host="127.0.0.1",
            mqtt_port=broker.port,
        )
        with self.assertLogs("deorbit", "INFO") as logs:
            serving = asyncio.create_task(cli._serve(config))
            async with asyncio.timeout(5):
                while not any("connected to the MQTT broker" in line for line in logs.output):
                    await asyncio.sleep(0.01)
            serving.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await serving
        self.assertEqual(broker.retained["deorbit/status"], b"offline")

    async def test_web_ui_says_whether_the_broker_is_connected(self) -> None:
        broker = Broker()
        await broker.start()
        self.addAsyncCleanup(broker.stop)
        config = Config(
            cert=self.dir / "certs" / "server.crt",
            key=self.dir / "certs" / "server.key",
            host="127.0.0.1",
            port=0,
            web_host="127.0.0.1",
            web_port=0,
            database=self.dir / "db" / f"{self.id()}.db",
            mqtt_host="127.0.0.1",
            mqtt_port=broker.port,
        )
        with self.assertLogs("deorbit", "INFO") as logs:
            serving = asyncio.create_task(cli._serve(config))
            try:
                async with asyncio.timeout(5):
                    while not any("connected to the MQTT broker" in line for line in logs.output):
                        await asyncio.sleep(0.01)
                port = int(re.search(r"web UI on http://127\.0\.0\.1:(\d+)", "\n".join(logs.output))[1])
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.write(b"GET /api/robots HTTP/1.1\r\n\r\n")
                async with asyncio.timeout(5):
                    answer = await reader.read()
                writer.close()
            finally:
                serving.cancel()
                await asyncio.gather(serving, return_exceptions=True)
        told = json.loads(answer.partition(b"\r\n\r\n")[2])
        self.assertEqual(told["home_assistant"], {"connected": True, "error": None})

    async def test_no_mqtt_without_a_host(self) -> None:
        config = Config(
            cert=self.dir / "certs" / "server.crt",
            key=self.dir / "certs" / "server.key",
            host="127.0.0.1",
            port=0,
            web=False,
            database=self.dir / "db" / f"{self.id()}.db",
        )
        with mock.patch.object(cli, "Mqtt") as made, self.assertLogs("deorbit", "INFO") as logs:
            serving = asyncio.create_task(cli._serve(config))
            async with asyncio.timeout(5):
                while not any("listening on" in line for line in logs.output):
                    await asyncio.sleep(0.01)
            serving.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await serving
        made.assert_not_called()
