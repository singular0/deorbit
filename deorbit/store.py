"""SQLite database of what the server remembers about each robot: its state, its events, its maps and their names, its floor plans with their zones and no-go lines, and its name."""

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .auth import RobotId

log = logging.getLogger(__name__)

# How long a write waits for another process that has the file locked. Writes
# run inline in the event loop, so this is also the longest one can stall it.
_BUSY_TIMEOUT = 1.0

# The fields of a state's ``autonomy_states``. A robot on firmware 1.7.0 sent
# these twelve while it was cleaning, and an empty object while idle.
# ``started_on_base`` is true or false. Each of the others is when the robot
# reached that step of its run, in seconds since 1970 by its own clock, or -1
# for a step it has not reached.
_AUTONOMY_STATES = (
    "started_on_base",
    "active_cleaning_after_suspended",
    "active_cleaning_session",
    "cleaning_start",
    "docking",
    "docking_for_suspended",
    "docking_successful",
    "docking_successful_suspended",
    "docking_verify_base",
    "suspended_charging_start",
    "undocking",
    "undocking_after_suspended",
)

# What ``robots`` and ``robot`` read out of a state: the name each value is
# given, and its path in the body of a ``peer.state``. The spec names only the
# top-level fields; the rest are what a robot on firmware 1.7.0 was seen to
# send. Nothing here is in the file, so a field is added by adding its line.
_STATE_FIELDS = (
    ("state", "$.state"),
    ("action", "$.action"),
    ("errors", "$.errors"),
    ("can_start", "$.available_commands.start"),
    ("can_cancel", "$.available_commands.cancel"),
    ("can_pause", "$.available_commands.pause"),
    ("can_resume", "$.available_commands.resume"),
    ("can_return_to_base", "$.available_commands.return_to_base"),
    ("is_charging", "$.details.is_charging"),
    ("is_docked", "$.details.is_docked"),
    ("charge", "$.details.charge"),
    ("base_type", "$.details.base_type"),
    ("is_quickboost", "$.details.is_quickboost"),
    ("quickboost_estimate", "$.details.quickboost_estimate"),
    ("base_error", "$.cleaning_center.base_error"),
    ("bag_status", "$.cleaning_center.bag_status"),
    ("is_extracting", "$.cleaning_center.is_extracting"),
    ("autonomy_states", "$.autonomy_states"),  # the whole object, whatever fields it has
    *((f"autonomy_{name}", f"$.autonomy_states.{name}") for name in _AUTONOMY_STATES),
)

# A robot's row as it is read: its own columns and the name it was given, then
# each state field as ``json_extract`` gives it. That is true and false as 1
# and 0, an object or an array as JSON, anything else as it is, and NULL for a
# field the state lacks. The names and paths come from this module, never from
# the wire.
_ROBOT = "vendor, serial, name, heartbeat_at, state_at, " + ", ".join(
    f"json_extract(state_json, '{path}') AS {name}" for name, path in _STATE_FIELDS
)

# Where that is read from: a robot's row, beside its name if it was given one.
_ROBOTS = "robots LEFT JOIN names USING (vendor, serial)"

# Every table. Each names the robot a row is of by its vendor and serial, which
# is how ``delete`` finds all there is of one.
_TABLES = ("robots", "events", "maps", "names", "map_names", "floorplans", "tracks")

# A map as a list of maps gives it: its columns, with everything in the body
# but the two binaries, and the name it was given. The binaries are most of a
# map, and only its picture needs them.
_MAP = (
    "id, at, vendor, serial, json_remove(map_json, '$.map.rank_binary', '$.map.real_binary') AS map_json, "
    "(SELECT name FROM map_names AS given "
    "WHERE given.vendor = maps.vendor AND given.serial = maps.serial AND given.map_id = maps.id) AS name"
)

# What a map is known by, as an index and the query that goes by it both have to write it.
_RANK_UUID = "json_extract(map_json, '$.rank_uuid')"

