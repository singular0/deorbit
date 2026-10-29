"""Web UI: a plain HTTP listener that shows the robots in the database with their events and maps, names a robot and its maps, sends it commands, reads and changes its schedule and its settings, has it keep and drop floor plans and their zones and no-go lines, and deletes it or one of its maps."""

import asyncio
import hashlib
import json
import logging
import math
import socket
import time
import unicodedata
import uuid
from collections.abc import Callable
from functools import partial
from http import HTTPStatus
from importlib import resources
from typing import TYPE_CHECKING
from urllib.parse import parse_qs

from .auth import RobotId
from .commands import ZONES_MAX, command, floorplan, scheduling, settings, track
from .session import describe
from .store import StoreError, now

if TYPE_CHECKING:
    from .mqtt import Mqtt
    from .server import Server

log = logging.getLogger(__name__)

# What a browser loads, by request path: the file in static/ and its content
# type. The files are read once at startup, so no file name is ever built from
# a request.
_PAGES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/map.js": ("map.js", "text/javascript; charset=utf-8"),
    "/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
    # The browser-side helpers that "Bind a robot" loads to talk to a robot over WebUSB.
    "/neato-config.js": ("neato-config.js", "text/javascript; charset=utf-8"),
    "/mtp-client.js": ("mtp-client.js", "text/javascript; charset=utf-8"),
    "/webusb-transport.js": ("webusb-transport.js", "text/javascript; charset=utf-8"),
    "/mtp-fs.js": ("mtp-fs.js", "text/javascript; charset=utf-8"),
}
# What index.html holds where the server writes the version of the page into it.
_VERSION_MARK = b"{version}"
_JSON = "application/json"
_TEXT = "text/plain; charset=utf-8"

# How long a connection has to send its request, and then to take the response.
_TIMEOUT = 10.0
# How long a robot has to answer a command. The page waits a little longer for
# the answer to its request.
_COMMAND_TIMEOUT = 10.0
# The longest request line and headers read. A browser sends every cookie it
# holds for the host, whichever port set it, so this is not kept tight.
_MAX_HEAD = 64 * 1024

# How many of its latest events come with a robot when the request names no
# number, and the most that do.
_EVENTS = 25
_MAX_EVENTS = 1000
# The same for its maps. Each comes without its binaries, but is read whole to
# leave them out, so these are kept lower.
_MAPS = 10
_MAX_MAPS = 100
# The largest number a row of a table can have, which is the most the ``id`` of a map can be.
_MAX_ID = 2**63 - 1
# The most characters the name given to a robot, or to a map, may have.
_MAX_NAME = 64

# Sent with every response. Each connection carries one request. Nothing is
# cached, so a state on screen is never a stale one and an upgraded server is
# never shown through the old page. The page shows text that robots sent: it
# adds that as text, and the policy keeps it from running even if it did not.
_HEADERS = (
    "Connection: close\r\n"
    "Cache-Control: no-store\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n"
)


class WebError(Exception):
    """The web UI cannot listen on its address."""


def _finite(value: object) -> object:
    """``value``, or its text when it is an infinity, which SQLite reads out of a number beyond its range and JSON cannot write."""
    return str(value) if isinstance(value, float) and not math.isfinite(value) else value


