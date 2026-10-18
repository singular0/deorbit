"""Web UI tests: a real ``Web`` beside a real ``Server``, asked over HTTP the way a browser would."""

import asyncio
import base64
import contextlib
import json
import re
import socket
import sqlite3
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import quote

from deorbit import __main__ as cli
from deorbit import web
from deorbit.auth import RobotId
from deorbit.commands import (
    COMMANDS, DAYS, LINES_MAX, MODES, NAVIGATION_MODES, SETTINGS, ZONE_NAME_MAX, ZONES_MAX,
)
from deorbit.config import Config
from deorbit.server import Server
from deorbit.web import Web, WebError
from tests.test_server import Robot, ServerTestCase, signed_login
from tests.test_store import MAP

STATE = {"state": "idle", "action": "invalid", "errors": None, "details": {"charge": 81, "is_docked": True}}
# An event of a schedule as the spec has one to add, and the map of a run that is of a floor plan.
RUN = {"settings": {"mode": "eco", "navigation_mode": "normal"}, "map": None}
EVENT = {"enabled": True, "days": ["mon", "wed", "fri"], "time": "09:30",
         "command": {"ability": "cleaning.start", "runs": [RUN]}}
FLOOR = {"rank_id": "fb7f8145-0615-4a32-8f0d-8d833cd51a5e", "track_id": None, "nogo_enabled": True}


class WebTestCase(ServerTestCase):
    async def start(self, **overrides: object) -> Web:
        server = await super().start(web_host="127.0.0.1", web_port=0, **overrides)
        self.web = Web(server)
        await self.web.start()
        self.addAsyncCleanup(self.web.stop)
        return self.web

    async def exchange(self, request: bytes) -> bytes:
        """Send ``request`` and return everything the server sends before it closes the connection."""
        reader, writer = await asyncio.open_connection("127.0.0.1", self.web.port)
        try:
            writer.write(request)
            async with asyncio.timeout(5):
                return await reader.read()
        finally:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()

    async def fetch(
        self, target: str, method: str = "GET", sent: tuple[str, ...] = ("Host: localhost",)
    ) -> tuple[int, dict[str, str], bytes]:
        """The status, headers and body the server answers ``target`` with, asked with the headers in ``sent``."""
        answer = await self.exchange("\r\n".join((f"{method} {target} HTTP/1.1", *sent, "", "")).encode())
        head, _, body = answer.partition(b"\r\n\r\n")
        status, *lines = head.decode().split("\r\n")
        return int(status.split()[1]), dict(line.split(": ", 1) for line in lines), body

    def read(self, headers: dict[str, str], body: bytes) -> dict:
        """The JSON in an answer, read the way a browser would."""
        self.assertEqual(headers["Content-Type"], "application/json")

        def not_json(token: str) -> None:
            self.fail(f"{token} is not JSON a browser can read")

        return json.loads(body, parse_constant=not_json)

    async def api(self, target: str) -> dict:
        status, headers, body = await self.fetch(target)
        self.assertEqual(status, 200)
        return self.read(headers, body)

    def assertJustNow(self, stamp: str) -> None:
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertLess(abs(datetime.now(timezone.utc) - datetime.fromisoformat(stamp)), timedelta(seconds=5))

    # What a browser sends with a request from the page this server gave it.
    PAGE = ("Host: localhost:8080", "Origin: http://localhost:8080")

    async def command(self, target: str, sent: tuple[str, ...] = PAGE) -> tuple[int, dict]:
        """The status and the JSON that a command is answered with."""
        status, headers, body = await self.fetch(target, "POST", sent)
        return status, self.read(headers, body)

    async def answered(self, robot: Robot, target: str, answer: dict, sent: tuple[str, ...] = PAGE) -> tuple[dict, tuple[int, dict]]:
        """Send a command and have the robot answer it: what the robot was sent, and what the page was told.

        When the command was sent, which the page is told with every answer of a robot, is checked here and left out.
        """
        sending = asyncio.create_task(self.command(target, sent))
        request = await robot.recv()
        await robot.send({"type": "response", "id": request["id"], **answer})
        status, told = await sending
        if status == 200:
            self.assertJustNow(told.pop("sent"))
        return request, (status, told)


class PageTests(WebTestCase):
    async def test_page_and_everything_it_loads(self) -> None:
        await self.start()
        status, headers, page = await self.fetch("/")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/html; charset=utf-8"))
        self.assertEqual(int(headers["Content-Length"]), len(page))
        loaded = dict.fromkeys(re.findall(r'(?:href|src)="([^"#]+)"', page.decode()))
        self.assertEqual(list(loaded), ["favicon.svg", "app.css", "app.js"])
        kinds = {
            "favicon.svg": "image/svg+xml",
            "app.css": "text/css; charset=utf-8",
            "app.js": "text/javascript; charset=utf-8",
        }
        for name, kind in kinds.items():
            with self.subTest(name):
                status, headers, body = await self.fetch(f"/{name}")
                self.assertEqual((status, headers["Content-Type"]), (200, kind))
                self.assertTrue(body)
        # The script loads the rest of itself from beside it.
        _, _, script = await self.fetch("/app.js")
        self.assertEqual(re.findall(r"^import .* from '\./(.+)';$", script.decode(), re.M), ["map.js"])
        status, headers, body = await self.fetch("/map.js")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/javascript; charset=utf-8"))
        self.assertNotIn(b"import ", body)

    async def test_the_add_robot_helpers_are_served(self) -> None:
        await self.start()
        for name in ("neato-config.js", "mtp-client.js", "webusb-transport.js"):
            with self.subTest(name):
                status, headers, body = await self.fetch(f"/{name}")
                self.assertEqual((status, headers["Content-Type"]), (200, "text/javascript; charset=utf-8"))
                self.assertTrue(body)


class SetupTests(WebTestCase):
    async def test_setup_gives_the_address_and_the_ca(self) -> None:
        await self.start()
        setup = await self.api("/api/setup")
        self.assertEqual(setup["address"], "")
        self.assertEqual(setup["ca"], (self.dir / "certs" / "ca.crt").read_text())

    async def test_setup_gives_the_configured_address(self) -> None:
        await self.start(public_address="192.168.1.50")
        self.assertEqual((await self.api("/api/setup"))["address"], "192.168.1.50")

    async def test_setup_without_a_ca(self) -> None:
        await self.start()
        ca = self.dir / "certs" / "ca.crt"
        saved = ca.read_bytes()
        self.addCleanup(ca.write_bytes, saved)  # the directory is shared by the class's tests
        ca.unlink()
        self.assertIsNone((await self.api("/api/setup"))["ca"])

    async def test_nothing_but_the_page_may_run_on_it(self) -> None:
        await self.start()
        for target in ("/", "/app.js", "/api/robots", "/nowhere"):
            with self.subTest(target):
                _, headers, _ = await self.fetch(target)
                self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["Cache-Control"], "no-store")
        # The policy lets neither of these run, so the page must not count on them.
        _, _, page = await self.fetch("/")
        self.assertNotRegex(page.decode(), r"<style|style=|<script>|\son\w+=")

    async def test_head_has_no_body(self) -> None:
        await self.start()
        _, got, body = await self.fetch("/app.js")
        status, headers, nothing = await self.fetch("/app.js", "HEAD")
        self.assertEqual((status, headers, nothing), (200, got, b""))
        self.assertEqual(int(headers["Content-Length"]), len(body))

    async def test_what_is_not_served(self) -> None:
        await self.start()
        for target in ("/index.html", "/static/app.js", "/../deorbit.yml", "/api", "/api/robots/", "/api/robots/n",
                       "/api/events", "/api/maps", "/api/map/1", "/api/names", "/api/name/"):
            with self.subTest(target):
                status, _, _ = await self.fetch(target)
                self.assertEqual(status, 404)
        status, headers, _ = await self.fetch("/api/robots", "POST")
        self.assertEqual((status, headers["Allow"]), (405, "GET, HEAD"))

    async def test_requests_that_are_not_http(self) -> None:
        await self.start()
        for request in (b"hello", b"GET /", b"GET / HTTP/2.0", b"GET http://localhost/ HTTP/1.1", b"GET /\xff HTTP/1.1"):
            with self.subTest(request):
                self.assertEqual((await self.exchange(request + b"\r\n\r\n"))[:13], b"HTTP/1.1 400 ")

    async def test_request_that_is_too_long(self) -> None:
        with mock.patch.object(web, "_MAX_HEAD", 256):
            await self.start()
        answer = await self.exchange(b"GET / HTTP/1.1\r\nCookie: " + b"x" * 1000 + b"\r\n\r\n")
        self.assertEqual(answer[:13], b"HTTP/1.1 431 ")
        self.assertEqual((await self.fetch("/"))[0], 200)

    async def test_connection_closed_without_a_request(self) -> None:
        await self.start()
        for request in (b"", b"GET / HT"):
            with self.subTest(request):
                reader, writer = await asyncio.open_connection("127.0.0.1", self.web.port)
                self.addCleanup(writer.close)
                writer.write(request)
                writer.write_eof()
                async with asyncio.timeout(5):
                    self.assertEqual(await reader.read(), b"")

    async def test_silent_connection_is_dropped(self) -> None:
        await self.start()
        with mock.patch.object(web, "_TIMEOUT", 0.1):
            self.assertEqual(await self.exchange(b"GET / HTTP/1.1\r\n"), b"")

    async def test_stop_drops_open_connections(self) -> None:
        await self.start()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.web.port)
        self.addCleanup(writer.close)
        writer.write(b"GET / HTTP/1.1\r\n")
        # Connections are taken in order, so once this one is answered the one above is being waited on.
        self.assertEqual((await self.fetch("/"))[0], 200)
        port = self.web.port
        async with asyncio.timeout(5):
            await self.web.stop()
            self.assertEqual(await reader.read(), b"")
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", port)