_SCHEMA = (
    # A state is kept whole, as the JSON object the robot sent. SQLite has no
    # type for JSON, so the check is what makes the column one: a text its JSON
    # functions could not read back is refused when it is written, where it
    # costs one state, not when it is read, where it would cost every reader.
    """
CREATE TABLE IF NOT EXISTS robots (
    vendor       TEXT NOT NULL,
    serial       TEXT NOT NULL,  -- the board serial; with vendor, the RobotId
    heartbeat_at TEXT,           -- when the last heartbeat frame arrived
    state_at     TEXT,           -- when the last peer.state arrived
    state_json   TEXT,           -- the body of that peer.state
    PRIMARY KEY (vendor, serial),
    CONSTRAINT state_json_is_json CHECK (json_valid(state_json))
)
""",
    # The event log: a row is added for each thing a robot did, and never changed.
    """
CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY,  -- counts up, so it orders events of the same millisecond
    at        TEXT NOT NULL,        -- when the event was recorded
    vendor    TEXT NOT NULL,
    serial    TEXT NOT NULL,
    kind      TEXT NOT NULL,        -- login, disconnect, or the type of a message the robot sent: request or event
    service   TEXT,                 -- the service that message was for
    body_json TEXT,                 -- the body of that message; for a login or a disconnect, what the server noted
    CONSTRAINT body_json_is_json CHECK (json_valid(body_json))
)
""",
    # One robot's events are read without going through every other robot's.
    "CREATE INDEX IF NOT EXISTS events_by_robot ON events (vendor, serial)",
    # A map is kept the way a state is, whole: the body of a maps.create with
    # its two binaries, as the Base64 text they came as. Unlike a state it
    # replaces nothing, so each one a robot uploads is a row.
    """
CREATE TABLE IF NOT EXISTS maps (
    id       INTEGER PRIMARY KEY,  -- counts up: the order the maps arrived in
    at       TEXT NOT NULL,        -- when the maps.create arrived
    vendor   TEXT NOT NULL,
    serial   TEXT NOT NULL,
    map_json TEXT NOT NULL,        -- the body of that maps.create
    CONSTRAINT map_json_is_json CHECK (json_valid(map_json))
)
""",
    # As for the events: one robot's maps are listed without going through the others'.
    "CREATE INDEX IF NOT EXISTS maps_by_robot ON maps (vendor, serial)",
    # And one of them is found by its rank_uuid without reading every map whole.
    f"CREATE INDEX IF NOT EXISTS maps_by_rank_uuid ON maps (vendor, serial, {_RANK_UUID})",
    # What a robot is called is nothing it sent, so it is not in its row: a
    # robot that was given a name has a row here, and one that goes by its
    # serial has none. As a table, it is also added to a file from before
    # robots had names, where a column would have meant a new file.
    """
CREATE TABLE IF NOT EXISTS names (
    vendor TEXT NOT NULL,
    serial TEXT NOT NULL,
    name   TEXT NOT NULL,  -- what the web UI calls the robot
    PRIMARY KEY (vendor, serial)
)
""",
    # The same for a map: one that was given a name has a row here, and one
    # that goes by when its run began has none.
    """
CREATE TABLE IF NOT EXISTS map_names (
    vendor TEXT NOT NULL,
    serial TEXT NOT NULL,
    map_id INTEGER NOT NULL,  -- the map, by its id in maps
    name   TEXT NOT NULL,     -- what the web UI calls the map
    PRIMARY KEY (vendor, serial, map_id)
)
""",
    # A floor plan is a map that the robot keeps, and the robot is what keeps
    # it: no message of the spec has a robot say which it has. So a row is what
    # the server remembers of having had the robot make one, and of which map.
    # The map stays where it is, in its own table.
    """
CREATE TABLE IF NOT EXISTS floorplans (
    vendor    TEXT NOT NULL,
    serial    TEXT NOT NULL,
    rank_uuid TEXT NOT NULL,     -- what the robot knows the floor plan by
    map_id    INTEGER NOT NULL,  -- the map it was made of, by its id in maps
    at        TEXT NOT NULL,     -- when the robot accepted it
    PRIMARY KEY (vendor, serial, rank_uuid)
)
""",
    # A zone of a floor plan, or its no-go lines, is a track that the robot
    # keeps with it, and no message of the spec has a robot say which it has
    # either. So a row is what the server remembers of having had the robot
    # keep one, and of what was drawn for it, which the robot was sent only as
    # a picture.
    """
CREATE TABLE IF NOT EXISTS tracks (
    vendor     TEXT NOT NULL,
    serial     TEXT NOT NULL,
    track_uuid TEXT NOT NULL,  -- what the robot knows the track by
    rank_uuid  TEXT NOT NULL,  -- the floor plan it is of
    type       TEXT NOT NULL,  -- cleaning, which is a zone, or no-go
    name       TEXT,           -- a zone's name; NULL for no-go lines
    mode       TEXT,           -- a zone's cleaning mode; NULL for no-go lines
    shape_json TEXT NOT NULL,  -- what was drawn, in cells of the floor plan's map: a zone's rectangle, or the lines
    at         TEXT NOT NULL,  -- when the robot accepted it
    PRIMARY KEY (vendor, serial, track_uuid),
    CONSTRAINT shape_json_is_json CHECK (json_valid(shape_json))
)
""",
)