def _json(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def _named(asked: dict[str, list[str]]) -> RobotId:
    """The robot a query names, which is none in the database when it names none."""
    # In the query, not the path: a vendor or serial may hold "/" or be "..",
    # which a browser would not leave in a path.
    return RobotId(*(asked.get(name, [""])[0].lower() for name in ("vendor", "serial")))


def _number(asked: dict[str, list[str]], name: str, most: int, default: int | None = None) -> int | None:
    """The number from 1 to ``most`` that a query gives as ``name``, or ``None`` when what it gives is not one."""
    try:
        number = int(asked.get(name, [default])[0])
    except (TypeError, ValueError):  # no number at all and no default, or not a number
        return None
    return number if 1 <= number <= most else None


def _name(asked: dict[str, list[str]]) -> str | None:
    """The name a query gives a robot or a map, as it is kept, or ``None`` when it gives none; one that is refused is a ``ValueError`` that says why."""
    # A name is one line: whatever white space it came with, its words end up a space apart.
    name = " ".join(asked.get("name", [""])[0].split())
    if len(name) > _MAX_NAME:
        raise ValueError(f"name must be at most {_MAX_NAME} characters")
    if any(unicodedata.category(character) == "Cc" for character in name):
        raise ValueError("name must not hold control characters")
    return name or None


def _version(pages: dict[str, tuple[str, bytes]]) -> str:
    """The version of the page that is made of ``pages``: a digest of every file, which any change to one of them changes."""
    digest = hashlib.sha256()
    for path, (_, body) in pages.items():
        # Each file with its length before it, so that bytes moved from one file to the next are a change too.
        digest.update(f"{path}\n{len(body)}\n".encode())
        digest.update(body)
    return digest.hexdigest()[:16]


def _response(status: int, kind: str, body: bytes, *, extra: str = "", bodiless: bool = False) -> bytes:
    head = (
        f"HTTP/1.1 {status} {HTTPStatus(status).phrase}\r\n"
        f"Content-Type: {kind}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"{_HEADERS}{extra}\r\n"
    )
    return head.encode("ascii") + (b"" if bodiless else body)


def _refusal(status: int, extra: str = "") -> bytes:
    return _response(status, _TEXT, f"{HTTPStatus(status).phrase}\n".encode(), extra=extra)


def _own_page(head: bytes) -> bool:
    """Whether a request comes from a page that this server served.

    A browser names the site a request comes from in ``Origin``, and for the
    UI's own page that is the host the request was sent to. A request from any
    other site fails this, and so does one that names no origin at all.
    """
    said: dict[str, list[str]] = {}
    for line in head.decode("latin-1").split("\r\n")[1:]:
        name, _, value = line.partition(":")
        said.setdefault(name.lower(), []).append(value.strip().lower())
    hosts, origins = said.get("host", []), said.get("origin", [])
    if len(hosts) != 1 or len(origins) != 1:
        return False
    scheme, _, origin = origins[0].partition("://")
    return scheme in ("http", "https") and hosts[0] != "" and origin == hosts[0]


class Web:
    def __init__(self, server: "Server", mqtt: "Mqtt | None" = None) -> None:
        self._config = server.config
        self._store = server.store
        self._sessions = server.sessions
        self._delete_robot = server.delete
        self._mqtt = mqtt  # Home Assistant, where the server is set to put the robots there
        static = resources.files(__package__) / "static"
        self._pages = {path: (kind, (static / name).read_bytes()) for path, (name, kind) in _PAGES.items()}
        # The files are read once, so a page that a server started with other files gave is out of date. The page
        # is given the version it is of in index.html, and the answers it polls for give the one the server has.
        self._version = _version(self._pages)
        kind, page = self._pages["/"]
        self._pages["/"] = kind, page.replace(_VERSION_MARK, self._version.encode())
        # What is sent on to a robot, and what changes the database. Reading a
        # schedule or a setting is the first of those, so that is no GET either.
        self._posts = {
            "/api/command": self._command,
            "/api/schedule": self._schedule,
            "/api/settings": self._settings,
            "/api/floorplan": self._floorplan,
            "/api/track": self._track,
            "/api/name": self._rename,
            "/api/map_name": self._rename_map,
            "/api/map_delete": self._delete_map,
            "/api/delete": self._delete,
        }
        self._listener: asyncio.Server | None = None
        self._connections: set[asyncio.Task] = set()
        # The maps a robot is being asked to keep as a floor plan, by robot and id, once for each time it is.
        self._making: list[tuple[RobotId, int]] = []

    @property
    def port(self) -> int:
        return self._listener.sockets[0].getsockname()[1]

    async def start(self) -> None:
        host, port = self._config.web_host, self._config.web_port
        try:
            listener = socket.create_server((host, port))
        except OSError as exc:
            raise WebError(f"cannot serve the web UI on {host}:{port}: {exc.strerror or exc}") from exc
        self._listener = await asyncio.start_server(self._handle, sock=listener, limit=_MAX_HEAD)
        log.info("web UI on http://%s:%d, open to anyone who can reach it", host, self.port)

    async def stop(self) -> None:
        if self._listener is None:
            return
        self._listener.close()
        for task in self._connections:
            task.cancel()
        await asyncio.gather(*self._connections, return_exceptions=True)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        self._connections.add(task)
        try:
            # Not under a timeout as a whole: a command waits for its robot, which has a limit of its own.
            peer = writer.get_extra_info("peername")
            answer = await self._respond(reader, peer[0] if peer else "?")
            async with asyncio.timeout(_TIMEOUT):
                writer.write(answer)
                writer.close()  # once what was just written has gone out
                await writer.wait_closed()
        except (TimeoutError, OSError):
            pass  # a browser that stalls or goes away is nothing to report
        finally:
            self._connections.discard(task)
            # Not a connection closing with nothing left to send, which ends by itself. Where the last of an answer
            # went out after close(), asyncio has ended it already, and in a way that makes abort fail.
            if not writer.transport.is_closing() or writer.transport.get_write_buffer_size():
                writer.transport.abort()

    async def _respond(self, reader: asyncio.StreamReader, client: str) -> bytes:
        """Read one request and return the whole response to it."""
        try:
            async with asyncio.timeout(_TIMEOUT):
                head = await reader.readuntil(b"\r\n\r\n")
        except asyncio.IncompleteReadError:
            return b""  # closed without asking, as a browser does with a connection it opened in advance
        except asyncio.LimitOverrunError:
            head, answer, took = b"", _refusal(431), 0.0
        else:
            started = time.monotonic()
            answer = await self._answer(head)
            took = time.monotonic() - started
        if log.isEnabledFor(logging.DEBUG):
            # The request line as given, quoted since anyone may send anything, and the status that _response wrote.
            line = head.split(b"\r\n", 1)[0].decode("latin-1")
            log.debug("web UI: %s %r: %s in %.0f ms", client, line, answer[9:12].decode(), took * 1000)
        return answer

    async def _answer(self, head: bytes) -> bytes:
        """The whole response to a request of this head."""
        try:
            method, target, version = head.split(b"\r\n", 1)[0].decode("ascii").split(" ")
        except ValueError:  # not three parts, or not ASCII
            return _refusal(400)
        if not version.startswith("HTTP/1.") or not target.startswith("/"):
            return _refusal(400)
        path, _, query = target.partition("?")
        try:
            if path in self._posts:
                if method != "POST":
                    return _refusal(405, "Allow: POST\r\n")
                # The UI has no login, so this is all that keeps another site, open in the
                # same browser, from commanding, naming or deleting a robot through it.
                if not _own_page(head):
                    return _response(403, _JSON, _json({"error": "a command is taken only from this server's own page"}))
                status, kind, body = await self._posts[path](query)
            elif method not in ("GET", "HEAD"):
                return _refusal(405, "Allow: GET, HEAD\r\n")
            else:
                status, kind, body = self._route(path, query)
        except StoreError as exc:
            log.error("web UI: %s", exc)
            status, kind, body = 503, _JSON, _json({"error": str(exc)})
        return _response(status, kind, body, bodiless=method == "HEAD")

    def _route(self, path: str, query: str) -> tuple[int, str, bytes]:
        if path in self._pages:
            return 200, *self._pages[path]
        if path == "/api/setup":
            # What "Bind a robot" needs to point a robot at this server: the address
            # to write into its hosts file, and the CA it must trust. Both are
            # public; the CA private key beside the cert is never read here.
            return 200, _JSON, _json({"address": self._config.public_address, "ca": self._ca()})
        if path == "/api/robots":
            robots = [self._robot(row) for row in self._store.robots()]
            answer = {"now": now(), "version": self._version, "home_assistant": self._home_assistant(), "robots": robots}
            return 200, _JSON, _json(answer)
        if path == "/api/robot":
            asked = parse_qs(query)
            limits = {}
            for name, given, most in (("events", _EVENTS, _MAX_EVENTS), ("maps", _MAPS, _MAX_MAPS)):
                limits[name] = _number(asked, name, most, given)
                if limits[name] is None:
                    return 400, _JSON, _json({"error": f"{name} must be a number from 1 to {most}"})
            robot = _named(asked)
            row = self._store.robot(robot)
            if row is None:
                return 404, _JSON, _json({"error": "no such robot in the database"})
            # One more of each than was asked for tells whether there are older ones.
            events = self._store.events(robot, limits["events"] + 1)
            maps = self._store.maps(robot, limits["maps"] + 1)
            listed, older = maps[: limits["maps"]], len(maps) > limits["maps"]
            answer = {
                "now": now(),
                "version": self._version,
                "home_assistant": self._home_assistant(),
                "robot": self._robot(row),
                "events": events[: limits["events"]],
                "more": len(events) > limits["events"],
                "maps": listed,
                "more_maps": older,
                "floorplans": self._store.floorplans(robot),
                # The page shows a floor plan as the map it was made of, so such a map comes with the
                # robot however old it is: here if it is older than the maps that were asked for.
                "floorplan_maps": self._store.floorplan_maps(robot, listed[-1]["id"]) if older else [],
                "tracks": self._store.tracks(robot),
                # The event of an upload names its map by what the robot knows it by, and the map may be one of any age.
                "map_names": self._store.map_names(robot),
            }
            return 200, _JSON, _json(answer)
        if path == "/api/map":
            # A map is named by its number and its robot, as the robot's page lists it.
            asked = parse_qs(query)
            number = _number(asked, "id", _MAX_ID)
            row = None if number is None else self._store.map(_named(asked), number)
            if row is None:
                return 404, _JSON, _json({"error": "no such map in the database"})
            return 200, _JSON, _json({"map": row})
        return 404, _TEXT, b"Not Found\n"

    async def _command(self, query: str) -> tuple[int, str, bytes]:
        """Send a robot the command the query names, and answer with what the robot said or why it said nothing."""
        asked = parse_qs(query)
        try:
            # A start may name the run it is to clean, as JSON in the query as an event of a schedule is, and
            # checked whole before anything is sent: a robot may drop a body it cannot read without a word.
            ability, params = command(*(asked.get(key, [""])[0] for key in ("command", "run")))
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        # Whether the robot's last state said it would accept the command is not
        # looked at: that state may be out of date, and the robot answers for itself.
        # Of ``find_me`` it says nothing at all.
        return await self._call(_named(asked), ability, params)

    async def _schedule(self, query: str) -> tuple[int, str, bytes]:
        """Ask a robot for its schedule or for a change to it, as the query says, and answer as for a command."""
        asked = parse_qs(query)
        try:
            # The event comes as JSON in the query, so that here too no request body is read.
            # It is checked whole before anything is sent: a robot may drop a body it cannot read without a word.
            ability, params = scheduling(*(asked.get(key, [""])[0] for key in ("action", "id", "event")))
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        return await self._call(_named(asked), ability, params)

    async def _settings(self, query: str) -> tuple[int, str, bytes]:
        """Ask a robot for one of its settings or for a change to one, as the query says, and answer as for a command."""
        asked = parse_qs(query)
        try:
            # As an event of a schedule: the value comes as JSON in the query, and is checked whole before anything is sent.
            ability, params = settings(*(asked.get(key, [""])[0] for key in ("action", "value")))
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        return await self._call(_named(asked), ability, params)

    async def _floorplan(self, query: str) -> tuple[int, str, bytes]:
        """Have a robot keep a map it uploaded as a floor plan, or drop a floor plan, as the query says, and answer as for a command."""
        asked = parse_qs(query)
        robot = _named(asked)
        action, rank_uuid, old = (asked.get(key, [""])[0] for key in ("action", "rank_uuid", "old_rank_uuid"))
        number, uploaded = None, None
        if action in ("promote", "update"):
            # A floor plan is made of a map in the database, which is named as ``/api/map`` has it named.
            number = _number(asked, "map", _MAX_ID)
            row = None if number is None else self._store.map(robot, number)
            if row is None:
                return 404, _JSON, _json({"error": "no such map in the database"})
            uploaded = row["map_json"]
        try:
            # The map is checked whole, as an event of a schedule is, before anything is sent.
            ability, params = floorplan(action, rank_uuid, old, uploaded)
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        # A robot cannot be asked which floor plans it has, so what it accepts here is all the server knows of them.
        if action == "demote":
            noted = partial(self._store.delete_floorplan, robot, params["rank_uuid"])
        else:
            noted = partial(self._store.save_floorplan, robot, params["rank_uuid"], number, params["old_rank_uuid"])
        if number is None:
            return await self._call(robot, ability, params, noted)
        # The map is not deleted until the robot has answered, so that the floor plan is noted of the map it was
        # sent, and not of none, or of a later one that was given its id.
        self._making.append((robot, number))
        try:
            return await self._call(robot, ability, params, noted)
        finally:
            self._making.remove((robot, number))

    async def _track(self, query: str) -> tuple[int, str, bytes]:
        """Have a robot keep a zone of a floor plan or its no-go lines, or drop either, as the query says, and answer as for a command."""
        asked = parse_qs(query)
        robot = _named(asked)
        action, rank_uuid, track_uuid = (asked.get(key, [""])[0] for key in ("action", "rank_uuid", "track_uuid"))
        uploaded = None
        if action in ("zone", "nogo"):
            # A track is drawn on the map its floor plan was made of, so the floor plan has to be one the
            # server had the robot keep, and the map one the database still has.
            plan = next((row for row in self._store.floorplans(robot) if row["rank_uuid"] == rank_uuid), None)
            row = None if plan is None else self._store.map(robot, plan["map_id"])
            if row is None:
                return 404, _JSON, _json({"error": "no such floor plan in the database"})
            uploaded = row["map_json"]
            kind = "cleaning" if action == "zone" else "no-go"
            tracks = self._store.tracks(robot)
            known = [each["track_uuid"] for each in tracks if each["rank_uuid"] == rank_uuid and each["type"] == kind]
            if action == "nogo":
                # A floor plan has one track of no-go lines, which a change replaces.
                track_uuid = known[0] if known else str(uuid.uuid4())
            elif not track_uuid:
                # Each zone the page shows has a colour of its own, of which there are as many as a floor plan may have zones.
                if len(known) >= ZONES_MAX:
                    return 400, _JSON, _json({"error": f"the floor plan has {ZONES_MAX} zones, the most it may have"})
                track_uuid = str(uuid.uuid4())
            elif track_uuid not in known:
                return 404, _JSON, _json({"error": "no such zone of that floor plan in the database"})
        try:
            # The zone or the lines come as JSON in the query, as an event of a schedule does, and are checked whole before anything is sent.
            given = asked.get("zone" if action == "zone" else "lines", [""])[0]
            ability, params, kept = track(action, rank_uuid, track_uuid, given, uploaded)
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        # As with a floor plan, what the robot accepts here is all the server knows of the tracks it has.
        if kept is None:
            noted = partial(self._store.delete_tracks, robot, params["tracks"])
        else:
            noted = partial(self._store.save_track, robot, rank_uuid, track_uuid, *kept)
        return await self._call(robot, ability, params, noted)

    async def _rename(self, query: str) -> tuple[int, str, bytes]:
        """Give a robot the name in the query, or take away the one it has when the query has none."""
        asked = parse_qs(query)
        try:
            name = _name(asked)
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        robot = _named(asked)
        # A name is the server's own, so the robot need not be connected. It has to be one
        # the UI shows, though: a name for any other would be a row that nothing reads.
        if self._store.robot(robot) is None:
            return 404, _JSON, _json({"error": "no such robot in the database"})
        if not self._store.save_name(robot, name):
            return 503, _JSON, _json({"error": "the name could not be saved to the database"})
        log.info("[%s] %s", robot, "goes by its serial again" if name is None else f"named {name!r}")
        return 200, _JSON, _json({"name": name})

    async def _rename_map(self, query: str) -> tuple[int, str, bytes]:
        """Give a robot's map the name in the query, or take away the one it has when the query has none."""
        asked = parse_qs(query)
        try:
            name = _name(asked)
        except ValueError as exc:
            return 400, _JSON, _json({"error": str(exc)})
        robot = _named(asked)
        # The server's own, as a robot's name is, and of a map in the database, which is named as ``/api/map`` has it named.
        number = _number(asked, "id", _MAX_ID)
        if number is None or self._store.map(robot, number) is None:
            return 404, _JSON, _json({"error": "no such map in the database"})
        if not self._store.save_map_name(robot, number, name):
            return 503, _JSON, _json({"error": "the name could not be saved to the database"})
        log.info("[%s] map %d %s", robot, number, "goes by its start time again" if name is None else f"named {name!r}")
        return 200, _JSON, _json({"name": name})

    async def _delete_map(self, query: str) -> tuple[int, str, bytes]:
        """Delete the robot's map that the query names, with its name."""
        asked = parse_qs(query)
        robot = _named(asked)
        # Of a map in the database, which is named as ``/api/map`` has it named. No ability has a robot delete
        # a map it uploaded, so the robot is sent nothing and need not be connected.
        number = _number(asked, "id", _MAX_ID)
        if number is None or self._store.map(robot, number) is None:
            return 404, _JSON, _json({"error": "no such map in the database"})
        # A floor plan is shown as the map it was made of, and its zones and no-go lines are drawn on that map.
        if any(plan["map_id"] == number for plan in self._store.floorplans(robot)):
            return 409, _JSON, _json({"error": "a floor plan was made of the map: demote it first"})
        if (robot, number) in self._making:
            return 409, _JSON, _json({"error": "the robot is being asked to keep the map as a floor plan"})
        if not self._store.delete_map(robot, number):
            return 503, _JSON, _json({"error": "the map could not be deleted from the database"})
        log.info("[%s] map %d deleted", robot, number)
        return 200, _JSON, _json({})

    async def _delete(self, query: str) -> tuple[int, str, bytes]:
        """Delete the robot the query names: all that the database holds of it, its key, and the session it has."""
        robot = _named(parse_qs(query))
        # As for a name, only a robot the UI shows: a key is not taken from one that nobody can see there.
        if self._store.robot(robot) is None:
            return 404, _JSON, _json({"error": "no such robot in the database"})
        try:
            deleted = await self._delete_robot(robot)
        except OSError as exc:  # its key file is still there, and so is everything else of it
            log.error("[%s] not deleted: its key could not be removed: %s", robot, describe(exc))
            return 503, _JSON, _json({"error": f"the robot's key could not be deleted: {exc.strerror or exc}"})
        if not deleted:
            return 503, _JSON, _json({"error": "the robot could not be deleted from the database"})
        log.info("[%s] deleted", robot)
        return 200, _JSON, _json({})

    async def _call(
        self, robot: RobotId, ability: str, params: dict, noted: Callable[[], bool] | None = None
    ) -> tuple[int, str, bytes]:
        """Invoke an ability on a robot's live session, and answer with what the robot said or why it said nothing.

        ``noted`` writes to the database what the robot has done once it accepts, and says whether that was written.
        """
        session = self._sessions.get(robot)
        if session is None:
            return 409, _JSON, _json({"error": "the robot is not connected"})
        sent = now()
        try:
            answer = await session.call(ability, params, timeout=_COMMAND_TIMEOUT, origin="the web UI")
        except TimeoutError:
            return 504, _JSON, _json({"error": f"the robot did not answer within {_COMMAND_TIMEOUT:g} s"})
        except OSError as exc:  # the session ended first
            return 502, _JSON, _json({"error": f"no answer from the robot: {describe(exc)}"})
        # The spec gives each ability that is noted one code for success, and this is it.
        if noted is not None and answer.get("code") == 200 and not noted():
            return 503, _JSON, _json({"error": "the robot accepted it, but that could not be saved to the database"})
        try:
            # The robot's code is given as it is, whatever it is: what the status says is that the robot answered.
            # When the command was sent is for the page, which waits for a state that arrived after it.
            told = {"ability": ability, "sent": sent, "code": answer.get("code"), "body": answer.get("body")}
            return 200, _JSON, _json(told)
        except ValueError:  # Python reads NaN and Infinity out of a frame, and JSON has neither
            return 502, _JSON, _json({"error": "the robot's answer holds a number that JSON cannot carry"})

    def _ca(self) -> str | None:
        """The CA certificate robots must trust, as PEM text, or ``None`` when there is none to give.

        It is ``ca.crt`` beside the server certificate, as ``certs.generate``
        writes it. Read afresh each time, so a certificate regenerated while the
        server runs is picked up, and only the certificate: never ``ca.key``.
        """
        try:
            return self._config.cert.with_name("ca.crt").read_text()
        except OSError:
            return None

    def _home_assistant(self) -> dict[str, object] | None:
        """Whether the server is connected to Home Assistant's MQTT broker, which the page shows at the top, or ``None`` where it is set to have no broker."""
        return None if self._mqtt is None else self._mqtt.status()

    def _robot(self, row: dict[str, object]) -> dict[str, object]:
        """A robot from the store as the API gives it: with its live session, or ``None`` when it has none."""
        session = self._sessions.get(RobotId(row["vendor"], row["serial"]))
        return {
            **{name: _finite(value) for name, value in row.items()},
            "session": session and {"address": session.ip, "firmware": session.firmware, "since": session.since},
        }