class RobotTests(WebTestCase):
    OTHER = RobotId("n", "board0")

    async def test_no_robots(self) -> None:
        await self.start()
        answer = await self.api("/api/robots")
        self.assertJustNow(answer.pop("now"))
        self.assertEqual(answer, {"robots": []})

    async def test_robots_in_the_database(self) -> None:
        await self.start()
        store = self.server.store
        store.save_state(self.ROBOT, STATE)
        store.save_heartbeat(self.ROBOT)
        store.save_heartbeat(self.OTHER)
        board0, board1 = (await self.api("/api/robots"))["robots"]
        self.assertEqual((board0["vendor"], board0["serial"], board0["name"]), ("n", "board0", None))
        self.assertEqual((board0["state"], board0["charge"], board0["state_at"], board0["session"]), (None,) * 4)
        self.assertJustNow(board0["heartbeat_at"])
        self.assertEqual(
            (board1["serial"], board1["state"], board1["action"], board1["errors"], board1["charge"]),
            ("board1", "idle", "invalid", None, 81),
        )
        # As SQLite reads them out of the state: true as 1, and a field the state lacked as nothing.
        self.assertEqual((board1["is_docked"], board1["is_charging"]), (1, None))
        self.assertJustNow(board1["state_at"])
        self.assertIsNone(board1["session"])
        # The list leaves the whole state to the robot's own page.
        self.assertNotIn("state_json", board1)

    async def test_one_robot(self) -> None:
        await self.start()
        self.server.store.save_state(self.ROBOT, STATE)
        for target in ("/api/robot?vendor=n&serial=board1", "/api/robot?serial=BOARD1&vendor=N&more=1"):
            with self.subTest(target):
                answer = await self.api(target)
                self.assertJustNow(answer["now"])
                robot = answer["robot"]
                self.assertEqual((robot["vendor"], robot["serial"], robot["charge"]), ("n", "board1", 81))
                self.assertEqual(json.loads(robot["state_json"]), STATE)
                self.assertIsNone(robot["session"])

    async def test_robot_that_is_not_in_the_database(self) -> None:
        await self.start()
        self.server.store.save_state(self.ROBOT, STATE)
        for target in ("/api/robot?vendor=n&serial=board2", "/api/robot?serial=board1", "/api/robot", "/api/robot?"):
            with self.subTest(target):
                status, headers, body = await self.fetch(target)
                self.assertEqual((status, headers["Content-Type"]), (404, "application/json"))
                self.assertEqual(json.loads(body), {"error": "no such robot in the database"})

    async def test_names_a_path_could_not_carry(self) -> None:
        await self.start()
        for serial, sent in {"..": "..", "a/b?c#d&e=f": "a%2Fb%3Fc%23d%26e%3Df", "bo ard+1": "bo+ard%2B1",
                             "caf\u00e9": "caf%C3%A9"}.items():
            with self.subTest(serial):
                self.server.store.save_heartbeat(RobotId("n", serial))
                robot = (await self.api(f"/api/robot?vendor=n&serial={sent}"))["robot"]
                self.assertEqual(robot["serial"], serial)

    async def test_connected_robot_has_a_session(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(b"\x06")
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.server.store.save_heartbeat(self.OTHER)
        board0, board1 = (await self.api("/api/robots"))["robots"]
        self.assertIsNone(board0["session"])
        session = board1["session"]
        self.assertEqual((await self.api("/api/robot?vendor=n&serial=board1"))["robot"]["session"], session)
        self.assertJustNow(session.pop("since"))
        self.assertEqual(session, {"address": "127.0.0.1", "firmware": "4.5.3-189"})

        robot.writer.transport.abort()
        async with asyncio.timeout(5):
            while self.server.sessions:
                await asyncio.sleep(0.01)
        self.assertIsNone((await self.api("/api/robots"))["robots"][1]["session"])

    async def test_login_without_a_firmware(self) -> None:
        await self.start(keys=None)
        for firmware in ({}, {"firmware": 7}):
            with self.subTest(firmware):
                robot = await self.connect()
                await robot.send({"vendor": "N", "serial": "BOARD1", "datetime": "now", "signature": "x", **firmware})
                self.assertEqual((await robot.recv())["code"], 200)
                await robot.send_bytes(b"\x06")
                self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
                session = (await self.api("/api/robots"))["robots"][0]["session"]
                self.assertEqual((session["address"], session["firmware"]), ("127.0.0.1", None))

    async def test_number_that_json_cannot_write(self) -> None:
        await self.start()
        # A whole number may have any length. SQLite reads one beyond its range out of
        # the state as infinity, and a browser would refuse the bare word for that.
        state = {"state": "idle", "details": {"charge": 10 ** 400}}
        self.server.store.save_state(self.ROBOT, state)
        self.assertEqual((await self.api("/api/robots"))["robots"][0]["charge"], "inf")
        robot = (await self.api("/api/robot?vendor=n&serial=board1"))["robot"]
        self.assertEqual((robot["charge"], robot["state"]), ("inf", "idle"))
        self.assertEqual(json.loads(robot["state_json"]), state)

    async def test_database_that_cannot_be_read(self) -> None:
        await self.start()
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.execute("DROP TABLE robots")
        for target in ("/api/robots", "/api/robot?vendor=n&serial=board1"):
            with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                status, headers, body = await self.fetch(target)
                self.assertEqual((status, headers["Content-Type"]), (503, "application/json"))
                self.assertEqual(json.loads(body), {"error": "cannot read the database: no such table: robots"})
                self.assertIn("web UI: cannot read the database", logs.output[0])
        # The page itself needs no database.
        self.assertEqual((await self.fetch("/"))[0], 200)


class NameTests(WebTestCase):
    """``POST /api/name``, which is what the field for a name on a robot's page sends."""

    OTHER = RobotId("n", "board0")
    BOARD1 = "/api/name?vendor=n&serial=board1"

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        # A robot is named on its page, which it has once it is in the database. Neither is connected.
        self.server.store.save_state(self.ROBOT, STATE)
        self.server.store.save_heartbeat(self.OTHER)
        return web

    async def names(self) -> list[str | None]:
        """What board0 and board1 are named, as the list of robots has it."""
        return [robot["name"] for robot in (await self.api("/api/robots"))["robots"]]

    async def test_robot_has_no_name_until_it_is_given_one(self) -> None:
        await self.start()
        self.assertEqual(await self.names(), [None, None])
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(await self.command(self.BOARD1 + "&name=Rosie"), (200, {"name": "Rosie"}))
        self.assertIn("[n/board1] named 'Rosie'", logs.output[0])
        self.assertEqual(await self.names(), [None, "Rosie"])
        robot = (await self.api("/api/robot?vendor=n&serial=board1"))["robot"]
        # The name is beside what the robot is and sent, and in the place of none of it.
        self.assertEqual((robot["name"], robot["serial"], robot["state"]), ("Rosie", "board1", "idle"))
        # The robot is named as it is in the address of its page, whatever the case, and may share its name.
        self.assertEqual(await self.command("/api/name?name=Rosie&serial=BOARD0&vendor=N"), (200, {"name": "Rosie"}))
        self.assertEqual(await self.command(self.BOARD1 + "&name=Dusty"), (200, {"name": "Dusty"}))
        self.assertEqual(await self.names(), ["Rosie", "Dusty"])

    async def test_name_is_kept_as_one_line_of_text(self) -> None:
        await self.start()
        for sent, name in {
            "++Living%20room+%09%0D%0A+robot%C2%A0": "Living room robot",
            quote("Caf\u00e9 \U0001f9f9 <b>&amp;\"'"): "Caf\u00e9 \U0001f9f9 <b>&amp;\"'",
            "x" * web._MAX_NAME: "x" * web._MAX_NAME,
            # What counts is the name that is kept, in characters.
            "+" * 40 + quote("\U0001f9f9" * web._MAX_NAME) + "+" * 40: "\U0001f9f9" * web._MAX_NAME,
        }.items():
            with self.subTest(sent):
                self.assertEqual(await self.command(f"{self.BOARD1}&name={sent}"), (200, {"name": name}))
                self.assertEqual(await self.names(), [None, name])

    async def test_no_name_takes_the_name_away(self) -> None:
        await self.start()
        for target in (self.BOARD1, self.BOARD1 + "&name=", self.BOARD1 + "&name=+%20%0A"):
            with self.subTest(target):
                await self.command(self.BOARD1 + "&name=Rosie")
                await self.command("/api/name?vendor=n&serial=board0&name=Dusty")
                with self.assertLogs("deorbit", "INFO") as logs:
                    self.assertEqual(await self.command(target), (200, {"name": None}))
                self.assertIn("[n/board1] goes by its serial again", logs.output[0])
                self.assertEqual(await self.names(), ["Dusty", None])
        # A robot that has none has none to lose.
        self.assertEqual(await self.command(self.BOARD1), (200, {"name": None}))

    async def test_name_that_is_not_taken(self) -> None:
        await self.start()
        await self.command(self.BOARD1 + "&name=Rosie")
        long = (400, {"error": "name must be at most 64 characters"})
        control = (400, {"error": "name must not hold control characters"})
        for sent, told in {
            "x" * (web._MAX_NAME + 1): long,
            quote("\u00e9" * (web._MAX_NAME + 1)): long,
            "Ro%00sie": control,
            "Ro%1Bsie": control,
            "Rosie%7F": control,
            "%C2%80Rosie": control,
        }.items():
            with self.subTest(sent):
                self.assertEqual(await self.command(f"{self.BOARD1}&name={sent}"), told)
                # Refused whichever robot it is for, before the robot is looked for.
                self.assertEqual(await self.command(f"/api/name?name={sent}"), told)
        self.assertEqual(await self.names(), [None, "Rosie"])

    async def test_robot_that_is_not_in_the_database(self) -> None:
        await self.start()
        self.server.store.add_event(RobotId("n", "board2"), "login")  # logged in, and sent nothing since
        for target in ("/api/name?vendor=n&serial=board2&name=Rosie", "/api/name?serial=board1&name=Rosie",
                       "/api/name?name=Rosie", "/api/name", "/api/name?vendor=n&serial=board2"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (404, {"error": "no such robot in the database"}))
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            self.assertEqual(db.execute("SELECT * FROM names").fetchall(), [])

    async def test_name_is_taken_from_the_ui_s_own_page_by_post_alone(self) -> None:
        await self.start()
        target = self.BOARD1 + "&name=Rosie"
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            with self.subTest(sent):
                self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(target, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        self.assertEqual(await self.names(), [None, None])
        self.assertEqual(await self.command(target, ("Host: robots.example", "Origin: https://robots.example")),
                         (200, {"name": "Rosie"}))

    async def test_connected_robot_is_sent_nothing(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertEqual(await self.command(self.BOARD1 + "&name=Rosie"), (200, {"name": "Rosie"}))
        # The name is the server's own: the first thing the robot gets is the answer to what it asks next.
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        board1 = (await self.api("/api/robot?vendor=n&serial=board1"))
        self.assertEqual(board1["robot"]["name"], "Rosie")
        # Nor is it something the robot did, so it is not among its events.
        self.assertEqual([(event["kind"], event["service"]) for event in board1["events"]],
                         [("request", "firmware.check"), ("login", None)])

    async def test_name_that_cannot_be_saved(self) -> None:
        await self.start()
        await self.command(self.BOARD1 + "&name=Rosie")
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            # A file that takes no change to a name, as a full disk would not.
            for change in ("INSERT", "UPDATE", "DELETE"):
                db.execute(f"CREATE TRIGGER no_{change} BEFORE {change} ON names BEGIN SELECT RAISE(ABORT, 'full'); END")
            for target in (self.BOARD1 + "&name=Dusty", self.BOARD1):
                with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                    self.assertEqual(await self.command(target),
                                     (503, {"error": "the name could not be saved to the database"}))
                    self.assertIn("[n/board1] not saved to the database: full", logs.output[0])
            self.assertEqual(await self.names(), [None, "Rosie"])
            db.execute("DROP TABLE robots")
        with self.assertLogs("deorbit", "ERROR") as logs:
            self.assertEqual(await self.command(self.BOARD1 + "&name=Dusty"),
                             (503, {"error": "cannot read the database: no such table: robots"}))
        self.assertIn("web UI: cannot read the database", logs.output[0])

    async def test_page_takes_a_name_as_long_as_the_server_does(self) -> None:
        await self.start()
        _, _, script = await self.fetch("/app.js")
        self.assertEqual(int(re.search(r"^const NAME_MAX = (\d+);", script.decode(), re.M)[1]), web._MAX_NAME)


class MapNameTests(WebTestCase):
    """``POST /api/map_name``, which is what Save sends in the popover of Rename, in the row of a map or the block of a floor plan."""

    OTHER = RobotId("n", "board0")
    BOARD1 = "/api/map_name?vendor=n&serial=board1&id=2"

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        # A map of each robot's, the other robot's first. Neither robot is connected.
        store = self.server.store
        store.save_heartbeat(self.OTHER)
        store.save_state(self.ROBOT, STATE)
        store.save_map(self.OTHER, MAP)
        store.save_map(self.ROBOT, MAP)
        return web

    async def names(self, serial: str = "board1") -> list[str | None]:
        """What the robot's maps are called, as its page has them."""
        return [row["name"] for row in (await self.api(f"/api/robot?vendor=n&serial={serial}"))["maps"]]

    async def test_map_has_no_name_until_it_is_given_one(self) -> None:
        await self.start()
        self.assertEqual(await self.names(), [None])
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(await self.command(self.BOARD1 + "&name=Kitchen"), (200, {"name": "Kitchen"}))
        self.assertIn("[n/board1] map 2 named 'Kitchen'", logs.output[0])
        answer = await self.api("/api/robot?vendor=n&serial=board1")
        (row,) = answer["maps"]
        # The name is beside what the robot sent, and in the place of none of it.
        self.assertEqual((row["id"], row["name"], json.loads(row["map_json"])["timing"]), (2, "Kitchen", MAP["timing"]))
        # The event of an upload names its map by what the robot knows it by.
        self.assertEqual(answer["map_names"], [{"rank_uuid": MAP["rank_uuid"], "name": "Kitchen"}])
        # The other robot's map of the same rank_uuid is its own.
        self.assertEqual(await self.names("board0"), [None])
        self.assertEqual((await self.api("/api/robot?vendor=n&serial=board0"))["map_names"], [])
        # The robot is named as it is in the address of its page, whatever the case.
        self.assertEqual(await self.command("/api/map_name?name=Hall&id=2&serial=BOARD1&vendor=N"), (200, {"name": "Hall"}))
        self.assertEqual(await self.names(), ["Hall"])
        # The map as /api/map gives it is the row as it is stored.
        self.assertNotIn("name", (await self.api("/api/map?vendor=n&serial=board1&id=2"))["map"])

    async def test_map_of_a_floor_plan_is_named_as_any(self) -> None:
        await self.start()
        store = self.server.store
        store.save_floorplan(self.ROBOT, MAP["rank_uuid"], 2)
        for n in range(3):
            store.save_map(self.ROBOT, {**MAP, "rank_uuid": f"later {n}"})
        self.assertEqual(await self.command(self.BOARD1 + "&name=Kitchen"), (200, {"name": "Kitchen"}))
        # Older than the maps that were asked for, it comes with its name.
        answer = await self.api("/api/robot?vendor=n&serial=board1&maps=2")
        self.assertEqual([(row["id"], row["name"]) for row in answer["maps"]], [(5, None), (4, None)])
        self.assertEqual([(row["id"], row["name"]) for row in answer["floorplan_maps"]], [(2, "Kitchen")])

    async def test_name_is_kept_as_one_line_of_text(self) -> None:
        await self.start()
        for sent, name in {
            "++Kitchen%20and+%09%0D%0A+hall%C2%A0": "Kitchen and hall",
            quote("Caf\u00e9 \U0001f9f9 <b>&amp;\"'"): "Caf\u00e9 \U0001f9f9 <b>&amp;\"'",
            "x" * web._MAX_NAME: "x" * web._MAX_NAME,
        }.items():
            with self.subTest(sent):
                self.assertEqual(await self.command(f"{self.BOARD1}&name={sent}"), (200, {"name": name}))
                self.assertEqual(await self.names(), [name])

    async def test_no_name_takes_the_name_away(self) -> None:
        await self.start()
        for target in (self.BOARD1, self.BOARD1 + "&name=", self.BOARD1 + "&name=+%20%0A"):
            with self.subTest(target):
                await self.command(self.BOARD1 + "&name=Kitchen")
                with self.assertLogs("deorbit", "INFO") as logs:
                    self.assertEqual(await self.command(target), (200, {"name": None}))
                self.assertIn("[n/board1] map 2 goes by its start time again", logs.output[0])
                self.assertEqual(await self.names(), [None])
        # A map that has none has none to lose.
        self.assertEqual(await self.command(self.BOARD1), (200, {"name": None}))

    async def test_name_that_is_not_taken(self) -> None:
        await self.start()
        await self.command(self.BOARD1 + "&name=Kitchen")
        long = (400, {"error": "name must be at most 64 characters"})
        control = (400, {"error": "name must not hold control characters"})
        for sent, told in {"x" * (web._MAX_NAME + 1): long, quote("\u00e9" * (web._MAX_NAME + 1)): long, "Hall%00": control}.items():
            with self.subTest(sent):
                self.assertEqual(await self.command(f"{self.BOARD1}&name={sent}"), told)
                # Refused whichever map it is for, before the map is looked for.
                self.assertEqual(await self.command(f"/api/map_name?name={sent}"), told)
        self.assertEqual(await self.names(), ["Kitchen"])

    async def test_map_that_is_not_in_the_database(self) -> None:
        await self.start()
        for target in (
            "/api/map_name?vendor=n&serial=board1&id=1&name=Kitchen",  # the other robot's
            "/api/map_name?vendor=n&serial=board1&id=3&name=Kitchen",
            "/api/map_name?vendor=n&serial=board2&id=2&name=Kitchen",
            "/api/map_name?id=2&name=Kitchen",
            "/api/map_name?vendor=n&serial=board1&name=Kitchen",
            "/api/map_name",
            # Not the number of any row a table can have.
            *(f"/api/map_name?vendor=n&serial=board1&name=Kitchen&id={asked}" for asked in ("0", "-1", "2.0", "two", "", 2 ** 63)),
        ):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (404, {"error": "no such map in the database"}))
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            self.assertEqual(db.execute("SELECT * FROM map_names").fetchall(), [])

    async def test_name_is_taken_from_the_ui_s_own_page_by_post_alone(self) -> None:
        await self.start()
        target = self.BOARD1 + "&name=Kitchen"
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            with self.subTest(sent):
                self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(target, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        self.assertEqual(await self.names(), [None])

    async def test_connected_robot_is_sent_nothing(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertEqual(await self.command(self.BOARD1 + "&name=Kitchen"), (200, {"name": "Kitchen"}))
        # The name is the server's own: the first thing the robot gets is the answer to what it asks next.
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        board1 = await self.api("/api/robot?vendor=n&serial=board1")
        self.assertEqual([row["name"] for row in board1["maps"]], ["Kitchen"])
        # Nor is it something the robot did, so it is not among its events.
        self.assertEqual([(event["kind"], event["service"]) for event in board1["events"]],
                         [("request", "firmware.check"), ("login", None)])

    async def test_name_that_cannot_be_saved(self) -> None:
        await self.start()
        await self.command(self.BOARD1 + "&name=Kitchen")
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            # A file that takes no change to a name, as a full disk would not.
            for change in ("INSERT", "UPDATE", "DELETE"):
                db.execute(f"CREATE TRIGGER no_{change} BEFORE {change} ON map_names BEGIN SELECT RAISE(ABORT, 'full'); END")
            for target in (self.BOARD1 + "&name=Hall", self.BOARD1):
                with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                    self.assertEqual(await self.command(target),
                                     (503, {"error": "the name could not be saved to the database"}))
                    self.assertIn("[n/board1] not saved to the database: full", logs.output[0])
            self.assertEqual(await self.names(), ["Kitchen"])


class DeleteTests(WebTestCase):
    """``POST /api/delete``, which is what Delete it, in the popover of Delete on a robot's page, sends."""

    OTHER = RobotId("n", "board0")
    BOARD1 = "/api/delete?vendor=n&serial=board1"

    async def start(self, **overrides: object) -> Web:
        # Deleting a robot takes its key out of the directory, so each test has one of its own.
        self.keys = self.registry()
        web = await super().start(keys=self.keys, **overrides)
        # Both robots have something in every table, the first map being board1's. Neither is connected.
        for robot in (self.ROBOT, self.OTHER):
            self.server.store.save_state(robot, STATE)
            self.server.store.add_event(robot, "login")
            self.server.store.save_map(robot, MAP)
            self.server.store.save_name(robot, "Rosie")
        return web

    async def serials(self) -> list[str]:
        """The robots there are, as the list of them has it."""
        return [robot["serial"] for robot in (await self.api("/api/robots"))["robots"]]

    def held(self) -> list[int]:
        """How many rows of board1 each table of the database file has."""
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            return [db.execute(f"SELECT count(*) FROM {table} WHERE serial = 'board1'").fetchone()[0]
                    for table in ("robots", "events", "maps", "names")]

    async def test_robot_is_gone_with_all_it_had(self) -> None:
        await self.start()
        self.assertEqual((await self.fetch("/api/map?vendor=n&serial=board1&id=1"))[0], 200)
        with self.assertLogs("deorbit", "INFO") as logs:
            # The robot is named as it is in the address of its page, whatever the case.
            self.assertEqual(await self.command("/api/delete?serial=BOARD1&vendor=N"), (200, {}))
        self.assertIn("[n/board1] deleted", logs.output[-1])
        self.assertEqual(await self.serials(), ["board0"])
        for target in ("/api/robot?vendor=n&serial=board1", "/api/map?vendor=n&serial=board1&id=1"):
            with self.subTest(target):
                self.assertEqual((await self.fetch(target))[0], 404)
        self.assertEqual(self.held(), [0, 0, 0, 0])
        self.assertEqual(list(self.keys.glob("*/*")), [])
        # The other robot has all it had.
        other = await self.api("/api/robot?vendor=n&serial=board0")
        self.assertEqual((other["robot"]["name"], other["robot"]["state"]), ("Rosie", "idle"))
        self.assertEqual((len(other["events"]), len(other["maps"])), (1, 1))
        # A robot is deleted once.
        self.assertEqual(await self.command(self.BOARD1), (404, {"error": "no such robot in the database"}))

    async def test_connected_robot_is_disconnected(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(b"\x06")
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.assertEqual(await self.command(self.BOARD1), (200, {}))
        # Without a word: the connection ends, as it does for a robot that a newer login replaced.
        self.assertEqual(await robot.reader.read(), b"")
        self.assertEqual(self.server.sessions, {})
        self.assertEqual(await self.serials(), ["board0"])
        # Nothing of that connection is left either, and with its key gone the robot does not get another.
        again = await self.connect()
        await again.send(signed_login(self.key))
        self.assertEqual(await again.recv(), {"code": 401})
        self.assertEqual(self.held(), [0, 0, 0, 0])

    async def test_robot_that_is_not_in_the_database(self) -> None:
        await self.start()
        self.server.store.add_event(RobotId("n", "board2"), "login")  # logged in, and sent nothing since
        self.server.store.delete(self.ROBOT)  # has a key, and no page to be deleted from
        for target in (self.BOARD1, "/api/delete?vendor=n&serial=board2", "/api/delete?serial=board0", "/api/delete"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (404, {"error": "no such robot in the database"}))
        # Nothing was deleted for any of them.
        self.assertEqual(await self.serials(), ["board0"])
        self.assertEqual([path.name for path in self.keys.glob("*/*")], ["BOARD1.pem"])
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM events WHERE serial = 'board2'").fetchone(), (1,))

    async def test_robot_is_deleted_from_the_ui_s_own_page_by_post_alone(self) -> None:
        await self.start()
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            with self.subTest(sent):
                self.assertEqual(await self.command(self.BOARD1, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.BOARD1, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        self.assertEqual(await self.serials(), ["board0", "board1"])
        self.assertEqual(self.held(), [1, 1, 1, 1])
        self.assertEqual(await self.command(self.BOARD1, ("Host: robots.example", "Origin: https://robots.example")),
                         (200, {}))

    async def test_robot_that_cannot_be_deleted(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # A directory of keys that lets none go, as one mounted to be read only would not.
        with mock.patch.object(Path, "unlink", side_effect=PermissionError(13, "Permission denied")):
            with self.assertLogs("deorbit", "ERROR") as logs:
                self.assertEqual(await self.command(self.BOARD1),
                                 (503, {"error": "the robot's key could not be deleted: Permission denied"}))
        self.assertIn("[n/board1] not deleted: its key could not be removed: [Errno 13] Permission denied", logs.output[0])
        # Nothing of the robot was touched: it is still connected, and has all it had.
        self.assertEqual((await robot.request("firmware.check", {}))["id"], "r1")
        self.assertEqual(self.held(), [1, 3, 1, 1])
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            # A file that lets no map go, as a full disk would not.
            db.execute("CREATE TRIGGER no_delete BEFORE DELETE ON maps BEGIN SELECT RAISE(ABORT, 'full'); END")
            with self.assertLogs("deorbit", "ERROR") as logs:
                self.assertEqual(await self.command(self.BOARD1),
                                 (503, {"error": "the robot could not be deleted from the database"}))
            self.assertIn("[n/board1] not deleted from the database: full", logs.output[0])
            # By then its key was gone and its connection ended, and its rows are all there, with the disconnect.
            self.assertEqual(await robot.reader.read(), b"")
            self.assertEqual(list(self.keys.glob("*/*")), [])
            self.assertEqual(self.held(), [1, 4, 1, 1])
            # So it still has a page, from which deleting it can be asked again.
            self.assertEqual(await self.serials(), ["board0", "board1"])
            db.execute("DROP TRIGGER no_delete")
        self.assertEqual(await self.command(self.BOARD1), (200, {}))
        self.assertEqual(self.held(), [0, 0, 0, 0])


class EventTests(WebTestCase):
    """The events that come with a robot from ``/api/robot``."""

    OTHER = RobotId("n", "board0")
    BOARD1 = "/api/robot?vendor=n&serial=board1"

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        # A robot is given only once it is in the database, and an event alone does not put it there.
        self.server.store.save_heartbeat(self.ROBOT)
        self.server.store.save_heartbeat(self.OTHER)
        return web

    def log(self, count: int, robot: RobotId | None = None) -> None:
        """Add ``count`` notifications, numbered from 1 in the order they are logged."""
        for n in range(1, count + 1):
            self.server.store.add_event(robot or self.ROBOT, "request", "robots.notify", {"n": n})

    def numbers(self, answer: dict) -> list[int]:
        return [json.loads(event["body_json"])["n"] for event in answer["events"]]

    async def test_robot_without_events(self) -> None:
        await self.start()
        self.log(2, self.OTHER)
        answer = await self.api(self.BOARD1)
        self.assertEqual(set(answer), {"now", "robot", "events", "more", "maps", "more_maps", "floorplans", "floorplan_maps", "tracks",
                                       "map_names"})
        self.assertEqual((answer["events"], answer["more"], answer["tracks"], answer["map_names"]), ([], False, [], []))

    async def test_events_newest_first_as_stored(self) -> None:
        await self.start()
        store = self.server.store
        store.add_event(self.ROBOT, "login", body={"address": "10.0.0.7", "firmware": "1.7.0", "verified": True})
        store.add_event(self.OTHER, "request", "robots.notify", {"message_code": "bin_full", "payload": None})
        store.add_event(self.ROBOT, "request", "robots.notify", {"message_code": "fuel_less_than_10", "payload": None})
        store.add_event(self.ROBOT, "event")
        for target in (self.BOARD1, "/api/robot?serial=BOARD1&vendor=N"):
            with self.subTest(target):
                answer = await self.api(target)
                self.assertFalse(answer["more"])
                last, notice, login = answer["events"]
                self.assertEqual(last, {"id": 4, "at": last["at"], "vendor": "n", "serial": "board1", "kind": "event",
                                        "service": None, "body_json": None})
                self.assertJustNow(last["at"])
                self.assertEqual((notice["id"], notice["kind"], notice["service"]), (3, "request", "robots.notify"))
                # A body is given as the text the database holds, like the whole state of the robot.
                self.assertEqual(notice["body_json"], '{"message_code":"fuel_less_than_10","payload":null}')
                self.assertEqual((login["id"], login["kind"], login["service"]), (1, "login", None))
                self.assertEqual(json.loads(login["body_json"]),
                                 {"address": "10.0.0.7", "firmware": "1.7.0", "verified": True})
        # The other robot has its own, and the list of robots carries none.
        other = await self.api("/api/robot?vendor=n&serial=board0")
        self.assertEqual([(event["id"], event["serial"]) for event in other["events"]], [(2, "board0")])
        self.assertEqual(set(await self.api("/api/robots")), {"now", "robots"})

    async def test_no_more_events_than_asked_for(self) -> None:
        with mock.patch.multiple(web, _EVENTS=3, _MAX_EVENTS=5):
            await self.start()
            self.log(7)
            self.log(9, self.OTHER)
            for target, numbers in (
                (self.BOARD1, [7, 6, 5]),  # as many as are given when no number is asked for
                (self.BOARD1 + "&events=1", [7]),
                (self.BOARD1 + "&events=5", [7, 6, 5, 4, 3]),
            ):
                with self.subTest(target):
                    answer = await self.api(target)
                    self.assertEqual((self.numbers(answer), answer["more"]), (numbers, True))
            for asked in ("0", "6", "-1", "many", "2.5", "9" * 5000):
                # Asked of a robot that is there and of one that is not: the number is wrong either way.
                for target in (f"{self.BOARD1}&events={asked}", f"/api/robot?events={asked}"):
                    with self.subTest(target):
                        status, headers, body = await self.fetch(target)
                        self.assertEqual((status, headers["Content-Type"]), (400, "application/json"))
                        self.assertEqual(json.loads(body), {"error": "events must be a number from 1 to 5"})
        answer = await self.api(self.BOARD1 + "&events=7")
        self.assertEqual((self.numbers(answer), answer["more"]), ([7, 6, 5, 4, 3, 2, 1], False))
        answer = await self.api(self.BOARD1 + "&events=6")
        self.assertEqual((self.numbers(answer), answer["more"]), ([7, 6, 5, 4, 3, 2], True))

    async def test_as_many_events_as_the_page_first_asks_for(self) -> None:
        await self.start()
        self.log(30)
        answer = await self.api(self.BOARD1)
        self.assertEqual((self.numbers(answer), answer["more"]), (list(range(30, 5, -1)), True))
        # The number in the page's script is the one the server gives when asked for none.
        _, _, script = await self.fetch("/app.js")
        self.assertIn(f"const EVENTS_STEP = {len(answer['events'])};", script.decode())
        self.assertIn(f"const EVENTS_MAX = {web._MAX_EVENTS};", script.decode())

    async def test_what_a_connected_robot_did(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send({"type": "request", "id": "n1", "to": {"service": "robots.notify"},
                          "body": {"message_code": "fuel_less_than_10", "payload": None}})
        self.assertEqual((await robot.request("firmware.check", {"version": "4.5.3"}))["id"], "r1")
        events = (await self.api(self.BOARD1))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in events],
                         [("request", "firmware.check"), ("request", "robots.notify"), ("login", None)])
        self.assertEqual(json.loads(events[0]["body_json"]), {"version": "4.5.3"})

    async def test_events_that_cannot_be_read(self) -> None:
        await self.start()
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.execute("DROP TABLE events")
        with self.assertLogs("deorbit", "ERROR") as logs:
            status, headers, body = await self.fetch(self.BOARD1)
        self.assertEqual((status, headers["Content-Type"]), (503, "application/json"))
        self.assertEqual(json.loads(body), {"error": "cannot read the database: no such table: events"})
        self.assertIn("web UI: cannot read the database", logs.output[0])
        # The list of robots needs no events.
        self.assertEqual((await self.fetch("/api/robots"))[0], 200)


class MapTests(WebTestCase):
    """The maps that come with a robot from ``/api/robot``, and the one that ``/api/map`` gives whole."""

    OTHER = RobotId("n", "board0")
    BOARD1 = "/api/robot?vendor=n&serial=board1"
    # A map as its robot's page lists it: without the two binaries.
    LISTED = {**MAP, "map": {"origin": MAP["map"]["origin"]}}

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        # A robot is given only once it is in the database, and a map alone does not put it there.
        self.server.store.save_heartbeat(self.ROBOT)
        self.server.store.save_heartbeat(self.OTHER)
        return web

    def upload(self, count: int, robot: RobotId | None = None) -> None:
        """Store ``count`` maps, each with its number, from 1, for a ``rank_uuid``."""
        for n in range(1, count + 1):
            self.server.store.save_map(robot or self.ROBOT, {**MAP, "rank_uuid": n})

    def numbers(self, answer: dict) -> list[int]:
        return [json.loads(row["map_json"])["rank_uuid"] for row in answer["maps"]]

    async def test_robot_without_maps(self) -> None:
        await self.start()
        self.upload(2, self.OTHER)
        answer = await self.api(self.BOARD1)
        self.assertEqual((answer["maps"], answer["more_maps"]), ([], False))
        self.assertEqual(answer["floorplan_maps"], [])

    async def test_maps_newest_first_without_their_binaries(self) -> None:
        await self.start()
        store = self.server.store
        unfinished = {**MAP, "rank_uuid": "second", "cleaning_complete": False}
        for robot, body in ((self.ROBOT, MAP), (self.OTHER, MAP), (self.ROBOT, unfinished)):
            store.save_map(robot, body)
        for target in (self.BOARD1, "/api/robot?serial=BOARD1&vendor=N"):
            with self.subTest(target):
                answer = await self.api(target)
                self.assertFalse(answer["more_maps"])
                last, first = answer["maps"]
                # Neither was given a name.
                self.assertEqual(last, {"id": 3, "at": last["at"], "vendor": "n", "serial": "board1",
                                        "map_json": last["map_json"], "name": None})
                self.assertJustNow(last["at"])
                # A map is given as JSON text, like the whole state of the robot, and here without its binaries.
                self.assertEqual(json.loads(last["map_json"]), {**self.LISTED, "rank_uuid": "second",
                                                                "cleaning_complete": False})
                self.assertEqual((first["id"], json.loads(first["map_json"])), (1, self.LISTED))
                self.assertNotIn("_binary", last["map_json"] + first["map_json"])
        # The other robot has its own, and the list of robots carries none.
        other = await self.api("/api/robot?vendor=n&serial=board0")
        self.assertEqual([(row["id"], row["serial"]) for row in other["maps"]], [(2, "board0")])
        self.assertEqual(set(await self.api("/api/robots")), {"now", "robots"})

    async def test_no_more_maps_than_asked_for(self) -> None:
        with mock.patch.multiple(web, _MAPS=3, _MAX_MAPS=5):
            await self.start()
            self.upload(7)
            self.upload(9, self.OTHER)
            for target, numbers in (
                (self.BOARD1, [7, 6, 5]),  # as many as are given when no number is asked for
                (self.BOARD1 + "&maps=1", [7]),
                (self.BOARD1 + "&maps=5&events=1", [7, 6, 5, 4, 3]),
            ):
                with self.subTest(target):
                    answer = await self.api(target)
                    self.assertEqual((self.numbers(answer), answer["more_maps"]), (numbers, True))
            for asked in ("0", "6", "-1", "many", "2.5", "9" * 5000):
                # Asked of a robot that is there and of one that is not: the number is wrong either way.
                for target in (f"{self.BOARD1}&maps={asked}", f"/api/robot?maps={asked}"):
                    with self.subTest(target):
                        status, headers, body = await self.fetch(target)
                        self.assertEqual((status, headers["Content-Type"]), (400, "application/json"))
                        self.assertEqual(json.loads(body), {"error": "maps must be a number from 1 to 5"})
        answer = await self.api(self.BOARD1 + "&maps=7")
        self.assertEqual((self.numbers(answer), answer["more_maps"]), ([7, 6, 5, 4, 3, 2, 1], False))
        answer = await self.api(self.BOARD1 + "&maps=6")
        self.assertEqual((self.numbers(answer), answer["more_maps"]), ([7, 6, 5, 4, 3, 2], True))
        # How many events come with them is asked for apart, and neither number changes the other.
        self.assertEqual((answer["events"], answer["more"]), ([], False))

    async def test_maps_of_floor_plans_come_however_old(self) -> None:
        with mock.patch.multiple(web, _MAPS=3, _MAX_MAPS=5):
            await self.start()
            self.upload(7)
            self.upload(2, self.OTHER)
            store = self.server.store
            self.assertEqual((await self.api(self.BOARD1))["floorplan_maps"], [])
            # The page shows a floor plan as the map it was made of, which may be older than the maps it asks for.
            for robot, rank_uuid, number in ((self.ROBOT, "old", 2), (self.ROBOT, "older", 1), (self.ROBOT, "listed", 6),
                                             (self.OTHER, "theirs", 3), (self.OTHER, "their own", 8)):
                store.save_floorplan(robot, rank_uuid, number)
            answer = await self.api(self.BOARD1)
            self.assertEqual((self.numbers(answer), answer["more_maps"]), ([7, 6, 5], True))
            # Only those that are not among the maps already, newest first, each as a map is listed.
            older, oldest = answer["floorplan_maps"]
            self.assertEqual(older, {"id": 2, "at": older["at"], "vendor": "n", "serial": "board1", "map_json": older["map_json"],
                                     "name": None})
            self.assertEqual(json.loads(older["map_json"]), {**self.LISTED, "rank_uuid": 2})
            self.assertEqual((oldest["id"], json.loads(oldest["map_json"])), (1, {**self.LISTED, "rank_uuid": 1}))
            answer = await self.api(self.BOARD1 + "&maps=5")
            self.assertEqual((self.numbers(answer), [row["id"] for row in answer["floorplan_maps"]]), ([7, 6, 5, 4, 3], [2, 1]))
            other = await self.api("/api/robot?vendor=n&serial=board0")
            self.assertEqual(([row["id"] for row in other["maps"]], other["floorplan_maps"]), ([9, 8], []))
        # The more maps are asked for, the fewer are left to come this way, and none when the robot has no older ones.
        answer = await self.api(self.BOARD1 + "&maps=6")
        self.assertEqual((self.numbers(answer), [row["id"] for row in answer["floorplan_maps"]]), ([7, 6, 5, 4, 3, 2], [1]))
        answer = await self.api(self.BOARD1 + "&maps=7")
        self.assertEqual((answer["more_maps"], answer["floorplan_maps"]), (False, []))

    async def test_as_many_maps_as_the_page_first_asks_for(self) -> None:
        await self.start()
        self.upload(12)
        answer = await self.api(self.BOARD1)
        self.assertEqual((self.numbers(answer), answer["more_maps"]), (list(range(12, 2, -1)), True))
        # The numbers in the page's script are the ones the server gives.
        _, _, script = await self.fetch("/app.js")
        self.assertIn(f"const MAPS_STEP = {len(answer['maps'])};", script.decode())
        self.assertIn(f"const MAPS_MAX = {web._MAX_MAPS};", script.decode())

    async def test_one_map_with_its_binaries(self) -> None:
        await self.start()
        self.upload(1, self.OTHER)
        self.server.store.save_map(self.ROBOT, MAP)
        for target in ("/api/map?vendor=n&serial=board1&id=2", "/api/map?id=2&serial=BOARD1&vendor=N&events=0"):
            with self.subTest(target):
                answer = await self.api(target)
                self.assertEqual(set(answer), {"map"})
                row = answer["map"]
                self.assertEqual(row, {"id": 2, "at": row["at"], "vendor": "n", "serial": "board1",
                                       "map_json": row["map_json"]})
                self.assertJustNow(row["at"])
                # Whole, as the robot sent it: the picture is made of the binaries.
                self.assertEqual(json.loads(row["map_json"]), MAP)

    async def test_map_that_is_not_in_the_database(self) -> None:
        await self.start()
        self.upload(1)
        self.upload(1, self.OTHER)
        self.assertEqual((await self.api("/api/map?vendor=n&serial=board1&id=1"))["map"]["id"], 1)
        for target in (
            "/api/map?vendor=n&serial=board1&id=2",  # the other robot's
            "/api/map?vendor=n&serial=board1&id=3",
            "/api/map?vendor=n&serial=board2&id=1",
            "/api/map?id=1",
            "/api/map?vendor=n&serial=board1",
            "/api/map",
            # Not the number of any row a table can have.
            *(f"/api/map?vendor=n&serial=board1&id={asked}" for asked in ("0", "-1", "1.0", "one", "", 2 ** 63, "9" * 5000)),
        ):
            with self.subTest(target[:60]):
                status, headers, body = await self.fetch(target)
                self.assertEqual((status, headers["Content-Type"]), (404, "application/json"))
                self.assertEqual(json.loads(body), {"error": "no such map in the database"})

    async def test_map_a_connected_robot_uploaded(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertEqual((await robot.request("maps.create", MAP))["code"], 201)
        (listed,) = (await self.api(self.BOARD1))["maps"]
        self.assertEqual(json.loads(listed["map_json"]), self.LISTED)
        whole = (await self.api(f"/api/map?vendor=n&serial=board1&id={listed['id']}"))["map"]
        self.assertEqual(json.loads(whole["map_json"]), MAP)

    async def test_maps_that_cannot_be_read(self) -> None:
        await self.start()
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            db.execute("DROP TABLE maps")
        for target in (self.BOARD1, "/api/map?vendor=n&serial=board1&id=1"):
            with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                status, headers, body = await self.fetch(target)
                self.assertEqual((status, headers["Content-Type"]), (503, "application/json"))
                self.assertEqual(json.loads(body), {"error": "cannot read the database: no such table: maps"})
                self.assertIn("web UI: cannot read the database", logs.output[0])
        # The list of robots needs no maps.
        self.assertEqual((await self.fetch("/api/robots"))[0], 200)


class CommandTests(WebTestCase):
    """``POST /api/command``, which is what a button on a robot's page sends."""

    BOARD1 = "/api/command?vendor=n&serial=board1"
    PAUSE = BOARD1 + "&command=pause"

    async def test_each_command_invokes_its_ability(self) -> None:
        await self.start()
        robot, _ = await self.login()
        abilities = {
            "start": "cleaning.start",
            "pause": "cleaning.pause",
            "resume": "cleaning.resume",
            "cancel": "cleaning.cancel",
            "return_to_base": "navigation.return_to_base",
        }
        self.assertEqual(set(abilities), set(COMMANDS))
        for name, ability in abilities.items():
            with self.subTest(name):
                # The robot is named as it is in the address of its page, whatever the case.
                target = f"/api/command?serial=BOARD1&vendor=N&command={name}"
                request, told = await self.answered(robot, target, {"code": 200, "body": {}})
                self.assertEqual(told, (200, {"ability": ability, "code": 200, "body": {}}))
                # A request with an ID to answer and an object naming the ability: a robot takes nothing else.
                self.assertEqual(set(request), {"type", "id", "body"})
                self.assertEqual(request["type"], "request")
                self.assertRegex(request["id"], r"^[0-9a-f-]{36}$")
                body = dict(request["body"])
                self.assertEqual(body.pop("ability"), ability)
                if name == "start":
                    # A run as the spec has it: its settings, and a map that is null for a cleaning on no floor plan.
                    (run,) = body.pop("runs")
                    self.assertEqual(set(run), {"settings", "map"})
                    self.assertEqual(set(run["settings"]), {"mode", "navigation_mode"})
                    self.assertIn(run["settings"]["mode"], ("eco", "turbo", "auto", "max"))
                    self.assertIn(run["settings"]["navigation_mode"], ("normal", "gentle"))
                    self.assertIsNone(run["map"])
                self.assertEqual(body, {})

    def started(self, run: object, robot: str = BOARD1) -> str:
        """The address that starts ``run``, or whatever is given for one."""
        text = run if isinstance(run, str) else json.dumps(run)
        return f"{robot}&command=start&run={quote(text, safe='')}"

    async def test_start_may_name_the_run_it_cleans(self) -> None:
        await self.start()
        robot, _ = await self.login()
        settings = {"mode": "turbo", "navigation_mode": "gentle"}
        for run in (
            {**RUN, "settings": settings},
            {"settings": {"mode": "max", "navigation_mode": "normal"}, "map": FLOOR},
            {**RUN, "map": {**FLOOR, "track_id": "888aa432-1067-2a25-9fd7-432169d2d556", "nogo_enabled": False}},
        ):
            with self.subTest(run):
                request, told = await self.answered(robot, self.started(run), {"code": 200, "body": {}})
                self.assertEqual(told, (200, {"ability": "cleaning.start", "code": 200, "body": {}}))
                self.assertEqual(request["body"], {"ability": "cleaning.start", "runs": [run]})
        # A run that is empty is none, and the start is the one the button sends without one.
        request, _ = await self.answered(robot, self.BOARD1 + "&command=start&run=", {"code": 200})
        self.assertEqual(request["body"], {"ability": "cleaning.start", "runs": [RUN]})
        # The spec has a robot answer 422 for a floor plan or a zone it does not have, and that is passed on as any answer is.
        _, told = await self.answered(robot, self.started({**RUN, "map": FLOOR}), {"code": 422, "body": {}})
        self.assertEqual(told, (200, {"ability": "cleaning.start", "code": 422, "body": {}}))

    async def test_run_that_is_not_sent_to_a_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        a_run = "run must be an object of settings, map and nothing else"
        refused = {
            "run is taken only with start": [
                f"{self.BOARD1}&command={name}&run={quote(json.dumps(RUN))}" for name in ("pause", "resume", "cancel", "return_to_base")
            ],
            "run must be JSON": [self.started(text) for text in ("nonsense", "{'map': null}", json.dumps(RUN)[:-1], "[" * 5000)],
            # One run, not a list of them.
            a_run: [self.started(given) for given in (None, [RUN], {"settings": RUN["settings"]}, {**RUN, "force_floorplan": False})],
            "run.settings must be an object of mode, navigation_mode and nothing else": [
                self.started({**RUN, "settings": given}) for given in (None, {"mode": "eco"})
            ],
            "run.settings.mode must be one of eco, turbo, auto, max": [
                self.started({**RUN, "settings": {**RUN["settings"], "mode": given}}) for given in ("deep", "ECO", None)
            ],
            "run.settings.navigation_mode must be one of normal, gentle": [
                self.started({**RUN, "settings": {**RUN["settings"], "navigation_mode": given}}) for given in ("fast", None)
            ],
            "run.map, unless null, must be an object of rank_id, track_id, nogo_enabled and nothing else": [
                self.started({**RUN, "map": given}) for given in ({}, "fb7f8145", {"rank_id": FLOOR["rank_id"]})
            ],
            "run.map.rank_id must be a string that is not empty": [self.started({**RUN, "map": {**FLOOR, "rank_id": ""}})],
            "run.map.track_id must be null or a string that is not empty": [self.started({**RUN, "map": {**FLOOR, "track_id": ""}})],
            "run.map.nogo_enabled must be true or false": [self.started({**RUN, "map": {**FLOOR, "nogo_enabled": None}})],
            # The command is looked at first.
            "command must be one of start, pause, resume, cancel, return_to_base": [
                f"{self.BOARD1}&command=START&run={quote(json.dumps(RUN))}"
            ],
        }
        for error, targets in refused.items():
            for target in targets:
                # Asked of a robot that is there and of one that is not: the request is wrong either way.
                for asked in (target, target.replace("serial=board1", "serial=board2")):
                    with self.subTest(error=error, target=asked[:200]):
                        self.assertEqual(await self.command(asked), (400, {"error": error}))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.PAUSE, {"code": 200})
        self.assertEqual(request["body"], {"ability": "cleaning.pause"})

    async def test_whatever_the_robot_answers_is_passed_on(self) -> None:
        await self.start()
        robot, _ = await self.login()
        refusal = {"errors": {"missing_params": ["runs"]}}
        for answer, told in (
            ({"code": 422, "body": refusal}, {"code": 422, "body": refusal}),
            ({"code": "odd", "body": ["caf\u00e9", 10 ** 400]}, {"code": "odd", "body": ["caf\u00e9", 10 ** 400]}),
            ({}, {"code": None, "body": None}),
        ):
            with self.subTest(answer):
                # The status says that the robot answered, not what it answered.
                self.assertEqual((await self.answered(robot, self.PAUSE, answer))[1],
                                 (200, {"ability": "cleaning.pause", **told}))

    async def test_answer_says_when_the_command_was_sent(self) -> None:
        await self.start()
        robot, _ = await self.login()

        async def state_at() -> str:
            """Have the robot send a state, and return when the server says it arrived."""
            await asyncio.sleep(0.01)  # times are kept to the millisecond
            await robot.send({"type": "event", "id": "e1", "to": {"service": "peer.state"}, "body": {"state": "idle"}})
            self.assertEqual((await robot.request("firmware.check", {}, "last"))["id"], "last")
            return (await self.api("/api/robot?vendor=n&serial=board1"))["robot"]["state_at"]

        before = await state_at()
        await asyncio.sleep(0.01)
        sending = asyncio.create_task(self.command(self.PAUSE))
        request = await robot.recv()
        # A state that arrives while the robot still has the command to answer is one that follows it too.
        during = await state_at()
        await robot.send({"type": "response", "id": request["id"], "code": 200, "body": {}})
        status, told = await sending
        self.assertEqual((status, set(told)), (200, {"ability", "sent", "code", "body"}))
        # The page holds its buttons back until the robot's state is newer than this, compared as text.
        self.assertTrue(before < told["sent"] < during < await state_at())

    async def test_answer_with_a_number_that_json_cannot_write(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with self.assertLogs("deorbit", "ERROR"):  # the event log does not take it either
            _, told = await self.answered(robot, self.PAUSE, {"code": 200, "body": {"area": float("nan")}})
        self.assertEqual(told, (502, {"error": "the robot's answer holds a number that JSON cannot carry"}))

    async def test_command_and_its_answer_are_among_the_events(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(b"\x06")  # a robot has a page once it is in the database
        await self.answered(robot, self.BOARD1 + "&command=return_to_base", {"code": 200, "body": {}})
        answer, call, login = (await self.api("/api/robot?vendor=n&serial=board1"))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in (answer, call, login)],
                         [("response", None), ("call", None), ("login", None)])
        self.assertEqual(json.loads(call["body_json"]), {"ability": "navigation.return_to_base"})
        self.assertEqual(json.loads(answer["body_json"]),
                         {"ability": "navigation.return_to_base", "code": 200, "body": {}})

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        self.server.store.save_state(self.ROBOT, STATE)  # in the database, as one that has been here
        for target in (self.PAUSE, "/api/command?vendor=n&serial=board2&command=pause", "/api/command?command=pause"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (409, {"error": "the robot is not connected"}))

    async def test_command_the_server_does_not_have(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (400, {"error": "command must be one of start, pause, resume, cancel, return_to_base"})
        # Asked of a robot that is there and of one that is not: the command is wrong either way.
        for robot_named in (self.BOARD1, "/api/command?vendor=n&serial=board2"):
            for command in ("&command=factory_reset", "&command=cleaning.pause", "&command=PAUSE", "&command=", ""):
                with self.subTest(robot_named + command):
                    self.assertEqual(await self.command(robot_named + command), told)
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.PAUSE, {"code": 200})
        self.assertEqual(request["body"], {"ability": "cleaning.pause"})

    async def test_only_this_server_s_own_page_may_send_one(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (
            ("Host: localhost:8080",),  # no browser: one always says where a POST comes from
            ("Origin: http://localhost:8080",),
            ("Host: localhost:8080", "Origin: http://elsewhere.example"),
            ("Host: localhost:8080", "Origin: http://localhost:8081"),  # another server on the same machine
            ("Host: localhost:8080", "Origin: http://localhost"),
            ("Host: localhost:8080", "Origin: http://localhost:8080.elsewhere.example"),
            ("Host: localhost:8080", "Origin: null"),  # a page that does not say where it is from
            ("Host: localhost:8080", "Origin: localhost:8080"),
            ("Host: localhost:8080", "Origin: file://localhost:8080"),
            ("Host: localhost:8080", "Origin: http://localhost:8080", "Origin: http://elsewhere.example"),
            ("Host: elsewhere.example", "Host: localhost:8080", "Origin: http://elsewhere.example"),
            ("Host:", "Origin: http://"),
            (),
        ):
            with self.subTest(sent):
                self.assertEqual(await self.command(self.PAUSE, sent), told)
                # Refused before anything else is looked at.
                self.assertEqual(await self.command("/api/command", sent), told)
        # None of those reached the robot: the first thing it is sent is the first of these.
        for sent in (
            self.PAGE,
            ("host: LocalHost:8080", "ORIGIN: HTTP://LOCALHOST:8080"),
            ("Host: 192.168.1.20:8080", "Origin: http://192.168.1.20:8080"),
            ("Host: [::1]:8080", "Origin: http://[::1]:8080"),
            # Behind a proxy that passes on the name it was asked under.
            ("Host: robots.example", "Origin: https://robots.example", "X-Forwarded-For: 10.0.0.7"),
        ):
            with self.subTest(sent):
                request, (status, _) = await self.answered(robot, self.PAUSE, {"code": 200}, sent)
                self.assertEqual((request["body"], status), ({"ability": "cleaning.pause"}, 200))

    async def test_command_is_sent_by_post_alone(self) -> None:
        await self.start()
        robot, _ = await self.login()
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.PAUSE, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        request, _ = await self.answered(robot, self.BOARD1 + "&command=resume", {"code": 200})
        self.assertEqual(request["body"], {"ability": "cleaning.resume"})

    async def test_robot_that_does_not_answer(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with mock.patch.object(web, "_COMMAND_TIMEOUT", 0.05):
            self.assertEqual(await self.command(self.PAUSE), (504, {"error": "the robot did not answer within 0.05 s"}))
        # The robot was sent the command all the same, and is still there for the next.
        self.assertEqual((await robot.recv())["body"], {"ability": "cleaning.pause"})
        request, (status, _) = await self.answered(robot, self.BOARD1 + "&command=resume", {"code": 200})
        self.assertEqual((request["body"], status), ({"ability": "cleaning.resume"}, 200))

    async def test_robot_that_goes_before_it_answers(self) -> None:
        await self.start()
        robot, _ = await self.login()
        sending = asyncio.create_task(self.command(self.PAUSE))
        await robot.recv()
        robot.writer.transport.abort()
        status, told = await sending
        self.assertEqual(status, 502)
        self.assertRegex(told["error"], r"^no answer from the robot: session closed: connection ")

    async def test_robot_may_take_longer_than_a_request_may(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # The time a browser has to send its request and to take the answer is not the time a robot has.
        with mock.patch.object(web, "_TIMEOUT", 0.2):
            sending = asyncio.create_task(self.command(self.PAUSE))
            request = await robot.recv()
            await asyncio.sleep(0.5)
            await robot.send({"type": "response", "id": request["id"], "code": 200})
            status, told = await sending
            self.assertEqual((status, told["code"]), (200, 200))

    async def test_page_has_these_commands_and_waits_longer_than_the_server(self) -> None:
        await self.start()
        _, _, script = await self.fetch("/app.js")
        listed = re.search(r"^const COMMANDS = \[\n(.*?)^\];", script.decode(), re.M | re.S)[1]
        self.assertEqual(re.findall(r"^  \['(\w+)', ", listed, re.M), list(COMMANDS))
        patience = int(re.search(r"^const COMMAND_TIMEOUT_MS = (\d+);", script.decode(), re.M)[1])
        self.assertGreater(patience, web._COMMAND_TIMEOUT * 1000)


class ScheduleTests(WebTestCase):
    """``POST /api/schedule``, which is what the schedule on a robot's page is read and changed through."""

    BOARD1 = "/api/schedule?vendor=n&serial=board1"
    SHOW = BOARD1 + "&action=show"
    DONE = {"code": 200, "body": {}}

    def change(self, action: str, event: object, robot: str = BOARD1) -> str:
        """The address that asks for ``event``, or whatever is given for one, to be added or put in place of another."""
        text = event if isinstance(event, str) else json.dumps(event)
        return f"{robot}&action={action}&event={quote(text, safe='')}"

    async def test_show_asks_the_robot_for_its_schedule(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # As the spec has a robot give it: an event has its id, and its command two fields that no update takes.
        command = {**EVENT["command"], "auto_localization": False, "force_floorplan": False}
        schedule = {"enabled": True, "events": [{"id": "1", **EVENT, "command": command}]}
        # The robot is named as it is in the address of its page, whatever the case.
        target = "/api/schedule?serial=BOARD1&vendor=N&action=show"
        request, told = await self.answered(robot, target, {"code": 200, "body": schedule})
        self.assertEqual(told, (200, {"ability": "scheduling.show", "code": 200, "body": schedule}))
        self.assertEqual(set(request), {"type", "id", "body"})
        self.assertEqual((request["type"], request["body"]), ("request", {"ability": "scheduling.show"}))

    async def test_add_sends_a_new_event(self) -> None:
        await self.start()
        robot, _ = await self.login()
        request, told = await self.answered(robot, self.change("add", EVENT), self.DONE)
        self.assertEqual(told, (200, {"ability": "scheduling.add", "code": 200, "body": {}}))
        # Without an id, which is the robot's to give.
        self.assertEqual(request["body"], {"ability": "scheduling.add", "event": EVENT})

    async def test_update_sends_an_event_under_its_id(self) -> None:
        await self.start()
        robot, _ = await self.login()
        zones = [{"settings": {"mode": mode, "navigation_mode": "gentle"}, "map": {**FLOOR, "track_id": track}}
                 for mode, track in (("turbo", "888aa432"), ("auto", "999bb543"))]
        whole = {"settings": {"mode": "max", "navigation_mode": "normal"}, "map": {**FLOOR, "nogo_enabled": False}}
        for event in (
            {"id": "1", **EVENT, "enabled": False},
            {"id": "007", **EVENT, "time": "00:00", "days": list(DAYS)},
            {"id": "12", **EVENT, "time": "23:59", "command": {"ability": "cleaning.start", "runs": zones}},
            {"id": "3", **EVENT, "days": ["sun"], "command": {"ability": "cleaning.start", "runs": [whole]}},
        ):
            with self.subTest(event):
                request, told = await self.answered(robot, self.change("update", event), self.DONE)
                self.assertEqual(told, (200, {"ability": "scheduling.update", "code": 200, "body": {}}))
                self.assertEqual(request["body"], {"ability": "scheduling.update", "event": event})

    async def test_days_are_sent_in_the_order_of_the_week(self) -> None:
        await self.start()
        robot, _ = await self.login()
        asked = self.change("add", {**EVENT, "days": ["sun", "tue", "mon", "sun"]})
        request, _ = await self.answered(robot, asked, self.DONE)
        self.assertEqual(request["body"]["event"]["days"], ["mon", "tue", "sun"])

    async def test_delete_names_the_event(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # An event that comes with it is not looked at.
        request, told = await self.answered(robot, self.BOARD1 + "&action=delete&id=12&event=nonsense", self.DONE)
        self.assertEqual(told, (200, {"ability": "scheduling.delete", "code": 200, "body": {}}))
        self.assertEqual(request["body"], {"ability": "scheduling.delete", "id": "12"})

    async def test_whatever_the_robot_answers_is_passed_on(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # A robot answers 500 to an event it will not have, and says no more.
        _, told = await self.answered(robot, self.change("add", EVENT), {"code": 500, "body": {}})
        self.assertEqual(told, (200, {"ability": "scheduling.add", "code": 500, "body": {}}))
        _, told = await self.answered(robot, self.SHOW, {"code": 200, "body": ["caf\u00e9", None]})
        self.assertEqual(told, (200, {"ability": "scheduling.show", "code": 200, "body": ["caf\u00e9", None]}))

    async def test_what_is_not_sent_to_a_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()

        def event(**changes: object) -> dict:
            return {**EVENT, **changes}

        def command(**changes: object) -> dict:
            return event(command={**EVENT["command"], **changes})

        def run(**changes: object) -> dict:
            return command(runs=[{**RUN, **changes}])

        def settings(**changes: object) -> dict:
            return run(settings={**RUN["settings"], **changes})

        def floor(**changes: object) -> dict:
            return run(map={**FLOOR, **changes})

        def less(given: dict, name: str) -> dict:
            return {key: value for key, value in given.items() if key != name}

        new = "event must be an object of enabled, days, time, command and nothing else"
        known = "event must be an object of id, enabled, days, time, command and nothing else"
        days = "event.days must be a list of one or more of mon, tue, wed, thu, fri, sat, sun"
        time = "event.time must be a time from 00:00 to 23:59"
        a_run = "event.command.runs[0] must be an object of settings, map and nothing else"
        a_map = "event.command.runs[0].map, unless null, must be an object of rank_id, track_id, nogo_enabled and nothing else"
        refused = {
            "action must be one of show, add, update, delete": [
                self.BOARD1, *(f"{self.BOARD1}&action={action}&id=1&event={quote(json.dumps(EVENT))}"
                               for action in ("", "SHOW", "scheduling.show", "remove", "show%20")),
            ],
            # The last two are a digit that is not one of the ten, and a 1 with the end of a line after it.
            "id must be a string of digits": [
                f"{self.BOARD1}&action=delete{given}"
                for given in ("", "&id=", "&id=one", "&id=1.5", "&id=-1", "&id=%201", "&id=%D9%A1", "&id=1%0A")
            ],
            "event must be JSON": [
                self.BOARD1 + "&action=add",
                *(self.change(action, text) for action in ("add", "update")
                  for text in ("", "nonsense", "{'enabled': true}", json.dumps(EVENT)[:-1], "[" * 5000)),
            ],
            new: [self.change("add", given) for given in (
                None, '"event"', 7, [EVENT], {}, {"id": "1", **EVENT}, {**EVENT, "name": "x"}, *(less(EVENT, name) for name in EVENT),
            )],
            known: [self.change("update", given) for given in (EVENT, None, {"id": "1", **EVENT, "name": "x"}, {"id": "1"})],
            "event.id must be a string of digits": [
                self.change("update", {"id": given, **EVENT}) for given in (1, "", "one", "1 ", "-1", None, ["1"])
            ],
            "event.enabled must be true or false": [self.change("add", event(enabled=given)) for given in (1, 0, "true", None)],
            days: [self.change("add", event(days=given))
                   for given in ([], "mon", ["monday"], ["Mon"], ["mon", 1], [["mon"]], {"mon": True}, None)],
            time: [self.change("add", event(time=given))
                   for given in ("9:30", "24:00", "09:60", "09:30:00", "0930", "09:30\n", " 09:30", "", 930, None)],
            "event.command must be an object of ability, runs and nothing else": [
                self.change("add", given)
                for given in (event(command=None), event(command=[]), command(force_floorplan=False), event(command={"runs": [RUN]}))
            ],
            "event.command.ability must be cleaning.start": [
                self.change("add", command(ability=given)) for given in ("cleaning.pause", "CLEANING.START", None, ["cleaning.start"])
            ],
            "event.command.runs must be a list of one or more runs": [
                self.change("add", command(runs=given)) for given in ([], None, RUN, "runs")
            ],
            a_run: [self.change("add", command(runs=[given]))
                    for given in (None, [], {"settings": RUN["settings"]}, {**RUN, "track_id": None})],
            "event.command.runs[1] must be an object of settings, map and nothing else": [
                self.change("add", command(runs=[{**RUN, "map": FLOOR}, None])),
            ],
            "event.command.runs[0].settings must be an object of mode, navigation_mode and nothing else": [
                self.change("add", run(settings=given)) for given in (None, {"mode": "eco"}, {**RUN["settings"], "passes": 2})
            ],
            "event.command.runs[0].settings.mode must be one of eco, turbo, auto, max": [
                self.change("add", settings(mode=given)) for given in ("deep", "ECO", "", None, 1, ["eco"])
            ],
            "event.command.runs[0].settings.navigation_mode must be one of normal, gentle": [
                self.change("add", settings(navigation_mode=given)) for given in ("fast", "", None, True)
            ],
            a_map: [self.change("add", run(map=given))
                    for given in ({}, False, "fb7f8145", [FLOOR], less(FLOOR, "track_id"), {**FLOOR, "name": "x"})],
            "event.command.runs[0].map.rank_id must be a string that is not empty": [
                self.change("add", floor(rank_id=given)) for given in ("", None, 7)
            ],
            "event.command.runs[0].map.track_id must be null or a string that is not empty": [
                self.change("add", floor(track_id=given)) for given in ("", 7, False)
            ],
            "event.command.runs[0].map.nogo_enabled must be true or false": [
                self.change("add", floor(nogo_enabled=given)) for given in ("yes", 1, None)
            ],
            # More runs than one are the zones of one floor plan.
            "event.command.runs, when more than one, must each have a map of the same rank_id": [
                self.change("add", command(runs=given)) for given in (
                    [RUN, RUN], [{**RUN, "map": FLOOR}, RUN], [{**RUN, "map": FLOOR}, {**RUN, "map": {**FLOOR, "rank_id": "another"}}],
                )
            ],
        }
        for error, targets in refused.items():
            for target in targets:
                # Asked of a robot that is there and of one that is not: the request is wrong either way.
                for asked in (target, target.replace("serial=board1", "serial=board2")):
                    with self.subTest(error=error, target=asked[:200]):
                        self.assertEqual(await self.command(asked), (400, {"error": error}))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.SHOW, self.DONE)
        self.assertEqual(request["body"], {"ability": "scheduling.show"})

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        self.server.store.save_state(self.ROBOT, STATE)  # in the database, as one that has been here
        for target in (self.SHOW, self.change("add", EVENT), self.BOARD1 + "&action=delete&id=1",
                       "/api/schedule?vendor=n&serial=board2&action=show", "/api/schedule?action=show"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (409, {"error": "the robot is not connected"}))

    async def test_only_this_server_s_own_page_may_ask(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            # Reading the schedule is asked of the robot too, so that is refused like a change to it.
            for target in (self.SHOW, self.change("add", EVENT), "/api/schedule"):
                with self.subTest(sent=sent, target=target):
                    self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.SHOW, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.BOARD1 + "&action=delete&id=4", self.DONE)
        self.assertEqual(request["body"], {"ability": "scheduling.delete", "id": "4"})

    async def test_robot_that_does_not_answer(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with mock.patch.object(web, "_COMMAND_TIMEOUT", 0.05):
            self.assertEqual(await self.command(self.SHOW), (504, {"error": "the robot did not answer within 0.05 s"}))
        self.assertEqual((await robot.recv())["body"], {"ability": "scheduling.show"})
        sending = asyncio.create_task(self.command(self.SHOW))
        await robot.recv()
        robot.writer.transport.abort()
        status, told = await sending
        self.assertEqual(status, 502)
        self.assertRegex(told["error"], r"^no answer from the robot: session closed: connection ")

    async def test_change_and_its_answer_are_among_the_events(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(b"\x06")  # a robot has a page once it is in the database
        await self.answered(robot, self.change("update", {"id": "2", **EVENT}), self.DONE)
        answer, call, login = (await self.api("/api/robot?vendor=n&serial=board1"))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in (answer, call, login)],
                         [("response", None), ("call", None), ("login", None)])
        self.assertEqual(json.loads(call["body_json"]), {"ability": "scheduling.update", "event": {"id": "2", **EVENT}})
        self.assertEqual(json.loads(answer["body_json"]), {"ability": "scheduling.update", "code": 200, "body": {}})

    async def test_page_offers_what_the_server_takes(self) -> None:
        await self.start()
        _, _, script = await self.fetch("/app.js")
        listed = re.search(r"^const DAYS = \[\n(.*?)^\];", script.decode(), re.M | re.S)[1]
        self.assertEqual(re.findall(r"^  \['(\w+)', ", listed, re.M), list(DAYS))
        self.assertIn(f"const MODES = {list(MODES)};", script.decode())
        self.assertIn(f"const NAVIGATION_MODES = {list(NAVIGATION_MODES)};", script.decode())


class SettingsTests(WebTestCase):
    """``POST /api/settings``, which is what the settings on a robot's page are read and changed through."""

    BOARD1 = "/api/settings?vendor=n&serial=board1"
    DONE = {"code": 200, "body": {}}

    def change(self, setting: str, value: object, robot: str = BOARD1) -> str:
        """The address that asks for ``setting`` to be changed to ``value``, or to whatever is given for one."""
        text = value if isinstance(value, str) else json.dumps(value)
        return f"{robot}&action=set_{setting}&value={quote(text, safe='')}"

    async def test_each_setting_is_read_with_its_ability(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # As the spec has a robot give each, the language as a Vorwerk robot does.
        given = {
            "robot_language": {"language": "en", "available_languages": ["en", "de", "fr"], "gender": None},
            "cleaning_options": {"force_floorplan": False},
            "ota_updates": {"auto": True},
        }
        self.assertEqual(tuple(given), SETTINGS)
        for name, body in given.items():
            with self.subTest(name):
                # A value that comes with it is not looked at.
                target = f"/api/settings?serial=BOARD1&vendor=N&action={name}&value=nonsense"
                request, told = await self.answered(robot, target, {"code": 200, "body": body})
                self.assertEqual(told, (200, {"ability": f"settings.{name}", "code": 200, "body": body}))
                self.assertEqual(set(request), {"type", "id", "body"})
                self.assertEqual((request["type"], request["body"]), ("request", {"ability": f"settings.{name}"}))

    async def test_each_setting_is_changed_with_its_ability(self) -> None:
        await self.start()
        robot, _ = await self.login()
        for name, value in (
            ("robot_language", {"language": "de"}),
            # The robot matches it in whatever case, so it goes as it is.
            ("robot_language", {"language": "EN-us"}),
            ("cleaning_options", {"force_floorplan": True}),
            ("cleaning_options", {"force_floorplan": False}),
            ("ota_updates", {"auto": False}),
        ):
            with self.subTest(name=name, value=value):
                request, told = await self.answered(robot, self.change(name, value), self.DONE)
                self.assertEqual(told, (200, {"ability": f"settings.set_{name}", "code": 200, "body": {}}))
                self.assertEqual(request["body"], {"ability": f"settings.set_{name}", **value})

    async def test_whatever_the_robot_answers_is_passed_on(self) -> None:
        await self.start()
        robot, _ = await self.login()
        _, told = await self.answered(robot, self.change("ota_updates", {"auto": True}), {"code": 400, "body": {}})
        self.assertEqual(told, (200, {"ability": "settings.set_ota_updates", "code": 400, "body": {}}))
        # What a robot answers for an ability it does not have.
        unknown = {"errors": {"ability": ["invalid"]}}
        _, told = await self.answered(robot, self.BOARD1 + "&action=robot_language", {"code": 422, "body": unknown})
        self.assertEqual(told, (200, {"ability": "settings.robot_language", "code": 422, "body": unknown}))

    async def test_what_is_not_sent_to_a_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        actions = ("action must be one of robot_language, set_robot_language, "
                   "cleaning_options, set_cleaning_options, ota_updates, set_ota_updates")
        refused = {
            # A factory reset and the sounds are of the spec's settings too, and are not sent.
            actions: [
                self.BOARD1, *(f"{self.BOARD1}&action={action}&value={quote(json.dumps({'auto': True}))}" for action in (
                    "", "factory_reset", "set_factory_reset", "sounds", "set_sounds", "settings.ota_updates",
                    "OTA_UPDATES", "set_", "set_set_ota_updates", "show", "ota_updates%20", "set_Ota_updates",
                )),
            ],
            "value must be JSON": [
                self.BOARD1 + "&action=set_ota_updates",
                *(self.change(name, text) for name in SETTINGS for text in ("", "nonsense", "{'auto': true}", "[" * 5000)),
            ],
            "value must be an object of language and nothing else": [
                self.change("robot_language", given) for given in (None, '"de"', ["de"], {}, {"language": "de", "gender": "female"})
            ],
            "value.language must be a string that is not empty": [
                self.change("robot_language", {"language": given}) for given in ("", None, 7, ["de"])
            ],
            "value must be an object of force_floorplan and nothing else": [
                self.change("cleaning_options", given) for given in (None, {}, {"force_floorplan": True, "auto": True}, {"auto": True})
            ],
            "value.force_floorplan must be true or false": [
                self.change("cleaning_options", {"force_floorplan": given}) for given in (1, "false", None)
            ],
            "value must be an object of auto and nothing else": [
                self.change("ota_updates", given) for given in (None, True, {}, {"auto": True, "silent": True})
            ],
            "value.auto must be true or false": [self.change("ota_updates", {"auto": given}) for given in (0, "yes", None)],
        }
        for error, targets in refused.items():
            for target in targets:
                # Asked of a robot that is there and of one that is not: the request is wrong either way.
                for asked in (target, target.replace("serial=board1", "serial=board2")):
                    with self.subTest(error=error, target=asked[:200]):
                        self.assertEqual(await self.command(asked), (400, {"error": error}))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.BOARD1 + "&action=ota_updates", {"code": 200, "body": {"auto": True}})
        self.assertEqual(request["body"], {"ability": "settings.ota_updates"})

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        self.server.store.save_state(self.ROBOT, STATE)  # in the database, as one that has been here
        for target in (self.BOARD1 + "&action=robot_language", self.change("ota_updates", {"auto": True}),
                       "/api/settings?vendor=n&serial=board2&action=robot_language", "/api/settings?action=ota_updates"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (409, {"error": "the robot is not connected"}))

    async def test_only_this_server_s_own_page_may_ask(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            # Reading a setting is asked of the robot too, so that is refused like a change to it.
            for target in (self.BOARD1 + "&action=robot_language", self.change("ota_updates", {"auto": False}), "/api/settings"):
                with self.subTest(sent=sent, target=target):
                    self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.BOARD1 + "&action=robot_language", method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, self.change("cleaning_options", {"force_floorplan": True}), self.DONE)
        self.assertEqual(request["body"], {"ability": "settings.set_cleaning_options", "force_floorplan": True})

    async def test_change_and_its_answer_are_among_the_events(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await robot.send_bytes(b"\x06")  # a robot has a page once it is in the database
        await self.answered(robot, self.change("robot_language", {"language": "de"}), self.DONE)
        answer, call, login = (await self.api("/api/robot?vendor=n&serial=board1"))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in (answer, call, login)],
                         [("response", None), ("call", None), ("login", None)])
        self.assertEqual(json.loads(call["body_json"]), {"ability": "settings.set_robot_language", "language": "de"})
        self.assertEqual(json.loads(answer["body_json"]), {"ability": "settings.set_robot_language", "code": 200, "body": {}})

    async def test_page_offers_what_the_server_takes(self) -> None:
        await self.start()
        _, _, script = await self.fetch("/app.js")
        self.assertIn(f"const SETTINGS = {list(SETTINGS)};", script.decode())


class FloorplanTests(WebTestCase):
    """``POST /api/floorplan``, which is what has a robot keep a map it uploaded as a floor plan, or drop a floor plan."""

    OTHER = RobotId("n", "board0")
    ROBOT1 = "/api/robot?vendor=n&serial=board1"
    BOARD1 = "/api/floorplan?vendor=n&serial=board1"
    PROMOTE = BOARD1 + "&action=promote&map=1"
    DONE = {"code": 200, "body": {}}
    # Two floor plans a robot might hold, of which the server knows what a test tells it.
    OLD = "77b3c9fe-afe6-4449-9b53-bbc5d373bb73"
    ELSE = "fb7f8145-0615-4a32-8f0d-8d833cd51a5e"
    # What a floor plan takes of the map of the spec, which is the first in the database.
    PLAN = {
        "rank_uuid": MAP["rank_uuid"],
        "rank_binary": MAP["map"]["rank_binary"],
        "real_binary": MAP["map"]["real_binary"],
        "base": MAP["robot"]["base"],
    }

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        # A robot's page lists its floor plans, and it has a page once it is in the database.
        self.server.store.save_heartbeat(self.ROBOT)
        self.server.store.save_map(self.ROBOT, MAP)
        return web

    def upload(self, body: object, robot: RobotId | None = None) -> int:
        """Store a map, and return the number it has in the database."""
        self.assertTrue(self.server.store.save_map(robot or self.ROBOT, body))
        return self.server.store.maps(robot or self.ROBOT, 1)[0]["id"]

    async def plans(self) -> dict[str, int]:
        """The floor plans that come with the robot's page: the map each was made of, by what the robot knows it by."""
        return {row["rank_uuid"]: row["map_id"] for row in (await self.api(self.ROBOT1))["floorplans"]}

    def made(self, request: dict) -> dict:
        """What a robot was sent to make a floor plan of, without the time, which is checked to be when the map's run ended."""
        self.assertEqual(set(request), {"type", "id", "body"})
        body = dict(request["body"])
        # As a robot that promotes a map by itself sends it (section 7.3 of the spec), not when the robot was asked.
        self.assertEqual(body.pop("date_created"), MAP["timing"]["end"])
        return body

    async def test_promote_sends_a_map_as_a_new_floor_plan(self) -> None:
        await self.start()
        robot, _ = await self.login()
        self.assertEqual((await self.api(self.ROBOT1))["floorplans"], [])
        # The robot is named as it is in the address of its page, whatever the case.
        target = "/api/floorplan?serial=BOARD1&vendor=N&action=promote&map=1"
        request, told = await self.answered(robot, target, self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.promote_floorplan", "code": 200, "body": {}}))
        # In place of no other, and with neither a no-go map nor zones, as a robot promotes a map by itself.
        self.assertEqual(self.made(request), {"ability": "maps.promote_floorplan", **self.PLAN, "old_rank_uuid": None,
                                              "nogo_track": None, "cleaning_tracks": []})
        # The server has it from then on, with the map it was made of.
        (row,) = (await self.api(self.ROBOT1))["floorplans"]
        self.assertEqual(row, {"vendor": "n", "serial": "board1", "rank_uuid": MAP["rank_uuid"], "map_id": 1, "at": row["at"]})
        self.assertJustNow(row["at"])
        # Made again of a later upload of the same map, it is the one floor plan still.
        again = self.upload(MAP)
        await self.answered(robot, f"{self.BOARD1}&action=promote&map={again}", self.DONE)
        self.assertEqual(await self.plans(), {MAP["rank_uuid"]: again})

    async def test_update_sends_a_map_in_place_of_a_floor_plan(self) -> None:
        await self.start()
        self.server.store.save_floorplan(self.ROBOT, self.OLD, 7)
        self.server.store.save_floorplan(self.ROBOT, self.ELSE, 8)
        self.server.store.save_floorplan(self.OTHER, self.OLD, 9)
        robot, _ = await self.login()
        target = f"{self.BOARD1}&action=update&map=1&old_rank_uuid={self.OLD}"
        request, told = await self.answered(robot, target, self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.update_floorplan", "code": 200, "body": {}}))
        # The reduced structure of the spec, which has no tracks.
        self.assertEqual(self.made(request), {"ability": "maps.update_floorplan", **self.PLAN, "old_rank_uuid": self.OLD})
        # The old one is no longer the robot's, and the other robot's of that name still is its own.
        self.assertEqual(await self.plans(), {MAP["rank_uuid"]: 1, self.ELSE: 8})
        self.assertEqual([row["rank_uuid"] for row in self.server.store.floorplans(self.OTHER)], [self.OLD])
        # In place of one the server never had the robot make, named as it was given.
        elsewhere = "AAAAAAAA-0000-BBBB-1111-CCCCCCCCCCCC"
        request, _ = await self.answered(robot, f"{self.BOARD1}&action=update&map=1&old_rank_uuid={elsewhere}", self.DONE)
        self.assertEqual(request["body"]["old_rank_uuid"], elsewhere)
        self.assertEqual(await self.plans(), {MAP["rank_uuid"]: 1, self.ELSE: 8})

    async def test_demote_names_the_floor_plan(self) -> None:
        await self.start()
        self.server.store.save_floorplan(self.ROBOT, self.OLD, 1)
        self.server.store.save_floorplan(self.ROBOT, self.ELSE, 1)
        robot, _ = await self.login()
        # A map that comes with it is not looked at.
        request, told = await self.answered(robot, f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}&map=nonsense", self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.demote_floorplan", "code": 200, "body": {}}))
        self.assertEqual(set(request), {"type", "id", "body"})
        self.assertEqual(request["body"], {"ability": "maps.demote_floorplan", "rank_uuid": self.OLD})
        self.assertEqual(await self.plans(), {self.ELSE: 1})
        # One the server never had the robot make is asked of the robot all the same, which may have it from elsewhere.
        request, told = await self.answered(robot, f"{self.BOARD1}&action=demote&rank_uuid={MAP['rank_uuid']}", self.DONE)
        self.assertEqual((request["body"]["rank_uuid"], told[0]), (MAP["rank_uuid"], 200))
        self.assertEqual(await self.plans(), {self.ELSE: 1})

    async def test_floor_plan_is_made_of_what_the_spec_gives_one_and_no_more(self) -> None:
        await self.start()
        robot, _ = await self.login()
        # As a robot on firmware 1.7.0 gave the base of a run on no floor plan, and with what a newer one might add.
        nowhere = {"x": 2147483647, "y": -2147483648, "dir": 274, "seen": False}
        odd = {**MAP, "rank_uuid": self.ELSE.upper(), "added_by_newer_firmware": "caf\u00e9", "long": 10 ** 400,
               "map": {**MAP["map"], "resolution": 40}, "robot": {"base": nowhere}}
        request, _ = await self.answered(robot, f"{self.BOARD1}&action=promote&map={self.upload(odd)}", self.DONE)
        self.assertEqual(self.made(request), {
            "ability": "maps.promote_floorplan", **self.PLAN, "rank_uuid": self.ELSE.upper(), "old_rank_uuid": None,
            "base": {"x": 2147483647, "y": -2147483648, "dir": 274}, "nogo_track": None, "cleaning_tracks": [],
        })

    async def test_what_the_robot_does_not_accept_is_not_noted(self) -> None:
        await self.start()
        robot, _ = await self.login()
        update = f"{self.BOARD1}&action=update&map=1&old_rank_uuid={self.OLD}"
        demote = f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}"
        self.server.store.save_floorplan(self.ROBOT, self.OLD, 7)
        # The status says that the robot answered, not what it answered, and 200 alone is the robot accepting.
        for answer, told in (
            ({"code": 422, "body": {}}, {"code": 422, "body": {}}),
            ({"code": 400}, {"code": 400, "body": None}),
            ({"code": "200", "body": ["caf\u00e9"]}, {"code": "200", "body": ["caf\u00e9"]}),
            ({}, {"code": None, "body": None}),
        ):
            for target, ability in ((self.PROMOTE, "promote"), (update, "update"), (demote, "demote")):
                with self.subTest(answer=answer, ability=ability):
                    self.assertEqual((await self.answered(robot, target, answer))[1],
                                     (200, {"ability": f"maps.{ability}_floorplan", **told}))
                    self.assertEqual(await self.plans(), {self.OLD: 7})

    async def test_what_is_not_sent_to_a_robot(self) -> None:
        await self.start()
        robot, _ = await self.login()
        mine = MAP["rank_uuid"]
        not_one = ("", "first", "1", "..%2F..%2Fetc", self.OLD[:-1], self.OLD + "0", self.OLD + "%0A", "%20" + self.OLD,
                   self.OLD.replace("-", ""), "%7B" + self.OLD + "%7D", "g" + self.OLD[1:], "%D9%A1" + self.OLD[1:])
        refused = {
            "action must be one of promote, update, demote": [
                self.BOARD1, *(f"{self.BOARD1}&action={action}&map=1&rank_uuid={self.OLD}&old_rank_uuid={self.OLD}"
                               for action in ("", "PROMOTE", "maps.demote_floorplan", "delete", "demote%20")),
            ],
            "rank_uuid must be a UUID": [
                f"{self.BOARD1}&action=demote", f"{self.BOARD1}&action=demote&old_rank_uuid={self.OLD}&map=1",
                *(f"{self.BOARD1}&action=demote&rank_uuid={given}" for given in not_one),
            ],
            "old_rank_uuid must be a UUID": [
                f"{self.BOARD1}&action=update&map=1", f"{self.BOARD1}&action=update&map=1&rank_uuid={self.OLD}",
                *(f"{self.BOARD1}&action=update&map=1&old_rank_uuid={given}" for given in not_one),
            ],
            # A floor plan does not take its own place.
            "old_rank_uuid must not be the map's own rank_uuid": [
                f"{self.BOARD1}&action=update&map=1&old_rank_uuid={given}" for given in (mine, mine.upper())
            ],
        }
        for error, targets in refused.items():
            for target in targets:
                with self.subTest(error=error, target=target):
                    self.assertEqual(await self.command(target), (400, {"error": error}))
        # Asked of a robot that is not there, an action or a floor plan is wrong all the same.
        for target in refused["action must be one of promote, update, demote"] + refused["rank_uuid must be a UUID"]:
            with self.subTest(target=target):
                self.assertEqual((await self.command(target.replace("serial=board1", "serial=board2")))[0], 400)

        # A floor plan is made of a map of this robot's that the database has.
        other = self.upload(MAP, self.OTHER)
        for given in ("", "&map=", f"&map={other}", "&map=3", "&map=0", "&map=-1", "&map=1.0", "&map=one", f"&map={2 ** 63}",
                      "&map=" + "9" * 5000, f"&rank_uuid={mine}"):
            for action in ("promote", f"update&old_rank_uuid={self.OLD}"):
                with self.subTest(given=given[:60], action=action):
                    self.assertEqual(await self.command(f"{self.BOARD1}&action={action}{given}"),
                                     (404, {"error": "no such map in the database"}))
        self.assertEqual(await self.command("/api/floorplan?vendor=n&serial=board2&action=promote&map=1"),
                         (404, {"error": "no such map in the database"}))

        # And of a map that has all that a floor plan takes of one, each as the spec has it.
        def binaries(**changes: object) -> dict:
            return {**MAP, "map": {**MAP["map"], **changes}}

        def base(**changes: object) -> dict:
            return {**MAP, "robot": {**MAP["robot"], "base": {**MAP["robot"]["base"], **changes}}}

        def less(given: dict, name: str) -> dict:
            return {key: value for key, value in given.items() if key != name}

        not_base64 = ("", "cmFuaw", "cmFuaw=", "cmFu aw==", "cmFu\naw==", "cmFuaw==!", "caf\u00e9", 7, None, ["cmFuaw=="])
        unfit = {
            "the map's rank_uuid must be a UUID": [
                {}, less(MAP, "rank_uuid"), *({**MAP, "rank_uuid": given} for given in (None, "", "second", 7, [mine], mine + "\n")),
            ],
            "the map's map.rank_binary must be Base64 that is not empty": [
                less(MAP, "map"), {**MAP, "map": None}, {**MAP, "map": "elsewhere"}, {**MAP, "map": [MAP["map"]]},
                {**MAP, "map": less(MAP["map"], "rank_binary")}, *(binaries(rank_binary=given) for given in not_base64),
            ],
            "the map's map.real_binary must be Base64 that is not empty": [
                {**MAP, "map": less(MAP["map"], "real_binary")}, *(binaries(real_binary=given) for given in not_base64),
            ],
            "the map's robot.base must be an object of x, y, dir": [
                less(MAP, "robot"), {**MAP, "robot": None}, {**MAP, "robot": {"pos": MAP["robot"]["pos"]}},
                *({**MAP, "robot": {"base": given}} for given in (None, [20, 200, 45.0], "20,200", 0)),
            ],
            "the map's robot.base.x must be a whole number": [
                {**MAP, "robot": {"base": {"y": 200, "dir": 45.0}}}, *(base(x=given) for given in (20.5, 20.0, "20", True, None, [20])),
            ],
            "the map's robot.base.y must be a whole number": [
                {**MAP, "robot": {"base": {"x": 20, "dir": 45.0}}}, *(base(y=given) for given in (0.5, "200", False, None)),
            ],
            "the map's robot.base.dir must be a number": [
                {**MAP, "robot": {"base": {"x": 20, "y": 200}}}, *(base(dir=given) for given in ("45", True, None, [45.0], {})),
            ],
            # The robot fails a promotion whose date_created it cannot read as a UTC timestamp.
            "the map's timing.end must be a UTC time as YYYY-MM-DDTHH:MM:SSZ": [
                less(MAP, "timing"), {**MAP, "timing": None}, {**MAP, "timing": MAP["timing"]["end"]},
                {**MAP, "timing": less(MAP["timing"], "end")},
                *({**MAP, "timing": {**MAP["timing"], "end": given}} for given in (
                    None, "", 7, "2026-10-06T12:45:00", "2026-10-06T12:45:00.5Z", "2026-10-06 12:45:00Z", "2026-10-06T12:45Z",
                    "2026-10-06T12:45:00+00:00", "2026-10-06T12:45:00z", " 2026-10-06T12:45:00Z", "2026-10-06T12:45:00Z\n",
                    "2026-02-30T12:45:00Z", "2026-10-06T24:00:00Z", "２026-10-06T12:45:00Z",
                )),
            ],
        }
        for error, maps in unfit.items():
            for body in maps:
                number = self.upload(body)
                for action in ("promote", f"update&old_rank_uuid={self.OLD}"):
                    with self.subTest(error=error, body=str(body)[:120], action=action):
                        self.assertEqual(await self.command(f"{self.BOARD1}&action={action}&map={number}"), (400, {"error": error}))
        self.assertEqual(await self.plans(), {})
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}", self.DONE)
        self.assertEqual(request["body"], {"ability": "maps.demote_floorplan", "rank_uuid": self.OLD})

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        self.server.store.save_floorplan(self.ROBOT, self.OLD, 1)
        for target in (self.PROMOTE, f"{self.BOARD1}&action=update&map=1&old_rank_uuid={self.OLD}",
                       f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}",
                       f"/api/floorplan?vendor=n&serial=board2&action=demote&rank_uuid={self.OLD}",
                       f"/api/floorplan?action=demote&rank_uuid={self.OLD}"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (409, {"error": "the robot is not connected"}))
        self.assertEqual(await self.plans(), {self.OLD: 1})

    async def test_only_this_server_s_own_page_may_ask(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (403, {"error": "a command is taken only from this server's own page"})
        demote = f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}"
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            for target in (self.PROMOTE, demote, "/api/floorplan"):
                with self.subTest(sent=sent, target=target):
                    self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT", "DELETE"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.PROMOTE, method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, demote, self.DONE)
        self.assertEqual(request["body"], {"ability": "maps.demote_floorplan", "rank_uuid": self.OLD})

    async def test_robot_that_does_not_answer_in_time(self) -> None:
        await self.start()
        robot, _ = await self.login()
        with mock.patch.object(web, "_COMMAND_TIMEOUT", 0.05):
            self.assertEqual(await self.command(self.PROMOTE), (504, {"error": "the robot did not answer within 0.05 s"}))
        request = await robot.recv()
        self.assertEqual(request["body"]["ability"], "maps.promote_floorplan")
        # An answer that comes after that is nobody's, so the floor plan it tells of is not noted.
        with self.assertLogs("deorbit", "WARNING") as logs:
            await robot.send({"type": "response", "id": request["id"], **self.DONE})
            self.assertEqual((await robot.request("firmware.check", {}, "last"))["id"], "last")
        self.assertIn("no such call pending", logs.output[0])
        self.assertEqual(await self.plans(), {})
        # Asked again, the robot is sent the same, and what it accepts then is noted.
        await self.answered(robot, self.PROMOTE, self.DONE)
        self.assertEqual(await self.plans(), {MAP["rank_uuid"]: 1})
        sending = asyncio.create_task(self.command(f"{self.BOARD1}&action=demote&rank_uuid={MAP['rank_uuid']}"))
        await robot.recv()
        robot.writer.transport.abort()
        status, told = await sending
        self.assertEqual(status, 502)
        self.assertRegex(told["error"], r"^no answer from the robot: session closed: connection ")
        self.assertEqual(await self.plans(), {MAP["rank_uuid"]: 1})

    async def test_floor_plan_that_cannot_be_noted(self) -> None:
        await self.start()
        self.server.store.save_floorplan(self.ROBOT, self.OLD, 7)
        robot, _ = await self.login()
        told = (503, {"error": "the robot accepted it, but that could not be saved to the database"})
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            # A file that takes no change to a floor plan, as a full disk would not.
            for change in ("INSERT", "UPDATE", "DELETE"):
                db.execute(f"CREATE TRIGGER no_{change} BEFORE {change} ON floorplans BEGIN SELECT RAISE(ABORT, 'full'); END")
            for target in (self.PROMOTE, f"{self.BOARD1}&action=update&map=1&old_rank_uuid={self.OLD}",
                           f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}"):
                with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                    # The robot has done it by then, and the page is told that the list is not the robot's any more.
                    self.assertEqual((await self.answered(robot, target, self.DONE))[1], told)
                    self.assertIn("[n/board1] not saved to the database: full", logs.output[0])
            self.assertEqual(await self.plans(), {self.OLD: 7})
            for change in ("INSERT", "UPDATE", "DELETE"):
                db.execute(f"DROP TRIGGER no_{change}")
        # Asking again puts it right, where the robot accepts again.
        await self.answered(robot, f"{self.BOARD1}&action=demote&rank_uuid={self.OLD}", self.DONE)
        self.assertEqual(await self.plans(), {})

    async def test_change_and_its_answer_are_among_the_events(self) -> None:
        await self.start()
        robot, _ = await self.login()
        await self.answered(robot, self.PROMOTE, self.DONE)
        answer, call, login = (await self.api(self.ROBOT1))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in (answer, call, login)],
                         [("response", None), ("call", None), ("login", None)])
        # The binaries are in the map the floor plan was made of, and here by their length alone.
        sent = json.loads(call["body_json"])
        self.assertEqual(sent.pop("date_created"), MAP["timing"]["end"])
        self.assertEqual(sent, {"ability": "maps.promote_floorplan", **self.PLAN, "rank_binary": "<8 chars>",
                                "real_binary": "<8 chars>", "old_rank_uuid": None, "nogo_track": None, "cleaning_tracks": []})
        self.assertEqual(json.loads(answer["body_json"]), {"ability": "maps.promote_floorplan", "code": 200, "body": {}})


class TrackTests(WebTestCase):
    """``POST /api/track``, which is what has a robot keep the zones and the no-go lines of a floor plan, or drop them."""

    OTHER = RobotId("n", "board0")
    ROBOT1 = "/api/robot?vendor=n&serial=board1"
    BOARD1 = "/api/track?vendor=n&serial=board1"
    DONE = {"code": 200, "body": {}}
    PLAN = MAP["rank_uuid"]
    ELSE = "fb7f8145-0615-4a32-8f0d-8d833cd51a5e"
    # The PGM files of a floor plan of 20 by 10 cells, with headers as the maps of a robot have them: its real_binary,
    # and its rank_binary, which has the alignment that the real one has not. A track has the real one's header, but
    # with the maxval of a track's file of two bytes to a cell.
    HEADER = b"P5\r\n# Neato metadata: origin_x=-400 origin_y=-200 resolution=40 alignment=0.000000\r\n20 10\r\n255\r"
    RANK = b"P5\r\n# Neato metadata: origin_x=-400 origin_y=-200 resolution=40 alignment=1.535890\r\n20 10\r\n255\r"
    TRACK = b"P5\r\n# Neato metadata: origin_x=-400 origin_y=-200 resolution=40 alignment=0.000000\r\n20 10\r\n65535\r"
    KITCHEN = {"name": "Kitchen", "cleaning_mode": "eco", "rect": [2, 1, 5, 3]}
    UUID4 = r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

    @staticmethod
    def floor() -> dict:
        """A map of such a floor plan, its two files zlib's and as Base64."""
        def packed(file: bytes) -> str:
            return base64.b64encode(zlib.compress(file)).decode()
        binaries = {"rank_binary": packed(TrackTests.RANK + bytes([128]) * 200), "real_binary": packed(TrackTests.HEADER + bytes(200))}
        return {**MAP, "map": {**MAP["map"], **binaries}}

    async def start(self, **overrides: object) -> Web:
        web = await super().start(**overrides)
        self.server.store.save_heartbeat(self.ROBOT)
        self.server.store.save_map(self.ROBOT, self.floor())
        self.server.store.save_floorplan(self.ROBOT, self.PLAN, 1)
        return web

    def zone(self, zone: object, track_uuid: str | None = None, plan: str = PLAN) -> str:
        given = f"&track_uuid={track_uuid}" if track_uuid else ""
        return f"{self.BOARD1}&action=zone&rank_uuid={plan}&zone={quote(json.dumps(zone))}{given}"

    def lines(self, lines: object, plan: str = PLAN) -> str:
        return f"{self.BOARD1}&action=nogo&rank_uuid={plan}&lines={quote(json.dumps(lines))}"

    def drawn(self, sent: dict) -> list[str]:
        """The cells of a track's binary, a line of text to each row: # for 1024 and . for 0. Its header is that of the floor plan's real_binary, but for the maxval."""
        file = zlib.decompress(base64.b64decode(sent["track_binary"], validate=True))
        self.assertTrue(file.startswith(self.TRACK))
        cells = file[len(self.TRACK):]
        self.assertEqual(len(cells), 400)
        values = {int.from_bytes(cells[at : at + 2], "little") for at in range(0, 400, 2)}
        self.assertLessEqual(values, {0, 1024})
        return ["".join("#" if int.from_bytes(cells[at : at + 2], "little") else "." for at in range(row * 40, (row + 1) * 40, 2))
                for row in range(10)]

    def sent(self, request: dict) -> dict:
        """The one track a robot was sent to keep, without its binary, which ``drawn`` reads."""
        self.assertEqual(set(request), {"type", "id", "body"})
        self.assertEqual(set(request["body"]), {"ability", "tracks"})
        self.assertEqual(request["body"]["ability"], "maps.save_track")
        (sent,) = request["body"]["tracks"]
        return {key: value for key, value in sent.items() if key != "track_binary"}

    async def tracks(self) -> list[tuple]:
        """The tracks that come with the robot's page, each as what it is and what was drawn."""
        rows = (await self.api(self.ROBOT1))["tracks"]
        return [(row["track_uuid"], row["rank_uuid"], row["type"], row["name"], row["mode"], json.loads(row["shape_json"]))
                for row in rows]

    async def test_zone_is_drawn_on_its_floor_plan_and_kept(self) -> None:
        await self.start()
        robot, _ = await self.login()
        request, told = await self.answered(robot, self.zone(self.KITCHEN), self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.save_track", "code": 200, "body": {}}))
        made = self.sent(request)
        self.assertRegex(made["track_uuid"], self.UUID4)
        self.assertEqual(made, {"rank_uuid": self.PLAN, "track_uuid": made["track_uuid"], "track_name": "Kitchen",
                                "type": "cleaning", "cleaning_mode": "eco"})
        self.assertEqual(self.drawn(request["body"]["tracks"][0]), [
            "." * 20,
            "..####" + "." * 14,
            "..####" + "." * 14,
            "..####" + "." * 14,
            *["." * 20] * 6,
        ])
        kitchen = made["track_uuid"]
        self.assertEqual(await self.tracks(), [(kitchen, self.PLAN, "cleaning", "Kitchen", "eco", [2, 1, 5, 3])])
        # Changed, it is the same track, its name made one line; as large as the floor plan, it is all of it.
        whole = {"name": " Pantry\t corner\n", "cleaning_mode": "max", "rect": [0, 0, 19, 9]}
        request, _ = await self.answered(robot, self.zone(whole, kitchen), self.DONE)
        self.assertEqual((self.sent(request)["track_uuid"], self.sent(request)["track_name"]), (kitchen, "Pantry corner"))
        self.assertEqual(self.drawn(request["body"]["tracks"][0]), ["#" * 20] * 10)
        # Another is one more, as small as a cell.
        request, _ = await self.answered(robot, self.zone({**self.KITCHEN, "name": "Hall", "rect": [19, 9, 19, 9]}), self.DONE)
        hall = self.sent(request)["track_uuid"]
        self.assertNotEqual(hall, kitchen)
        self.assertEqual(self.drawn(request["body"]["tracks"][0])[9], "." * 19 + "#")
        # The one first added stays first, whatever it is called now.
        self.assertEqual(await self.tracks(), [(kitchen, self.PLAN, "cleaning", "Pantry corner", "max", [0, 0, 19, 9]),
                                               (hall, self.PLAN, "cleaning", "Hall", "eco", [19, 9, 19, 9])])

    async def test_floor_plan_has_so_many_zones_at_most(self) -> None:
        await self.start()
        store = self.server.store
        robot, _ = await self.login()
        zones = [str(uuid.uuid4()) for _ in range(ZONES_MAX - 1)]
        for n, zone in enumerate(zones):
            store.save_track(self.ROBOT, self.PLAN, zone, "cleaning", f"Room {n}", "eco", [0, 0, 1, 1])
        # Neither the no-go lines nor the zones of another floor plan are among them.
        store.save_track(self.ROBOT, self.PLAN, self.PLAN, "no-go", None, None, [[0, 0, 1, 1]])
        store.save_track(self.ROBOT, self.ELSE, self.ELSE, "cleaning", "Attic", "eco", [0, 0, 1, 1])
        request, _ = await self.answered(robot, self.zone(self.KITCHEN), self.DONE)
        zones.append(self.sent(request)["track_uuid"])
        full = (400, {"error": f"the floor plan has {ZONES_MAX} zones, the most it may have"})
        self.assertEqual(await self.command(self.zone({**self.KITCHEN, "name": "Hall"})), full)
        # One it has may still be changed, which the robot is sent next, and not the one refused.
        request, _ = await self.answered(robot, self.zone({**self.KITCHEN, "name": "Hall"}, zones[0]), self.DONE)
        self.assertEqual(self.sent(request)["track_uuid"], zones[0])
        # Once one has gone, another may come.
        store.delete_tracks(self.ROBOT, [zones[1]])
        request, _ = await self.answered(robot, self.zone(self.KITCHEN), self.DONE)
        self.assertNotIn(self.sent(request)["track_uuid"], zones)
        self.assertEqual(len([row for row in await self.tracks() if row[1] == self.PLAN and row[2] == "cleaning"]), ZONES_MAX)

    async def test_no_go_lines_are_one_track_of_their_floor_plan(self) -> None:
        await self.start()
        robot, _ = await self.login()
        request, told = await self.answered(robot, self.lines([[0, 0, 4, 0], [0, 2, 3, 5]]), self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.save_track", "code": 200, "body": {}}))
        made = self.sent(request)
        self.assertRegex(made["track_uuid"], self.UUID4)
        # Without a name and a mode, as the spec has a no-go track conventionally go.
        self.assertEqual(made, {"rank_uuid": self.PLAN, "track_uuid": made["track_uuid"], "track_name": None,
                                "type": "no-go", "cleaning_mode": None})
        # A line on the diagonal has no corner that a step on the diagonal passes through.
        self.assertEqual(self.drawn(request["body"]["tracks"][0])[:7], [
            "#####" + "." * 15,
            "." * 20,
            "##" + "." * 18,
            ".##" + "." * 17,
            "..##" + "." * 16,
            "...#" + "." * 16,
            "." * 20,
        ])
        lines = made["track_uuid"]
        self.assertEqual(await self.tracks(), [(lines, self.PLAN, "no-go", None, None, [[0, 0, 4, 0], [0, 2, 3, 5]])])
        # Drawn again, from right to left and up, they are the same track, whatever the page names.
        target = self.lines([[19, 9, 0, 0]]) + f"&track_uuid={self.ELSE}"
        request, _ = await self.answered(robot, target, self.DONE)
        self.assertEqual(self.sent(request)["track_uuid"], lines)
        self.assertEqual(sum(row.count("#") for row in self.drawn(request["body"]["tracks"][0])), 20 + 10 - 1)
        self.assertEqual(await self.tracks(), [(lines, self.PLAN, "no-go", None, None, [[19, 9, 0, 0]])])
        # As many as there may be.
        request, _ = await self.answered(robot, self.lines([[0, 0, 1, 1]] * LINES_MAX), self.DONE)
        self.assertEqual(self.sent(request)["track_uuid"], lines)

    async def test_delete_names_the_track(self) -> None:
        await self.start()
        store = self.server.store
        store.save_track(self.ROBOT, self.PLAN, self.ELSE, "cleaning", "Hall", "eco", [0, 0, 1, 1])
        store.save_track(self.ROBOT, self.PLAN, self.PLAN, "no-go", None, None, [[0, 0, 1, 1]])
        store.save_track(self.OTHER, self.PLAN, self.ELSE, "cleaning", "Hall", "eco", [0, 0, 1, 1])
        robot, _ = await self.login()
        request, told = await self.answered(robot, f"{self.BOARD1}&action=delete&track_uuid={self.ELSE}&rank_uuid=x", self.DONE)
        self.assertEqual(told, (200, {"ability": "maps.delete_track", "code": 200, "body": {}}))
        self.assertEqual(request["body"], {"ability": "maps.delete_track", "tracks": [self.ELSE]})
        self.assertEqual([row[0] for row in await self.tracks()], [self.PLAN])
        self.assertEqual(len(store.tracks(self.OTHER)), 1)
        # One the server never had the robot keep is asked of the robot all the same.
        upper = self.ELSE.upper()
        request, _ = await self.answered(robot, f"{self.BOARD1}&action=delete&track_uuid={upper}", self.DONE)
        self.assertEqual(request["body"]["tracks"], [upper])
        # A floor plan that the robot drops takes its tracks with it.
        await self.answered(robot, f"/api/floorplan?vendor=n&serial=board1&action=demote&rank_uuid={self.PLAN}", self.DONE)
        self.assertEqual(await self.tracks(), [])

    async def test_what_is_not_sent_to_a_robot(self) -> None:
        await self.start()
        store = self.server.store
        robot, _ = await self.login()
        store.save_track(self.ROBOT, self.PLAN, self.PLAN, "no-go", None, None, [[0, 0, 1, 1]])
        # A floor plan whose map the database has no more, and a zone of another floor plan.
        store.save_floorplan(self.ROBOT, self.ELSE, 99)
        store.save_track(self.ROBOT, self.ELSE, self.ELSE, "cleaning", "Hall", "eco", [0, 0, 1, 1])
        not_one = ("first", "1", "..%2F..%2Fetc", self.ELSE[:-1], self.ELSE + "0", "%20" + self.ELSE, self.ELSE.replace("-", ""))
        refused = {
            "action must be one of zone, nogo, delete": [
                self.BOARD1, *(f"{self.BOARD1}&action={action}&rank_uuid={self.PLAN}&track_uuid={self.ELSE}"
                               for action in ("", "ZONE", "maps.save_track", "update", "zone%20", "lines")),
            ],
            "track_uuid must be a UUID": [
                f"{self.BOARD1}&action=delete", f"{self.BOARD1}&action=delete&rank_uuid={self.PLAN}",
                *(f"{self.BOARD1}&action=delete&track_uuid={given}" for given in not_one),
            ],
            "zone must be JSON": [
                f"{self.BOARD1}&action=zone&rank_uuid={self.PLAN}", self.zone(self.KITCHEN)[:-3],
                f"{self.BOARD1}&action=zone&rank_uuid={self.PLAN}&zone=" + "%5B" * 5000,
            ],
            "lines must be JSON": [f"{self.BOARD1}&action=nogo&rank_uuid={self.PLAN}", self.lines([[0, 0, 1, 1]])[:-3]],
            "zone must be an object of name, cleaning_mode, rect and nothing else": [
                self.zone(given) for given in ({}, [], "Kitchen", None, {"name": "Kitchen", "rect": [0, 0, 1, 1]},
                                               {**self.KITCHEN, "track_uuid": self.ELSE}, {**self.KITCHEN, "Rect": [0, 0, 1, 1]})
            ],
            f"zone.name must be from 1 to {ZONE_NAME_MAX} characters": [
                self.zone({**self.KITCHEN, "name": given}) for given in ("", " \t\n", "k" * (ZONE_NAME_MAX + 1), 7, None, ["Hall"])
            ],
            "zone.name must not hold control characters": [
                self.zone({**self.KITCHEN, "name": given}) for given in ("Hall\u0000", "a\u0007b", "\u007f", "\ud800")
            ],
            "zone.cleaning_mode must be one of eco, turbo, auto, max": [
                self.zone({**self.KITCHEN, "cleaning_mode": given}) for given in ("ECO", "", None, "normal", ["eco"])
            ],
            "zone.rect must be a list of four whole numbers": [
                self.zone({**self.KITCHEN, "rect": given}) for given in ([1, 2, 3], [1, 2, 3, 4, 5], "1,2,3,4", None, {"x": 1})
            ],
            "zone.rect[0] must be a whole number from 0 to 19": [
                self.zone({**self.KITCHEN, "rect": [given, 0, 1, 1]}) for given in (-1, 20, 1.0, True, "1", None)
            ],
            "zone.rect[1] must be a whole number from 0 to 9": [self.zone({**self.KITCHEN, "rect": [0, 10, 1, 1]})],
            "zone.rect[2] must be a whole number from 0 to 19": [self.zone({**self.KITCHEN, "rect": [0, 0, 2 ** 64, 1]})],
            "zone.rect[3] must be a whole number from 0 to 9": [self.zone({**self.KITCHEN, "rect": [0, 0, 1, 1.5]})],
            "zone.rect must give its top left corner before its bottom right one": [
                self.zone({**self.KITCHEN, "rect": given}) for given in ([5, 1, 2, 3], [2, 3, 5, 1], [19, 9, 0, 0])
            ],
            f"lines must be a list of from 1 to {LINES_MAX} lines": [
                self.lines(given) for given in ([], {}, "0,0,1,1", None, [[0, 0, 1, 1]] * (LINES_MAX + 1))
            ],
            "lines[0] must be a list of four whole numbers": [self.lines(given) for given in ([[0, 0, 1]], [None], [[[0, 0, 1, 1]]])],
            "lines[1][2] must be a whole number from 0 to 19": [self.lines([[0, 0, 1, 1], [0, 0, 20, 1]])],
            "lines[0][3] must be a whole number from 0 to 9": [self.lines([[0, 0, 1, -1]])],
            "lines[1] must not end where it starts": [self.lines([[0, 0, 1, 1], [3, 4, 3, 4]])],
        }
        for error, targets in refused.items():
            for target in targets:
                with self.subTest(error=error, target=target[:160]):
                    self.assertEqual(await self.command(target), (400, {"error": error}))

        # A track is drawn on a floor plan this server had the robot keep, of a map the database has.
        for target in (self.zone(self.KITCHEN, plan=""), self.zone(self.KITCHEN, plan=self.PLAN.upper()),
                       self.zone(self.KITCHEN, plan=self.ELSE), self.lines([[0, 0, 1, 1]], plan="x"),
                       self.lines([[0, 0, 1, 1]], plan=self.ELSE), self.lines([[0, 0, 1, 1]]).replace("board1", "board2")):
            with self.subTest(target=target):
                self.assertEqual(await self.command(target), (404, {"error": "no such floor plan in the database"}))
        # And a zone that is changed is one of that floor plan's.
        for given in ("x", self.PLAN, self.ELSE, self.PLAN.upper()):
            with self.subTest(given=given):
                self.assertEqual(await self.command(self.zone(self.KITCHEN, given)),
                                 (404, {"error": "no such zone of that floor plan in the database"}))

        # The floor plan's map has to say how large the floor plan is, which is in the header of its real_binary,
        # the one a track is drawn on, and its rank_binary has to be as large.
        def plan(**binaries: object) -> None:
            store.save_map(self.ROBOT, {**MAP, "map": {**self.floor()["map"], **binaries}})
            store.save_floorplan(self.ROBOT, self.PLAN, store.maps(self.ROBOT, 1)[0]["id"])

        def packed(file: bytes) -> str:
            return base64.b64encode(zlib.compress(file)).decode()

        unreadable = (
            "cmFuaw==", packed(b""), packed(b"P6\n20 10\n255\r" + bytes(600)), packed(b"P5\n20 10\n65535\r" + bytes(400)),
            packed(b"P5\n20 10\n255"), packed(b"P5\n20 10 255#c\n" + bytes(200)), packed(b"P5\n0 10\n255\r"),
            packed(b"P5\n20 x\n255\r" + bytes(200)), packed(b"P5\n20 10\n0\r" + bytes(200)), packed(b"P5 " + b"#" * 5000),
            # And zlib data that ends within the header.
            packed(b"P5\n-20 10\n255\r" + bytes(200)), base64.b64encode(zlib.compress(self.HEADER)[:44]).decode(),
        )
        unfit = {
            "the floor plan's map.real_binary must be Base64 that is not empty": [
                {"real_binary": given} for given in ("", "cmFuaw", None, 7)
            ],
            "the floor plan's map.real_binary must be zlib data of a binary PGM file of a byte to a cell": [
                {"real_binary": given} for given in unreadable
            ],
            # The robot reads a file of a byte to a cell with no other maxval.
            "the floor plan's map.real_binary must be a PGM file whose maxval is from 129 to 255": [
                {"real_binary": packed(b"P5\n20 10\n" + most + b"\r" + bytes(200))} for most in (b"1", b"128")
            ],
            "the floor plan's map.real_binary is a PGM file of more than 33554432 cells": [
                {"real_binary": packed(b"P5 8193 4097 255\n")}
            ],
            "the floor plan's map.rank_binary must be Base64 that is not empty": [{"rank_binary": None}],
            "the floor plan's map.rank_binary must be zlib data of a binary PGM file of a byte to a cell": [
                {"rank_binary": given} for given in unreadable[:3]
            ],
            "the floor plan's map.rank_binary must be a PGM file whose maxval is from 129 to 255": [
                {"rank_binary": packed(b"P5\n20 10\n128\r" + bytes(200))}
            ],
            # A track is drawn in cells of the rank_binary, which the page shows, and sent in those of the real_binary.
            "the floor plan's map.rank_binary and map.real_binary must be of one size": [
                {"rank_binary": packed(given + bytes(200))} for given in (b"P5\n10 20\n255\r", b"P5\n20 11\n255\r")
            ],
        }
        for error, changes in unfit.items():
            for binaries in changes:
                plan(**binaries)
                for target in (self.zone(self.KITCHEN), self.lines([[0, 0, 1, 1]])):
                    with self.subTest(error=error, binaries=str(binaries)[:80], target=target[:60]):
                        self.assertEqual(await self.command(target), (400, {"error": error}))
        # A header with comments wherever they may be, and a file that has fewer cells than it says, are drawn on.
        plan(real_binary=packed(b"P5 #a\n#b\r20#c\n 10\t# d\n255 " + bytes(5)))
        request, _ = await self.answered(robot, self.lines([[0, 0, 1, 0]]), self.DONE)
        file = zlib.decompress(base64.b64decode(request["body"]["tracks"][0]["track_binary"]))
        self.assertEqual(file, b"P5 #a\n#b\r20#c\n 10\t# d\n65535 " + (1024).to_bytes(2, "little") * 2 + bytes(396))

    async def test_robot_that_is_not_connected(self) -> None:
        await self.start()
        for target in (self.zone(self.KITCHEN), self.lines([[0, 0, 1, 1]]), f"{self.BOARD1}&action=delete&track_uuid={self.ELSE}",
                       f"/api/track?action=delete&track_uuid={self.ELSE}"):
            with self.subTest(target):
                self.assertEqual(await self.command(target), (409, {"error": "the robot is not connected"}))
        self.assertEqual(await self.tracks(), [])

    async def test_only_this_server_s_own_page_may_ask(self) -> None:
        await self.start()
        robot, _ = await self.login()
        told = (403, {"error": "a command is taken only from this server's own page"})
        for sent in (("Host: localhost:8080",), ("Host: localhost:8080", "Origin: http://elsewhere.example"), ()):
            for target in (self.zone(self.KITCHEN), "/api/track"):
                with self.subTest(sent=sent, target=target):
                    self.assertEqual(await self.command(target, sent), told)
        for method in ("GET", "HEAD", "PUT"):
            with self.subTest(method):
                status, headers, _ = await self.fetch(self.zone(self.KITCHEN), method, self.PAGE)
                self.assertEqual((status, headers["Allow"]), (405, "POST"))
        # None of those reached the robot: the first thing it is sent is this one.
        request, _ = await self.answered(robot, f"{self.BOARD1}&action=delete&track_uuid={self.ELSE}", self.DONE)
        self.assertEqual(request["body"], {"ability": "maps.delete_track", "tracks": [self.ELSE]})

    async def test_what_the_robot_does_not_accept_is_not_noted(self) -> None:
        await self.start()
        self.server.store.save_track(self.ROBOT, self.PLAN, self.ELSE, "cleaning", "Hall", "eco", [0, 0, 1, 1])
        before = await self.tracks()
        robot, _ = await self.login()
        for answer, told in (({"code": 422, "body": {}}, {"code": 422, "body": {}}), ({"code": 400}, {"code": 400, "body": None}),
                             ({}, {"code": None, "body": None})):
            for target, ability in ((self.zone(self.KITCHEN, self.ELSE), "save"), (self.lines([[0, 0, 1, 1]]), "save"),
                                    (f"{self.BOARD1}&action=delete&track_uuid={self.ELSE}", "delete")):
                with self.subTest(answer=answer, target=target):
                    self.assertEqual((await self.answered(robot, target, answer))[1], (200, {"ability": f"maps.{ability}_track", **told}))
                    self.assertEqual(await self.tracks(), before)

    async def test_track_that_cannot_be_noted(self) -> None:
        await self.start()
        self.server.store.save_track(self.ROBOT, self.PLAN, self.ELSE, "cleaning", "Hall", "eco", [0, 0, 1, 1])
        before = await self.tracks()
        robot, _ = await self.login()
        told = (503, {"error": "the robot accepted it, but that could not be saved to the database"})
        with contextlib.closing(sqlite3.connect(self.server.config.database)) as db:
            for change in ("INSERT", "UPDATE", "DELETE"):
                db.execute(f"CREATE TRIGGER no_{change} BEFORE {change} ON tracks BEGIN SELECT RAISE(ABORT, 'full'); END")
            for target in (self.zone(self.KITCHEN), self.zone(self.KITCHEN, self.ELSE), self.lines([[0, 0, 1, 1]]),
                           f"{self.BOARD1}&action=delete&track_uuid={self.ELSE}"):
                with self.subTest(target), self.assertLogs("deorbit", "ERROR") as logs:
                    self.assertEqual((await self.answered(robot, target, self.DONE))[1], told)
                    self.assertIn("[n/board1] not saved to the database: full", logs.output[0])
            self.assertEqual(await self.tracks(), before)

    async def test_change_and_its_answer_are_among_the_events(self) -> None:
        await self.start()
        robot, _ = await self.login()
        request, _ = await self.answered(robot, self.zone(self.KITCHEN), self.DONE)
        answer, call, login = (await self.api(self.ROBOT1))["events"]
        self.assertEqual([(event["kind"], event["service"]) for event in (answer, call, login)],
                         [("response", None), ("call", None), ("login", None)])
        # The binary is drawn anew from what is noted, and here by its length alone.
        (made,) = request["body"]["tracks"]
        self.assertEqual(json.loads(call["body_json"]), {
            "ability": "maps.save_track", "tracks": [{**made, "track_binary": f"<{len(made['track_binary'])} chars>"}],
        })
        self.assertEqual(json.loads(answer["body_json"]), {"ability": "maps.save_track", "code": 200, "body": {}})

    async def test_page_offers_what_the_server_takes(self) -> None:
        await self.start()
        _, _, script = await self.fetch("/app.js")
        self.assertRegex(script.decode(), rf"(?m)^const ZONE_NAME_MAX = {ZONE_NAME_MAX};")
        self.assertRegex(script.decode(), rf"(?m)^const LINES_MAX = {LINES_MAX};")
        self.assertRegex(script.decode(), rf"(?m)^const ZONES_MAX = {ZONES_MAX};")
        # A colour of its own for each zone a floor plan may have, on a dark page and on a light one.
        _, _, painting = await self.fetch("/map.js")
        palettes = re.findall(r"(?m)^    zones: \[\n((?:      \[\d+, \d+, \d+\],\n)*)    \],$", painting.decode())
        self.assertEqual([part.count("\n") for part in palettes], [ZONES_MAX, ZONES_MAX])


class ServeTests(ServerTestCase):
    """``_serve``, which is what ``main`` runs: the robots' listener and the web UI together."""

    def config(self, **overrides: object) -> Config:
        settings = {"web_host": "127.0.0.1", "web_port": 0, **overrides}
        return Config(
            cert=self.dir / "certs" / "server.crt",
            key=self.dir / "certs" / "server.key",
            host="127.0.0.1",
            port=0,
            database=self.dir / "db" / f"{self.id()}.db",
            **settings,
        )

    def taken(self) -> int:
        """A port that something else is listening on."""
        listener = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(listener.close)
        return listener.getsockname()[1]

    async def serve(self, config: Config, until: str, then: object = None) -> list[str]:
        """Run ``_serve`` until it logs ``until``, await ``then`` with that line, and return every line logged."""
        with self.assertLogs("deorbit", "INFO") as logs:
            serving = asyncio.create_task(cli._serve(config))
            try:
                async with asyncio.timeout(5):
                    while not any(until in line for line in logs.output):
                        await asyncio.sleep(0.01)
                if then is not None:
                    await then(logs.output[-1])
            finally:
                serving.cancel()
                await asyncio.gather(serving, return_exceptions=True)
        return logs.output

    async def test_both_listeners_until_cancelled(self) -> None:
        async def ask(line: str) -> None:
            self.assertRegex(line, r"web UI on http://127\.0\.0\.1:\d+, open to anyone who can reach it$")
            self.port = int(re.search(r":(\d+),", line)[1])
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            self.addCleanup(writer.close)
            writer.write(b"GET /api/robots HTTP/1.1\r\n\r\n")
            self.assertIn(b'"robots":[]', await reader.read())

        await self.serve(self.config(), "web UI on", ask)
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", self.port)

    async def test_web_ui_turned_off(self) -> None:
        # With the UI off, its port is not even tried.
        lines = await self.serve(self.config(web=False, web_port=self.taken()), "listening on")
        self.assertNotIn("web UI", "".join(lines))

    async def test_web_port_in_use(self) -> None:
        config = self.config(web_port=self.taken())
        with mock.patch.object(Server, "stop", autospec=True, side_effect=Server.stop) as stop:
            with self.assertRaisesRegex(WebError, rf"^cannot serve the web UI on 127\.0\.0\.1:{config.web_port}: \w+"):
                await cli._serve(config)
        # The robots' listener and the database, opened first, were closed again.
        stop.assert_awaited_once()