class StoreError(Exception):
    """The database cannot be opened, or cannot be read."""


def now() -> str:
    """UTC as ISO 8601 text, which sorts by time and which SQLite's date functions read."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: object) -> str:
    # Not escaped to ASCII: text that UTF-8 cannot carry then fails to be
    # written, where escaped it would be stored and fail whoever reads it.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class Store:
    def __init__(self, path: Path) -> None:
        db = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Autocommit: every write is a single statement, but for ``delete`` and
            # those that go through ``_change``, which begin a transaction themselves.
            db = sqlite3.connect(path, timeout=_BUSY_TIMEOUT, isolation_level=None)
            # What is deleted is written over with zeros, so a robot that was
            # deleted is gone from the file and not only from its tables.
            db.execute("PRAGMA secure_delete = ON")
            for statement in _SCHEMA:
                db.execute(statement)
        except (OSError, sqlite3.Error) as exc:
            if db is not None:
                db.close()
            raise StoreError(f"cannot open the database {path}: {exc}") from exc
        self._db = db

    def close(self) -> None:
        self._db.close()

    def save_state(self, robot: RobotId, state: dict) -> None:
        """Replace the robot's stored state with the body of the ``peer.state`` it just sent."""
        self._save(robot, {"state_at": now(), "state_json": _json(state)})

    def save_heartbeat(self, robot: RobotId) -> None:
        """Record that a heartbeat frame from the robot arrived just now."""
        self._save(robot, {"heartbeat_at": now()})

    def add_event(self, robot: RobotId, kind: str, service: str | None = None, body: object = None) -> None:
        """Add a row to the event log: a ``login``, a ``disconnect``, or a message of that ``kind`` for ``service``."""
        self._write(
            robot,
            "INSERT INTO events (at, vendor, serial, kind, service, body_json) VALUES (?, ?, ?, ?, ?, ?)",
            (now(), robot.vendor, robot.serial, kind, service, None if body is None else _json(body)),
        )

    def save_map(self, robot: RobotId, body: dict) -> bool:
        """Add the body of the ``maps.create`` the robot just sent, and say whether the file now holds it."""
        return self._write(
            robot,
            "INSERT INTO maps (at, vendor, serial, map_json) VALUES (?, ?, ?, ?)",
            (now(), robot.vendor, robot.serial, _json(body)),
        )

    def save_name(self, robot: RobotId, name: str | None) -> bool:
        """Give the robot a name, or with ``None`` take the one it has away, and say whether the file now has it so."""
        if name is None:
            return self._write(robot, "DELETE FROM names WHERE vendor = ? AND serial = ?", (robot.vendor, robot.serial))
        sql = (
            "INSERT INTO names (vendor, serial, name) VALUES (?, ?, ?) "
            "ON CONFLICT (vendor, serial) DO UPDATE SET name = excluded.name"
        )
        return self._write(robot, sql, (robot.vendor, robot.serial, name))

    def save_map_name(self, robot: RobotId, map_id: int, name: str | None) -> bool:
        """Give the robot's map of that ``id`` a name, or with ``None`` take the one it has away, and say whether the file now has it so."""
        where = (robot.vendor, robot.serial, map_id)
        if name is None:
            return self._write(robot, "DELETE FROM map_names WHERE vendor = ? AND serial = ? AND map_id = ?", where)
        sql = (
            "INSERT INTO map_names (vendor, serial, map_id, name) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (vendor, serial, map_id) DO UPDATE SET name = excluded.name"
        )
        return self._write(robot, sql, (*where, name))

    def save_floorplan(self, robot: RobotId, rank_uuid: str, map_id: int, replaced: str | None = None) -> bool:
        """Note that the robot keeps the map of that ``id`` as the floor plan ``rank_uuid``, in place of ``replaced`` when one is given, and say whether the file now has it so.

        Either comes without zones and no-go lines: a floor plan is promoted with
        none, and what a robot does with those of the one it replaces is not known.
        """
        where = (robot.vendor, robot.serial)
        # The old one goes and the new one comes, or neither.
        return self._change(robot, [
            *self._dropped(robot, rank_uuid),
            *(self._dropped(robot, replaced) if replaced is not None else []),
            (
                "INSERT INTO floorplans (vendor, serial, rank_uuid, map_id, at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT (vendor, serial, rank_uuid) DO UPDATE SET map_id = excluded.map_id, at = excluded.at",
                (*where, rank_uuid, map_id, now()),
            ),
        ])

    def delete_floorplan(self, robot: RobotId, rank_uuid: str) -> bool:
        """Note that the robot no longer keeps the floor plan ``rank_uuid`` and its zones and no-go lines, and say whether the file now has it so, as it does of one it never held."""
        return self._change(robot, self._dropped(robot, rank_uuid))

    def save_track(
        self, robot: RobotId, rank_uuid: str, track_uuid: str, kind: str, name: str | None, mode: str | None, shape: object
    ) -> bool:
        """Note that the robot keeps the track ``track_uuid`` of the floor plan ``rank_uuid``: a zone, of the ``kind`` cleaning, or no-go lines, as ``shape`` has them drawn. Say whether the file now has it so."""
        sql = (
            "INSERT INTO tracks (vendor, serial, track_uuid, rank_uuid, type, name, mode, shape_json, at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (vendor, serial, track_uuid) DO UPDATE SET "
            "rank_uuid = excluded.rank_uuid, type = excluded.type, name = excluded.name, mode = excluded.mode, "
            "shape_json = excluded.shape_json, at = excluded.at"
        )
        values = (robot.vendor, robot.serial, track_uuid, rank_uuid, kind, name, mode, _json(shape), now())
        return self._write(robot, sql, values)

    def delete_tracks(self, robot: RobotId, track_uuids: list[str]) -> bool:
        """Note that the robot no longer keeps these tracks, and say whether the file now has it so, as it does of one it never held."""
        sql = f"DELETE FROM tracks WHERE vendor = ? AND serial = ? AND track_uuid IN ({', '.join('?' * len(track_uuids))})"
        return self._write(robot, sql, (robot.vendor, robot.serial, *track_uuids))

    def delete(self, robot: RobotId) -> bool:
        """Delete the robot's rows from every table, all of them or none, and say whether they are gone."""
        try:
            with self._db:  # commits the transaction begun in it, or rolls it back
                self._db.execute("BEGIN IMMEDIATE")
                for table in _TABLES:
                    self._db.execute(f"DELETE FROM {table} WHERE vendor = ? AND serial = ?", (robot.vendor, robot.serial))
        except sqlite3.Error as exc:
            log.error("[%s] not deleted from the database: %s", robot, exc)
            return False
        return True

    def robots(self) -> list[dict[str, object]]:
        """Every robot with its name and the fields of its state, ordered by vendor and serial, without the ``state_json`` that ``robot`` gives."""
        return self._select(f"SELECT {_ROBOT} FROM {_ROBOTS} ORDER BY vendor, serial")

    def robot(self, robot: RobotId) -> dict[str, object] | None:
        """The robot with its name, the fields of its state and the whole of it, or ``None`` if it has never sent a state or a heartbeat."""
        sql = f"SELECT {_ROBOT}, state_json FROM {_ROBOTS} WHERE vendor = ? AND serial = ?"
        rows = self._select(sql, (robot.vendor, robot.serial))
        return rows[0] if rows else None

    def events(self, robot: RobotId, limit: int) -> list[dict[str, object]]:
        """The robot's last ``limit`` events, newest first."""
        sql = "SELECT * FROM events WHERE vendor = ? AND serial = ? ORDER BY id DESC LIMIT ?"
        return self._select(sql, (robot.vendor, robot.serial, limit))

    def maps(self, robot: RobotId, limit: int) -> list[dict[str, object]]:
        """The robot's last ``limit`` maps, newest first, each without its two binaries and with its name."""
        sql = f"SELECT {_MAP} FROM maps WHERE vendor = ? AND serial = ? ORDER BY id DESC LIMIT ?"
        return self._select(sql, (robot.vendor, robot.serial, limit))

    def floorplan_maps(self, robot: RobotId, before: int) -> list[dict[str, object]]:
        """Those of the robot's maps older than the one of the ``id`` ``before`` that a floor plan of its was made of, newest first, each as ``maps`` gives one."""
        where = (robot.vendor, robot.serial)
        sql = (
            f"SELECT {_MAP} FROM maps WHERE vendor = ? AND serial = ? AND id < ? "
            "AND id IN (SELECT map_id FROM floorplans WHERE vendor = ? AND serial = ?) ORDER BY id DESC"
        )
        return self._select(sql, (*where, before, *where))

    def has_map(self, robot: RobotId, rank_uuid: str) -> bool:
        """Whether the robot has a map of this ``rank_uuid`` in the file."""
        sql = f"SELECT 1 FROM maps WHERE vendor = ? AND serial = ? AND {_RANK_UUID} = ? LIMIT 1"
        return bool(self._select(sql, (robot.vendor, robot.serial, rank_uuid)))

    def map(self, robot: RobotId, map_id: int) -> dict[str, object] | None:
        """The robot's map of that ``id``, whole, or ``None`` if it has no such map."""
        sql = "SELECT * FROM maps WHERE id = ? AND vendor = ? AND serial = ?"
        rows = self._select(sql, (map_id, robot.vendor, robot.serial))
        return rows[0] if rows else None

    def map_names(self, robot: RobotId) -> list[dict[str, object]]:
        """The ``rank_uuid`` and the name of each of the robot's maps that was given one, the oldest map first."""
        # Each of these maps is read whole for its rank_uuid, as few as they are.
        sql = (
            f"SELECT {_RANK_UUID} AS rank_uuid, name FROM map_names JOIN maps ON maps.id = map_names.map_id "
            "AND maps.vendor = map_names.vendor AND maps.serial = map_names.serial "
            "WHERE map_names.vendor = ? AND map_names.serial = ? ORDER BY map_names.map_id"
        )
        return self._select(sql, (robot.vendor, robot.serial))

    def floorplans(self, robot: RobotId) -> list[dict[str, object]]:
        """The floor plans the robot is known to keep, the one it accepted last first."""
        sql = "SELECT * FROM floorplans WHERE vendor = ? AND serial = ? ORDER BY at DESC, rank_uuid"
        return self._select(sql, (robot.vendor, robot.serial))

    def tracks(self, robot: RobotId) -> list[dict[str, object]]:
        """The zones and no-go lines the robot is known to keep, by floor plan, the zones first, in the order they were first noted.

        A track that is noted again keeps its row, and so its rowid and its place, which is what the page gives its colour by.
        """
        sql = "SELECT * FROM tracks WHERE vendor = ? AND serial = ? ORDER BY rank_uuid, type, rowid"
        return self._select(sql, (robot.vendor, robot.serial))

    @staticmethod
    def _dropped(robot: RobotId, rank_uuid: str) -> list[tuple[str, tuple[object, ...]]]:
        """What deletes the floor plan ``rank_uuid`` of the robot's, and its tracks with it."""
        return [
            (f"DELETE FROM {table} WHERE vendor = ? AND serial = ? AND rank_uuid = ?", (robot.vendor, robot.serial, rank_uuid))
            for table in ("floorplans", "tracks")
        ]

    def _change(self, robot: RobotId, statements: list[tuple[str, tuple[object, ...]]]) -> bool:
        """Run these statements in one transaction, all of them or none, and say whether they were."""
        try:
            with self._db:  # as in ``delete``: commits the transaction begun in it, or rolls it back
                self._db.execute("BEGIN IMMEDIATE")
                for sql, parameters in statements:
                    self._db.execute(sql, parameters)
        except (sqlite3.Error, UnicodeError) as exc:
            log.error("[%s] not saved to the database: %s", robot, exc)
            return False
        return True

    def _select(self, sql: str, parameters: tuple[object, ...] = ()) -> list[dict[str, object]]:
        # Unlike a failed write, a failed read is raised: without the rows the caller has nothing to show.
        try:
            cursor = self._db.execute(sql, parameters)
            names = [column[0] for column in cursor.description]
            return [dict(zip(names, row)) for row in cursor]
        except sqlite3.Error as exc:
            raise StoreError(f"cannot read the database: {exc}") from exc

    def _save(self, robot: RobotId, values: dict[str, object]) -> None:
        """Set these columns of the robot's row, adding the row if the robot is new."""
        # The column names come from this module, never from the wire.
        columns = ("vendor", "serial", *values)
        sql = (
            f"INSERT INTO robots ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))}) "
            f"ON CONFLICT (vendor, serial) DO UPDATE SET {', '.join(f'{name} = excluded.{name}' for name in values)}"
        )
        self._write(robot, sql, (robot.vendor, robot.serial, *values.values()))

    def _write(self, robot: RobotId, sql: str, parameters: tuple[object, ...]) -> bool:
        # A failed write is logged, not raised: a full disk, a locked file or a
        # body the file does not take must not cost the robot its connection.
        # What is returned is whether it was written, for a caller that has to
        # tell the robot, or whoever is naming one.
        try:
            self._db.execute(sql, parameters)
        except (sqlite3.Error, UnicodeError) as exc:
            log.error("[%s] not saved to the database: %s", robot, exc)
            return False
        return True
