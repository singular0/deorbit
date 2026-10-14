"""End-to-end tests: a scripted robot talks to a real server over TLS."""

import asyncio
import base64
import contextlib
import json
import shutil
import sqlite3
import ssl
import struct
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from deorbit import certs
from deorbit.auth import RobotId
from deorbit.config import Config
from deorbit.server import Server
from deorbit.session import Session

HEARTBEAT = b"\x06"
CLOSE = b"\x00"


def frame(payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + payload


def signed_login(key: rsa.RSAPrivateKey, vendor: str = "N", serial: str = "BOARD1", when: datetime | None = None) -> dict:
    stamp = (when or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    message = f"{vendor.lower()}\n{serial.lower()}\n{stamp}".encode()
    signature = key.sign(message, padding.PKCS1v15(), hashes.SHA256())
    return {
        "vendor": vendor,
        "datetime": stamp,
        "serial": serial,
        "signature": base64.b64encode(signature).decode(),
        "firmware": "4.5.3-189",
    }


class Robot:
    """The robot's end of the connection, scripted by the tests."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer

    async def send_bytes(self, payload: bytes) -> None:
        self.writer.write(frame(payload))
        await self.writer.drain()

    async def send(self, message: dict) -> None:
        await self.send_bytes(json.dumps(message).encode())

    async def recv_bytes(self) -> bytes:
        async with asyncio.timeout(5):
            (size,) = struct.unpack(">I", await self.reader.readexactly(4))
            return await self.reader.readexactly(size)

    async def recv(self) -> dict:
        """The next JSON message, skipping heartbeats."""
        while (payload := await self.recv_bytes()) == HEARTBEAT:
            pass
        return json.loads(payload)

    async def request(self, service: str, body: object, request_id: str = "r1") -> dict:
        await self.send({"type": "request", "id": request_id, "to": {"service": service}, "body": body})
        return await self.recv()

    async def wait_closed(self) -> None:
        """Return once the server has closed the connection; time out if it never does."""
        async with asyncio.timeout(5):
            with contextlib.suppress(OSError):
                await self.reader.read()


class ServerTestCase(unittest.IsolatedAsyncioTestCase):
    ROBOT = RobotId("n", "board1")

    @classmethod
    def setUpClass(cls) -> None:
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        cls.dir = Path(tmp.name)
        certs.generate(cls.dir / "certs" / "server.crt", cls.dir / "certs" / "server.key", ["localhost"])
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        registry = cls.dir / "keys" / "N"
        registry.mkdir(parents=True)
        (registry / "BOARD1.pem").write_bytes(
            cls.key.public_key().public_bytes(
                serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
            )
        )

    async def start(self, **overrides: object) -> Server:
        settings = {
            "keys": self.dir / "keys",
            "timezone": "Europe/London",
            # One database per test; the directory lasts as long as the class.
            "database": self.dir / "db" / f"{self.id()}.db",
            **overrides,
        }
        config = Config(
            cert=self.dir / "certs" / "server.crt",
            key=self.dir / "certs" / "server.key",
            host="127.0.0.1",
            port=0,
            **settings,
        )
        self.server = Server(config)
        self.server.start()
        serving = asyncio.create_task(self.server.serve_forever())

        async def stop() -> None:
            serving.cancel()
            await self.server.stop()

        self.addAsyncCleanup(stop)
        return self.server

    def registry(self) -> Path:
        """A copy of the class's directory of keys for this test alone, since deleting a robot takes its key out of one."""
        keys = self.dir / "registries" / self.id()
        shutil.copytree(self.dir / "keys", keys)
        return keys

    async def connect(self, context: ssl.SSLContext | None = None) -> Robot:
        if context is None:
            context = ssl.create_default_context(cafile=self.dir / "certs" / "ca.crt")
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", self.server.port, ssl=context, server_hostname="localhost"
        )
        self.addCleanup(writer.close)
        return Robot(reader, writer)

    async def login(self) -> tuple[Robot, Session]:
        robot = await self.connect()
        await robot.send(signed_login(self.key))
        self.assertEqual((await robot.recv())["code"], 200)
        return robot, self.server.sessions[self.ROBOT]


class LoginTests(ServerTestCase):
    async def test_login_response(self) -> None:
        await self.start()
        robot = await self.connect()
        await robot.send(signed_login(self.key))
        self.assertEqual(
            await robot.recv(),
            {"code": 200, "body": {"ip_address": "127.0.0.1", "timezone": "Europe/London"}},
        )

    async def test_login_frame_split_across_writes(self) -> None:
        await self.start()
        robot = await self.connect()
        data = frame(json.dumps(signed_login(self.key)).encode())
        for chunk in (data[:2], data[2:5], data[5:40], data[40:]):
            robot.writer.write(chunk)
            await robot.writer.drain()
            await asyncio.sleep(0.01)
        self.assertEqual((await robot.recv())["code"], 200)

    async def test_tampered_login_is_rejected(self) -> None:
        await self.start()
        login = signed_login(self.key)
        later = datetime.now(timezone.utc) + timedelta(seconds=1)
        forged = bytearray(base64.b64decode(login["signature"]))
        forged[-1] ^= 1
        tampered = {
            "vendor": "3",
            "serial": "BOARD2",
            "datetime": later.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "signature": base64.b64encode(forged).decode(),
        }
        for field, value in tampered.items():
            with self.subTest(field=field):
                robot = await self.connect()
                await robot.send({**login, field: value})
                self.assertEqual(await robot.recv(), {"code": 401})
                await robot.wait_closed()
        self.assertEqual(self.server.sessions, {})

    async def test_replayed_login_is_rejected(self) -> None:
        await self.start()
        login = signed_login(self.key)
        first = await self.connect()
        await first.send(login)
        self.assertEqual((await first.recv())["code"], 200)
        second = await self.connect()
        await second.send(login)
        self.assertEqual(await second.recv(), {"code": 401})

    async def test_stale_login_is_rejected(self) -> None:
        await self.start()
        robot = await self.connect()
        await robot.send(signed_login(self.key, when=datetime.now(timezone.utc) - timedelta(hours=1)))
        self.assertEqual(await robot.recv(), {"code": 401})

    async def test_malformed_login_is_rejected(self) -> None:
        await self.start()
        robot = await self.connect()
        await robot.send({"vendor": "N"})
        self.assertEqual(await robot.recv(), {"code": 400})
        await robot.wait_closed()

    async def test_without_keys_any_robot_may_log_in(self) -> None:
        await self.start(keys=None)
        robot = await self.connect()
        await robot.send({"vendor": "N", "serial": "UNKNOWN", "datetime": "whenever", "signature": "none"})
        self.assertEqual((await robot.recv())["code"], 200)
        self.assertIn(RobotId("n", "unknown"), self.server.sessions)

    async def test_newer_login_replaces_the_older_session(self) -> None:
        await self.start()
        first, older = await self.login()
        second, newer = await self.login()
        await first.wait_closed()
        self.assertIsNot(newer, older)
        self.assertEqual((await second.request("firmware.check", {}))["id"], "r1")
        self.assertIs(self.server.sessions[self.ROBOT], newer)

    async def test_rejected_certificate_is_logged(self) -> None:
        await self.start()
        with self.assertLogs("deorbit", "WARNING") as logs:
            with self.assertRaises(ssl.SSLError):
                await self.connect(ssl.create_default_context())
            async with asyncio.timeout(5):
                while not logs.output:
                    await asyncio.sleep(0.01)
        self.assertIn("TLS handshake failed", logs.output[0])


class RobotServiceTests(ServerTestCase):
    async def test_services_that_get_a_reply(self) -> None:
        await self.start()
        robot, _ = await self.login()
        link = await robot.request("robots.link", {"user_id": "u1", "timezone": "Europe/London"}, "a")
        self.assertEqual((link["type"], link["id"], link["code"]), ("response", "a", 201))
        firmware = await robot.request("firmware.check", {"version": "4.5.3", "only_mandatory": False}, "b")
        self.assertEqual(firmware["id"], "b")
        self.assertNotEqual(firmware["code"], 200)
        created = await robot.request("maps.create", {"map": {"rank_binary": "AAAA", "real_binary": "AAAA"}}, "c")
        self.assertEqual((created["id"], created["code"], created["body"]), ("c", 201, {"floorplan": False}))

    async def test_fire_and_forget_services_get_no_reply(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send({"type": "event", "id": "e1", "to": {"service": "peer.state"},
                          "body": {"ability": "state.show", "state": "idle"}})
        await robot.send({"type": "event", "id": "e2", "to": {"service": "robots.error_codes"},
                          "body": {"code": "dustbin_missing", "severity": "warning", "created": "2026-10-06_12-34-56"}})
        await robot.send({"type": "request", "id": "n1", "to": {"service": "robots.notify"},
                          "body": {"message_code": "fuel_less_than_10", "payload": None}})
        # Messages are handled in order, so the first thing to come back is
        # the answer to this last request.
        self.assertEqual((await robot.request("firmware.check", {}, "last"))["id"], "last")

    async def test_log_upload_reuses_the_job_id(self) -> None:
        await self.start()
        robot, _ = await self.login()
        files = {"files": [{"path": "/user/black_box/power.csv", "last_mtime": 0, "size": 10, "type": "robot"}]}
        listed = await robot.request("logs.list_files", files, "job")
        self.assertEqual(listed["code"], 200)
        self.assertIsInstance(listed["body"]["urls"], list)
        for state in ("completed", "failed"):
            status = await robot.request("logs.update_status", {"log_id": "x", "state": state, "errors": []}, "job")
            self.assertEqual((status["id"], status["code"]), ("job", 200))

    async def test_unknown_service(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertEqual((await robot.request("no.such_service", {}))["code"], 404)

    async def test_several_frames_in_one_write(self) -> None:
        await self.start()
        robot, _ = await self.login()
        requests = [
            {"type": "request", "id": request_id, "to": {"service": "firmware.check"}, "body": {}}
            for request_id in ("x", "y")
        ]
        robot.writer.write(b"".join(frame(json.dumps(request).encode()) for request in requests))
        self.assertEqual([(await robot.recv())["id"], (await robot.recv())["id"]], ["x", "y"])


class StorageTests(ServerTestCase):
    def stored(self) -> dict | None:
        """The robot's row in the database file, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM robots WHERE vendor = 'n' AND serial = 'board1'").fetchone()
        return dict(row) if row else None

    def maps(self) -> list[tuple[str, str, object]]:
        """Every map in the database file, oldest first: whose it is, and the body as stored."""
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            rows = db.execute("SELECT vendor, serial, map_json FROM maps ORDER BY id").fetchall()
        return [(vendor, serial, json.loads(body)) for vendor, serial, body in rows]

    async def send_state(self, robot: Robot, body: object) -> None:
        await robot.send({"type": "event", "id": "e1", "to": {"service": "peer.state"}, "body": body})

    async def handled(self, robot: Robot) -> None:
        """Return once the server has dealt with everything sent so far, which it does in order."""
        self.assertEqual((await robot.request("firmware.check", {}, "last"))["id"], "last")

    async def test_latest_state_is_stored_as_sent(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertIsNone(self.stored())
        # Firmware may add fields, and those are kept too.
        state = {"ability": "state.show", "state": "busy", "action": "cleaning", "errors": None,
                 "details": {"charge": 80, "is_docked": False}, "added_by_newer_firmware": ["caf\u00e9"]}
        await self.send_state(robot, {"ability": "state.show", "state": "idle"})
        await self.send_state(robot, state)
        await self.handled(robot)
        row = self.stored()
        self.assertEqual(json.loads(row["state_json"]), state)
        self.assertIsNotNone(row["state_at"])
        self.assertIsNone(row["heartbeat_at"])

    async def test_heartbeat_time_is_stored(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await self.send_state(robot, {"state": "idle"})
        await self.handled(robot)
        before = self.stored()
        await robot.send_bytes(HEARTBEAT)
        await self.handled(robot)
        after = self.stored()
        self.assertIsNotNone(after.pop("heartbeat_at"))
        self.assertIsNone(before.pop("heartbeat_at"))
        self.assertEqual(after, before)

    async def test_state_that_is_not_an_object_is_not_stored(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await self.send_state(robot, {"state": "idle"})
        with self.assertLogs("deorbit", "WARNING") as logs:
            for body in (None, "idle", ["idle"]):
                await self.send_state(robot, body)
            await self.handled(robot)
        self.assertEqual(len(logs.output), 3)
        self.assertEqual(self.stored()["state_json"], '{"state":"idle"}')

    async def test_failing_database_does_not_drop_the_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.execute("DROP TABLE robots")
        with self.assertLogs("deorbit", "ERROR") as logs:
            await self.send_state(robot, {"state": "idle"})
            await robot.send_bytes(HEARTBEAT)
            await self.handled(robot)
        self.assertEqual(len(logs.output), 2)
        self.assertIn("[n/board1] not saved to the database: no such table", logs.output[0])

    async def test_state_that_cannot_be_stored_does_not_drop_the_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await self.send_state(robot, {"state": "idle"})
        with self.assertLogs("deorbit", "ERROR") as logs:
            await self.send_state(robot, {"state": "\ud800"})  # not text that UTF-8 can carry
            await self.send_state(robot, {"details": {"charge": float("inf")}})  # not a number JSON has
            await self.handled(robot)
        self.assertEqual(len(logs.output), 2)
        self.assertEqual(self.stored()["state_json"], '{"state":"idle"}')

    async def test_each_map_is_stored_as_sent(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # Firmware may add fields, and those are kept too.
        paused = {"rank_uuid": "r1", "cleaning_complete": False, "added_by_newer_firmware": ["caf\u00e9"],
                  "map": {"origin": {"x": -120, "y": 85}, "rank_binary": "cmFuaw==", "real_binary": "cmVhbA=="}}
        done = {**paused, "rank_uuid": "r2", "cleaning_complete": True}
        for body in (paused, done):
            created = await robot.request("maps.create", body)
            self.assertEqual((created["code"], created["body"]), (201, {"floorplan": False}))
        # With the binaries, which the event log leaves out.
        self.assertEqual(self.maps(), [("n", "board1", paused), ("n", "board1", done)])

    async def test_multi_megabyte_map(self) -> None:
        await self.start()
        robot, _ = await self.login()
        binary = "A" * (2 * 1024 * 1024)
        body = {"map": {"rank_binary": binary, "real_binary": binary}}
        self.assertEqual((await robot.request("maps.create", body))["code"], 201)
        self.assertEqual(self.maps(), [("n", "board1", body)])

    async def test_map_that_is_not_an_object_is_refused(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with self.assertLogs("deorbit", "WARNING") as logs:
            for body in (None, "map", ["map"]):
                refused = await robot.request("maps.create", body)
                self.assertEqual((refused["id"], refused["code"]), ("r1", 400))
        self.assertEqual(len(logs.output), 3)
        self.assertEqual(self.maps(), [])

    async def test_map_that_is_not_stored_is_not_acknowledged(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with self.assertLogs("deorbit", "ERROR") as logs:
            # Not a number JSON has, so neither the event log nor the maps take it.
            unreadable = await robot.request("maps.create", {"battery_consumed": float("inf")})
            self.assertEqual(self.maps(), [])
            with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
                db.execute("DROP TABLE maps")
            unwritten = await robot.request("maps.create", {"rank_uuid": "r1"})
            # Anything but 201 tells the robot that its upload failed, and it stays connected.
            self.assertEqual((unreadable["code"], unwritten["code"]), (500, 500))
            await self.handled(robot)
        self.assertEqual(len(logs.output), 3)
        self.assertIn("[n/board1] not saved to the database: no such table: maps", logs.output[2])


class EventLogTests(ServerTestCase):
    def logged(self) -> list[tuple[str, str | None, object]]:
        """Every event in the database file, oldest first: its kind, its service and its body."""
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            rows = db.execute("SELECT vendor, serial, kind, service, body_json FROM events ORDER BY id").fetchall()
        self.assertEqual({row[:2] for row in rows} - {("n", "board1")}, set())
        return [(kind, service, body if body is None else json.loads(body)) for _, _, kind, service, body in rows]

    async def gone(self) -> None:
        """Return once no robot has a session, by when each disconnect is in the log."""
        async with asyncio.timeout(5):
            while self.server.sessions:
                await asyncio.sleep(0.01)

    async def test_login_and_disconnect(self) -> None:
        await self.start()
        robot, _ = await self.login()
        login = ("login", None, {"address": "127.0.0.1", "firmware": "4.5.3-189", "verified": True})
        self.assertEqual(self.logged(), [login])
        await robot.send_bytes(CLOSE)
        await robot.wait_closed()
        await self.gone()
        self.assertEqual(self.logged(), [login, ("disconnect", None, {"reason": "closed by robot"})])

    async def test_each_way_a_session_ends(self) -> None:
        await self.start(idle_timeout=0.2)
        first, _ = await self.login()
        second, _ = await self.login()
        await first.wait_closed()
        second.writer.transport.abort()
        await self.gone()
        third, _ = await self.login()
        await third.wait_closed()
        await self.gone()
        self.assertEqual(
            [(kind, body.get("reason")) for kind, _, body in self.logged()],
            [
                ("login", None),
                ("login", None),
                # The older session ends after the login that replaced it.
                ("disconnect", "replaced by a newer login"),
                ("disconnect", "connection closed by robot"),
                ("login", None),
                ("disconnect", "no frame received for 0.2s"),
            ],
        )

    async def test_server_that_stops_ends_the_session_in_the_log(self) -> None:
        def check() -> None:
            self.assertEqual(self.logged()[-1], ("disconnect", None, {"reason": "server shutting down"}))

        self.addCleanup(check)  # cleanups run last one first, so this follows the one that stops the server
        await self.start()
        await self.login()

    async def test_login_that_is_not_verified(self) -> None:
        await self.start(keys=None)
        robot = await self.connect()
        await robot.send({"vendor": "N", "serial": "BOARD1", "datetime": "now", "signature": "x", "firmware": 7})
        self.assertEqual((await robot.recv())["code"], 200)
        self.assertEqual(self.logged(), [("login", None, {"address": "127.0.0.1", "firmware": None, "verified": False})])

    async def test_rejected_login_is_not_logged(self) -> None:
        await self.start()
        for login in ({**signed_login(self.key), "signature": "AAAA"}, {"vendor": "N"}):
            with self.subTest(login=login):
                robot = await self.connect()
                await robot.send(login)
                self.assertNotEqual((await robot.recv())["code"], 200)
                await robot.wait_closed()
        self.assertEqual(self.logged(), [])

    async def test_messages_but_not_states_or_heartbeats(self) -> None:
        # Signatures and map binaries stay out of the log even when the console is given them.
        await self.start(full=True)
        robot, _ = await self.login()
        error = {"code": "dustbin_missing", "severity": "warning", "created": "2026-10-06_12-34-56"}
        notice = {"message_code": "fuel_less_than_10", "payload": None}
        binary = "A" * 1000
        await robot.send({"type": "event", "id": "e1", "to": {"service": "peer.state"},
                          "body": {"ability": "state.show", "state": "idle"}})
        await robot.send_bytes(HEARTBEAT)
        await robot.send({"type": "event", "id": "e2", "to": {"service": "robots.error_codes"}, "body": error})
        await robot.send({"type": "request", "id": "n1", "to": {"service": "robots.notify"}, "body": notice})
        await robot.request("robots.link", {"user_id": "u1", "timezone": "Europe/London"})
        await robot.request("maps.create", {"rank_uuid": "r1", "signature": "c2lnbmVk",
                                            "map": {"origin": [0, 0], "rank_binary": binary, "real_binary": binary}})
        await robot.send({"type": "request", "id": "x1", "to": {"service": "firmware.check"}})
        self.assertEqual((await robot.recv())["id"], "x1")
        self.assertEqual(
            self.logged()[1:],
            [
                ("event", "robots.error_codes", error),
                ("request", "robots.notify", notice),
                ("request", "robots.link", {"user_id": "u1", "timezone": "Europe/London"}),
                ("request", "maps.create", {"rank_uuid": "r1", "signature": "<8 chars>", "map": {
                    "origin": [0, 0], "rank_binary": "<1000 chars>", "real_binary": "<1000 chars>"}}),
                ("request", "firmware.check", None),
            ],
        )

    async def test_message_for_a_service_the_server_does_not_have(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with self.assertLogs("deorbit", "WARNING"):
            # A robot may name a service after an event of the server's own; the kind still tells them apart.
            self.assertEqual((await robot.request("login", {"address": "10.9.9.9"}))["code"], 404)
            self.assertEqual((await robot.request({"not": "a name"}, "text"))["code"], 404)
            await robot.send({"type": "event", "id": "e1", "body": [1, 2]})
            self.assertEqual((await robot.request("no.such_service", {}))["code"], 404)
        self.assertEqual(
            self.logged()[1:],
            [
                ("request", "login", {"address": "10.9.9.9"}),
                ("request", None, "text"),
                ("event", None, [1, 2]),
                ("request", "no.such_service", {}),
            ],
        )

    async def test_call_and_the_response_to_it(self) -> None:
        await self.start()
        robot, session = await self.login()
        asked = asyncio.create_task(session.call("debug.echo_body", {"signature": "c2lnbmVk"}))
        request = await robot.recv()
        # The call is logged as it is made, before there is an answer to it.
        call = ("call", None, {"ability": "debug.echo_body", "signature": "<8 chars>"})
        self.assertEqual(self.logged()[1:], [call])
        await robot.send({"type": "response", "id": request["id"], "code": 200, "body": request["body"]})
        await asked
        # A response names only the ID of its call, so the ability is noted with what it said.
        response = ("response", None, {"ability": "debug.echo_body", "code": 200, "body": call[2]})
        self.assertEqual(self.logged()[1:], [call, response])

    async def test_call_that_gets_no_response(self) -> None:
        await self.start()
        robot, session = await self.login()
        with self.assertRaises(TimeoutError):
            await session.call("cleaning.pause", timeout=0.05)
        request = await robot.recv()
        with self.assertLogs("deorbit", "WARNING"):
            # An answer that comes too late is one to no call, as is an answer to nothing at all.
            await robot.send({"type": "response", "id": request["id"], "code": 200})
            await robot.send({"type": "response", "id": "nobody-asked", "code": 200})
            self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.assertEqual(self.logged()[1:], [("call", None, {"ability": "cleaning.pause"}),
                                             ("request", "firmware.check", {})])

    async def test_failing_event_log_does_not_drop_the_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.execute("DROP TABLE events")
        with self.assertLogs("deorbit", "ERROR") as logs:
            self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
            await robot.send_bytes(CLOSE)
            await robot.wait_closed()
            await self.gone()
        self.assertEqual(len(logs.output), 2)
        self.assertIn("[n/board1] not saved to the database: no such table: events", logs.output[0])


class DeleteTests(ServerTestCase):
    """``Server.delete``, which is what deleting a robot in the web UI comes to."""

    NOTHING = {"robots": 0, "events": 0, "maps": 0, "names": 0, "floorplans": 0, "tracks": 0}

    def held(self, serial: str = "board1") -> dict[str, int]:
        """How many rows of a robot each table of the database file has."""
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            return {
                table: db.execute(f"SELECT count(*) FROM {table} WHERE vendor = 'n' AND serial = ?", (serial,)).fetchone()[0]
                for table in self.NOTHING
            }

    async def test_connected_robot_is_dropped_and_all_of_it_deleted(self) -> None:
        keys = self.registry()
        shutil.copy(keys / "N" / "BOARD1.pem", keys / "N" / "BOARD2.pem")
        await self.start(keys=keys)
        robot, _ = await self.login()
        await robot.send({"type": "event", "id": "e1", "to": {"service": "peer.state"}, "body": {"state": "idle"}})
        await robot.send_bytes(HEARTBEAT)
        self.assertEqual((await robot.request("maps.create", {"rank_uuid": "r1"}))["code"], 201)
        self.server.store.save_name(self.ROBOT, "Rosie")
        self.server.store.save_floorplan(self.ROBOT, "r1", 1)
        self.server.store.save_track(self.ROBOT, "r1", "t1", "cleaning", "Hall", "eco", [0, 0, 1, 1])
        self.server.store.save_heartbeat(RobotId("n", "board2"))
        self.assertEqual(self.held(), {"robots": 1, "events": 2, "maps": 1, "names": 1, "floorplans": 1, "tracks": 1})
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertTrue(await self.server.delete(self.ROBOT))
        self.assertIn("[n/board1] disconnected: robot deleted", logs.output[-1])
        # The session has ended by now, so the disconnect it left in the log went with the rest.
        self.assertEqual(self.held(), self.NOTHING)
        self.assertEqual(self.server.sessions, {})
        await robot.wait_closed()
        # Its key is gone from the directory and from the server, so it is not let in again.
        self.assertEqual([path.name for path in keys.glob("*/*")], ["BOARD2.pem"])
        again = await self.connect()
        await again.send(signed_login(self.key))
        self.assertEqual(await again.recv(), {"code": 401})
        await again.wait_closed()
        self.assertEqual(self.held(), self.NOTHING)
        # The other robot has what it had, and its key.
        self.assertEqual(self.held("board2"), {**self.NOTHING, "robots": 1})
        other = await self.connect()
        await other.send(signed_login(self.key, serial="BOARD2"))
        self.assertEqual((await other.recv())["code"], 200)

    async def test_without_keys_a_deleted_robot_comes_back_as_a_new_one(self) -> None:
        await self.start(keys=None)
        robot, _ = await self.login()
        await robot.send_bytes(HEARTBEAT)
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.assertEqual(self.held(), {**self.NOTHING, "robots": 1, "events": 2})
        self.assertTrue(await self.server.delete(self.ROBOT))
        await robot.wait_closed()
        self.assertEqual(self.held(), self.NOTHING)
        # Nothing keeps it out, and nothing is known of it but this login.
        await self.login()
        self.assertEqual(self.held(), {**self.NOTHING, "events": 1})

    async def test_robot_that_is_not_connected(self) -> None:
        keys = self.registry()
        await self.start(keys=keys)
        self.server.store.save_heartbeat(self.ROBOT)
        self.server.store.add_event(self.ROBOT, "login")
        self.assertTrue(await self.server.delete(self.ROBOT))
        self.assertEqual(self.held(), self.NOTHING)
        self.assertEqual(list(keys.glob("*/*")), [])
        # One the server has nothing of at all is deleted as well as any.
        self.assertTrue(await self.server.delete(RobotId("n", "board2")))

    async def test_session_on_its_way_out_is_waited_for(self) -> None:
        await self.start(keys=None)
        _, session = await self.login()
        # As ``register`` leaves the session that a newer login replaced: no longer the robot's, and not ended yet.
        del self.server.sessions[self.ROBOT]
        session.close("replaced by a newer login")
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertTrue(await self.server.delete(self.ROBOT))
        # It had ended by then, so its disconnect was in the log before the log was gone through.
        self.assertIn("[n/board1] disconnected: ", logs.output[-1])
        self.assertEqual(self.held(), self.NOTHING)

    async def test_key_that_cannot_be_removed_leaves_the_robot_as_it_was(self) -> None:
        keys = self.registry()
        await self.start(keys=keys)
        robot, _ = await self.login()
        await robot.send_bytes(HEARTBEAT)
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        before = self.held()
        with mock.patch.object(Path, "unlink", side_effect=PermissionError(13, "Permission denied")):
            with self.assertRaises(PermissionError):
                await self.server.delete(self.ROBOT)
        # Still connected, still in the database, and still let in.
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.assertEqual(self.held(), {**before, "events": before["events"] + 1})
        self.assertEqual([path.name for path in keys.glob("*/*")], ["BOARD1.pem"])
        await self.login()


class AbilityCallTests(ServerTestCase):
    async def test_concurrent_calls_answered_out_of_order(self) -> None:
        await self.start()
        robot, session = await self.login()
        calls = [asyncio.create_task(session.call("debug.echo_body", {"n": n})) for n in range(3)]
        requests = [await robot.recv() for _ in calls]
        for request in reversed(requests):
            self.assertEqual(request["type"], "request")
            await robot.send({"type": "response", "id": request["id"], "code": 200, "body": request["body"]})
        for n, call in enumerate(calls):
            response = await call
            self.assertEqual((response["code"], response["body"]), (200, {"ability": "debug.echo_body", "n": n}))

    async def test_error_response_reaches_the_caller(self) -> None:
        await self.start()
        robot, session = await self.login()
        call = asyncio.create_task(session.call("no.such_ability"))
        request = await robot.recv()
        errors = {"errors": {"ability": ["invalid"]}}
        await robot.send({"type": "response", "id": request["id"], "code": 422, "body": errors})
        self.assertEqual((await call)["code"], 422)

    async def test_call_times_out(self) -> None:
        await self.start()
        _, session = await self.login()
        with self.assertRaises(TimeoutError):
            await session.call("cleaning.pause", timeout=0.05)

    async def test_disconnect_fails_pending_calls(self) -> None:
        await self.start()
        robot, session = await self.login()
        call = asyncio.create_task(session.call("cleaning.pause"))
        await robot.recv()
        robot.writer.transport.abort()
        with self.assertRaises(ConnectionError):
            await call
        self.assertEqual(self.server.sessions, {})

    async def test_stray_response_is_ignored(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send({"type": "response", "id": "nobody-asked", "code": 200})
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")


class ConnectionTests(ServerTestCase):
    async def test_heartbeats_while_idle(self) -> None:
        await self.start(heartbeat_interval=0.05)
        robot, _ = await self.login()
        self.assertEqual([await robot.recv_bytes(), await robot.recv_bytes()], [HEARTBEAT, HEARTBEAT])

    async def test_robot_heartbeats_keep_the_session_alive(self) -> None:
        await self.start(idle_timeout=0.3)
        robot, _ = await self.login()
        for _ in range(6):
            await asyncio.sleep(0.1)
            await robot.send_bytes(HEARTBEAT)
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")

    async def test_silent_robot_is_dropped(self) -> None:
        await self.start(idle_timeout=0.1)
        robot, _ = await self.login()
        await robot.wait_closed()
        self.assertEqual(self.server.sessions, {})

    async def test_silent_connection_is_dropped_before_login(self) -> None:
        await self.start(login_timeout=0.1)
        robot = await self.connect()
        await robot.wait_closed()

    async def test_graceful_close(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(CLOSE)
        self.assertEqual(await robot.reader.read(), b"")
        self.assertEqual(self.server.sessions, {})

    async def test_invalid_json_closes_the_session(self) -> None:
        await self.start()
        for payload in (b"{not json", b"\xff\xfe", b"[1, 2]"):
            with self.subTest(payload=payload):
                robot, _ = await self.login()
                await robot.send_bytes(payload)
                await robot.wait_closed()

    async def test_oversized_frame_closes_the_session(self) -> None:
        await self.start(max_frame_size=1024)
        robot, _ = await self.login()
        robot.writer.write(struct.pack(">I", 1025))
        await robot.wait_closed()

    async def test_robot_can_log_in_again(self) -> None:
        await self.start()
        robot, first = await self.login()
        robot.writer.transport.abort()
        async with asyncio.timeout(5):
            while self.server.sessions:
                await asyncio.sleep(0.01)
        _, second = await self.login()
        self.assertEqual(second.robot, first.robot)


if __name__ == "__main__":
    unittest.main()
