"""Database tests: what the store leaves in the file, and which files it refuses."""

import contextlib
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from deorbit.auth import RobotId
from deorbit.store import _TABLES, Store, StoreError

ROBOT = RobotId("n", "board1")
OTHER = RobotId("n", "board2")

# A state in the shape a robot on firmware 1.7.0 was seen to send. The values
# are varied so that a field read from the wrong place shows.
STATE = {
    "state": "idle",
    "action": "invalid",
    "errors": None,
    "available_commands": {"start": True, "cancel": False, "pause": True, "resume": False, "return_to_base": True},
    "details": {
        "is_charging": True,
        "is_docked": False,
        "charge": 89,
        "base_type": "standard",
        "is_quickboost": True,
        "quickboost_estimate": -1,
    },
    "cleaning_center": {"base_error": None, "bag_status": "bag_ok", "is_extracting": True},
    # As sent while cleaning. An idle robot sends an empty object here.
    "autonomy_states": {
        "started_on_base": True,
        "active_cleaning_after_suspended": -1,
        "active_cleaning_session": 1791474590,
        "cleaning_start": 1791474585,
        "docking": 1791475201,
        "docking_for_suspended": 1791474802,
        "docking_successful": 1791475203,
        "docking_successful_suspended": 1791474804,
        "docking_verify_base": 1791475205,
        "suspended_charging_start": 1791474806,
        "undocking": 1791474587,
        "undocking_after_suspended": 1791475008,
    },
    "ability": "state.show",
}
# What the store reads out of that state: true and false as 1 and 0, an object as JSON.
STATE_FIELDS = {
    "state": "idle",
    "action": "invalid",
    "errors": None,
    "can_start": 1,
    "can_cancel": 0,
    "can_pause": 1,
    "can_resume": 0,
    "can_return_to_base": 1,
    "is_charging": 1,
    "is_docked": 0,
    "charge": 89,
    "base_type": "standard",
    "is_quickboost": 1,
    "quickboost_estimate": -1,
    "base_error": None,
    "bag_status": "bag_ok",
    "is_extracting": 1,
    "autonomy_states": json.dumps(STATE["autonomy_states"], separators=(",", ":")),
    "autonomy_started_on_base": 1,
    "autonomy_active_cleaning_after_suspended": -1,
    "autonomy_active_cleaning_session": 1791474590,
    "autonomy_cleaning_start": 1791474585,
    "autonomy_docking": 1791475201,
    "autonomy_docking_for_suspended": 1791474802,
    "autonomy_docking_successful": 1791475203,
    "autonomy_docking_successful_suspended": 1791474804,
    "autonomy_docking_verify_base": 1791475205,
    "autonomy_suspended_charging_start": 1791474806,
    "autonomy_undocking": 1791474587,
    "autonomy_undocking_after_suspended": 1791475008,
}
NO_FIELDS = dict.fromkeys(STATE_FIELDS)

# The body of a ``maps.create`` as section 7.3 of the specification gives it.
TIMING = {"start": "2026-10-06T12:00:00Z", "end": "2026-10-06T12:45:00Z", "charging": 0, "error": 0, "pause": 12}
MAP = {
    "version": "1.0.0",
    "rank_uuid": "414fb561-91a7-4a95-8fc7-200169d2d5af",
    "persistent_rank_uuid": None,
    "started_by": "app",
    "force_floorplan": False,
    "cleaning_complete": True,
    "is_valid_quick_boost_data": True,
    "timing": TIMING,
    "map": {"origin": {"x": -120, "y": 85}, "rank_binary": "cmFuaw==", "real_binary": "cmVhbA=="},
    "robot": {"pos": {"x": 100, "y": 200, "dir": 90.0}, "base": {"x": 20, "y": 200, "dir": 45.0}},
    "battery_consumed": 24,
    "runs": [
        {
            "timing": TIMING,
            "track_uuid": "",
            "state": "done",
            "autonomous_dock": True,
            "stats": {"area": 48.2, "pickup_count": 120},
            "settings": {"mode": "eco", "navigation_mode": "normal"},
        }
    ],
}


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "deorbit.db"

    def open(self) -> Store:
        store = Store(self.path)
        self.addCleanup(store.close)
        return store

    def rows(self) -> dict[RobotId, dict]:
        """Every robot in the file, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return {RobotId(row["vendor"], row["serial"]): dict(row) for row in db.execute("SELECT * FROM robots")}

    def logged(self) -> list[dict]:
        """Every event in the file, oldest first, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM events ORDER BY id")]

    def maps(self) -> list[dict]:
        """Every map in the file, oldest first, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM maps ORDER BY id")]

    def names(self) -> dict[RobotId, str]:
        """Every name in the file, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return {RobotId(vendor, serial): name for vendor, serial, name in db.execute("SELECT * FROM names")}

    def called(self) -> list[tuple]:
        """Every name of a map in the file, by the map, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return db.execute("SELECT vendor, serial, map_id, name FROM map_names ORDER BY map_id").fetchall()

    def plans(self) -> list[tuple]:
        """Every floor plan in the file but for when it was noted, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return db.execute("SELECT vendor, serial, rank_uuid, map_id FROM floorplans ORDER BY serial, rank_uuid").fetchall()

    def tracked(self) -> list[tuple]:
        """Every track in the file but for when it was noted, read the way another process would."""
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            sql = "SELECT vendor, serial, track_uuid, rank_uuid, type, name, mode, shape_json FROM tracks ORDER BY serial, track_uuid"
            return db.execute(sql).fetchall()

    def assertJustNow(self, stamp: str) -> None:
        self.assertRegex(stamp, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertLess(abs(datetime.now(timezone.utc) - datetime.fromisoformat(stamp)), timedelta(seconds=5))

    def test_missing_directory_is_created(self) -> None:
        self.path = self.path.parent / "not" / "there" / "yet" / "deorbit.db"
        self.open()
        self.assertEqual(self.rows(), {})

    def test_state_is_stored_whole(self) -> None:
        self.open().save_state(ROBOT, STATE)
        (row,) = self.rows().values()
        self.assertJustNow(row.pop("state_at"))
        self.assertEqual(json.loads(row.pop("state_json")), STATE)
        # The state has that one column: none of its fields has its own.
        self.assertEqual(row, {"vendor": "n", "serial": "board1", "heartbeat_at": None})

    def test_states_are_queried_in_the_file(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.save_state(OTHER, {"state": "busy", "details": {"charge": 20, "is_docked": False}})
        store.save_heartbeat(RobotId("n", "board3"))
        # As CLAUDE.md shows it done, by another program while the server runs.
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            charge = "json_extract(state_json, '$.details.charge')"
            low = db.execute(f"SELECT serial, {charge} FROM robots WHERE {charge} < 50").fetchall()
            states = db.execute("SELECT serial, json_extract(state_json, '$.state') FROM robots ORDER BY serial").fetchall()
        self.assertEqual(low, [("board2", 20)])
        self.assertEqual(states, [("board1", "idle"), ("board2", "busy"), ("board3", None)])

    def test_newer_state_replaces_the_older_one(self) -> None:
        store = self.open()
        store.save_heartbeat(ROBOT)
        store.save_state(ROBOT, STATE)
        store.save_state(ROBOT, {"state": "busy"})
        (row,) = self.rows().values()
        self.assertEqual(row["state_json"], '{"state":"busy"}')
        self.assertIsNotNone(row["heartbeat_at"])
        # A field the newer state lacks is not read from the older one.
        robot = store.robot(ROBOT)
        self.assertEqual({name: robot[name] for name in STATE_FIELDS}, {**NO_FIELDS, "state": "busy"})

    def test_fields_in_an_unforeseen_shape(self) -> None:
        state = {
            "state": "idle",
            "errors": [{"code": "dustbin_missing"}],  # an array where a robot without errors sends null
            "available_commands": None,
            "details": "unknown",  # not an object, so it has none of the fields looked for in it
            # A field nothing reads, and one that is not the number it is for other robots.
            "autonomy_states": {"mode": "caf\u00e9", "docking": {"at": 5}},
            "added_by_newer_firmware": 1,
        }
        store = self.open()
        store.save_state(ROBOT, state)
        robot = store.robot(ROBOT)
        self.assertEqual(json.loads(robot["state_json"]), state)
        self.assertEqual(json.loads(robot["errors"]), [{"code": "dustbin_missing"}])
        self.assertEqual(json.loads(robot["autonomy_states"]), {"mode": "caf\u00e9", "docking": {"at": 5}})
        self.assertEqual((robot["autonomy_docking"], robot["autonomy_undocking"]), ('{"at":5}', None))
        self.assertEqual((robot["state"], robot["can_start"], robot["charge"], robot["base_type"]), ("idle", None, None, None))

    def test_number_too_large_for_sqlite(self) -> None:
        state = {"state": "idle", "details": {"charge": 2 ** 64}}
        store = self.open()
        store.save_state(ROBOT, state)
        robot = store.robot(ROBOT)
        # Kept as sent, and read out of the state as the nearest number SQLite has.
        self.assertEqual(json.loads(robot["state_json"]), state)
        self.assertEqual((robot["state"], robot["charge"]), ("idle", float(2 ** 64)))

    def test_state_that_cannot_be_stored(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        before = self.rows()
        with self.assertLogs("deorbit", "ERROR") as logs:
            # Python reads 1e999 as infinity and would write it as a bare word, which is not JSON.
            store.save_state(ROBOT, json.loads('{"state": "busy", "details": {"charge": 1e999}}'))
            store.save_state(ROBOT, {"state": "busy", "details": {"charge": float("nan")}})
            store.save_state(ROBOT, {"state": "\ud800"})  # not text that UTF-8 can carry
            store.save_state(OTHER, {"state": "\ud800"})
        self.assertEqual(len(logs.output), 4)
        for line in logs.output[:2]:
            self.assertIn("[n/board1] not saved to the database: CHECK constraint failed: state_json_is_json", line)
        # The last good state is still the robot's, and still read; a robot is not added without one.
        self.assertEqual(self.rows(), before)
        self.assertEqual([robot["state"] for robot in store.robots()], ["idle"])

    def test_heartbeat_is_kept_for_each_robot(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        before = self.rows()[ROBOT]
        store.save_heartbeat(ROBOT)
        store.save_heartbeat(OTHER)
        rows = self.rows()
        self.assertEqual(set(rows), {ROBOT, OTHER})
        self.assertJustNow(rows[ROBOT].pop("heartbeat_at"))
        self.assertJustNow(rows[OTHER].pop("heartbeat_at"))
        # The heartbeat touched nothing else, and a robot not heard from otherwise has no state.
        self.assertEqual(rows[ROBOT], {name: value for name, value in before.items() if name != "heartbeat_at"})
        self.assertEqual(set(rows[OTHER].values()), {"n", "board2", None})

    def test_rows_outlive_the_store(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.close()
        before = self.rows()
        self.open().save_heartbeat(OTHER)
        self.assertEqual(self.rows()[ROBOT], before[ROBOT])

    def test_robots_are_read_with_the_fields_of_their_state(self) -> None:
        store = self.open()
        self.assertEqual(store.robots(), [])
        self.assertIsNone(store.robot(ROBOT))
        store.save_state(OTHER, STATE)
        store.save_heartbeat(ROBOT)
        rows = self.rows()
        whole = {robot: row.pop("state_json") for robot, row in rows.items()}
        # Ordered by serial, each with its other columns and the fields of its state, which a robot without one lacks.
        # Neither was given a name.
        board1, board2 = store.robots()
        self.assertEqual(board1, {**rows[ROBOT], "name": None, **NO_FIELDS})
        self.assertEqual(board2, {**rows[OTHER], "name": None, **STATE_FIELDS})
        # One robot is given the same way, with the whole state as well.
        self.assertEqual(store.robot(ROBOT), {**board1, "state_json": None})
        self.assertEqual(store.robot(OTHER), {**board2, "state_json": whole[OTHER]})
        self.assertEqual(json.loads(whole[OTHER]), STATE)
        self.assertIsNone(store.robot(RobotId("3", "board1")))

    def test_name_is_given_changed_and_taken_away(self) -> None:
        store = self.open()
        store.save_heartbeat(ROBOT)
        store.save_state(OTHER, STATE)
        before = self.rows()
        self.assertEqual(self.names(), {})
        self.assertTrue(store.save_name(ROBOT, "Rosie"))
        self.assertEqual(self.names(), {ROBOT: "Rosie"})
        # A robot is read with its name, and one that has none without.
        self.assertEqual([(row["serial"], row["name"]) for row in store.robots()], [("board1", "Rosie"), ("board2", None)])
        self.assertEqual((store.robot(ROBOT)["name"], store.robot(OTHER)["name"]), ("Rosie", None))
        # A new name takes the place of the old one, and two robots may have the same.
        self.assertTrue(store.save_name(ROBOT, "Caf\u00e9 \U0001f9f9"))
        self.assertTrue(store.save_name(OTHER, "Caf\u00e9 \U0001f9f9"))
        self.assertEqual(self.names(), {ROBOT: "Caf\u00e9 \U0001f9f9", OTHER: "Caf\u00e9 \U0001f9f9"})
        # The name is no part of what the robot sent, and what it sends next leaves the name be.
        self.assertEqual(self.rows(), before)
        store.save_state(ROBOT, STATE)
        store.save_heartbeat(ROBOT)
        robot = store.robot(ROBOT)
        self.assertEqual((robot["name"], robot["state"]), ("Caf\u00e9 \U0001f9f9", "idle"))
        # Without its name a robot has no row there, and one without a name has none to lose.
        for _ in range(2):
            self.assertTrue(store.save_name(ROBOT, None))
            self.assertEqual(self.names(), {OTHER: "Caf\u00e9 \U0001f9f9"})
        self.assertEqual([row["name"] for row in store.robots()], [None, "Caf\u00e9 \U0001f9f9"])

    def test_names_outlive_the_store(self) -> None:
        store = self.open()
        store.save_heartbeat(ROBOT)
        store.save_name(ROBOT, "Rosie")
        store.close()
        self.assertEqual(self.open().robot(ROBOT)["name"], "Rosie")

    def test_name_that_cannot_be_stored(self) -> None:
        store = self.open()
        store.save_heartbeat(ROBOT)
        store.save_name(ROBOT, "Rosie")
        with self.assertLogs("deorbit", "ERROR") as logs:
            self.assertFalse(store.save_name(ROBOT, "\ud800"))  # not text that UTF-8 can carry
            self.assertEqual(self.names(), {ROBOT: "Rosie"})
            with contextlib.closing(sqlite3.connect(self.path)) as db:
                db.execute("DROP TABLE names")
            self.assertFalse(store.save_name(ROBOT, "Rosie"))
            self.assertFalse(store.save_name(ROBOT, None))
        self.assertEqual(len(logs.output), 3)
        for line in logs.output[1:]:
            self.assertIn("[n/board1] not saved to the database: no such table: names", line)

    def test_file_without_a_names_table_gets_one(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.add_event(ROBOT, "login")
        store.save_map(ROBOT, MAP)
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE names")  # as in a file from before robots had names
        before = self.rows(), self.logged(), self.maps()
        store = self.open()
        # Every robot in it goes by its serial, until it is given a name.
        self.assertEqual([(row["serial"], row["name"], row["state"]) for row in store.robots()], [("board1", None, "idle")])
        self.assertTrue(store.save_name(ROBOT, "Rosie"))
        self.assertEqual(store.robot(ROBOT)["name"], "Rosie")
        self.assertEqual((self.rows(), self.logged(), self.maps()), before)

    def test_events_are_added_in_order(self) -> None:
        store = self.open()
        store.add_event(ROBOT, "login", body={"address": "10.0.0.7", "firmware": "1.7.0", "verified": True})
        store.add_event(ROBOT, "request", "robots.notify", {"message_code": "caf\u00e9", "payload": None})
        store.add_event(OTHER, "event", "robots.error_codes", ["not", "an", "object"])
        store.add_event(ROBOT, "event")  # a message that named no service and had no body
        first, second, third, fourth = self.logged()
        self.assertEqual([row["id"] for row in (first, second, third, fourth)], [1, 2, 3, 4])
        for row in (first, second, third, fourth):
            self.assertJustNow(row["at"])
        self.assertEqual((first["vendor"], first["serial"], first["kind"], first["service"]), ("n", "board1", "login", None))
        self.assertEqual(json.loads(first["body_json"]), {"address": "10.0.0.7", "firmware": "1.7.0", "verified": True})
        self.assertEqual((second["kind"], second["service"]), ("request", "robots.notify"))
        self.assertEqual(json.loads(second["body_json"]), {"message_code": "caf\u00e9", "payload": None})
        self.assertEqual((third["serial"], third["kind"], third["service"]), ("board2", "event", "robots.error_codes"))
        self.assertEqual(json.loads(third["body_json"]), ["not", "an", "object"])
        self.assertEqual((fourth["kind"], fourth["service"], fourth["body_json"]), ("event", None, None))
        # The log is beside the robots, not a part of them: an event alone does not make a robot.
        self.assertEqual(self.rows(), {})

    def test_events_of_a_robot_are_read_back_newest_first(self) -> None:
        store = self.open()
        self.assertEqual(store.events(ROBOT, 10), [])
        for n in range(5):
            store.add_event(ROBOT if n % 2 else OTHER, "request", "robots.notify", {"n": n})
        stored = self.logged()[::-1]
        self.assertEqual(store.events(OTHER, 10), [event for event in stored if event["serial"] == "board2"])
        self.assertEqual([json.loads(event["body_json"])["n"] for event in store.events(OTHER, 10)], [4, 2, 0])
        self.assertEqual([json.loads(event["body_json"])["n"] for event in store.events(OTHER, 2)], [4, 2])
        self.assertEqual([json.loads(event["body_json"])["n"] for event in store.events(ROBOT, 10)], [3, 1])
        self.assertEqual(store.events(RobotId("3", "board1"), 10), [])

    def test_event_that_cannot_be_stored(self) -> None:
        store = self.open()
        store.add_event(ROBOT, "login")
        with self.assertLogs("deorbit", "ERROR") as logs:
            store.add_event(ROBOT, "request", "\ud800")  # not text that UTF-8 can carry
            store.add_event(ROBOT, "request", "robots.notify", {"message_code": "\ud800"})
            store.add_event(ROBOT, "request", "robots.notify", {"payload": float("inf")})  # not a number JSON has
            self.assertEqual([event["kind"] for event in self.logged()], ["login"])
            with contextlib.closing(sqlite3.connect(self.path)) as db:
                db.execute("DROP TABLE events")
            store.add_event(ROBOT, "disconnect", body={"reason": "closed by robot"})
        self.assertEqual(len(logs.output), 4)
        self.assertIn("[n/board1] not saved to the database: CHECK constraint failed: body_json_is_json", logs.output[2])
        self.assertIn("[n/board1] not saved to the database: no such table: events", logs.output[3])

    def test_map_is_stored_whole(self) -> None:
        self.assertTrue(self.open().save_map(ROBOT, MAP))
        (row,) = self.maps()
        self.assertJustNow(row.pop("at"))
        # With its binaries as they came: this table is where a map is kept.
        self.assertEqual(json.loads(row.pop("map_json")), MAP)
        self.assertEqual(row, {"id": 1, "vendor": "n", "serial": "board1"})
        # A map alone does not make a robot, and it is not an event.
        self.assertEqual((self.rows(), self.logged()), ({}, []))

    def test_each_map_is_a_row(self) -> None:
        store = self.open()
        unfinished = {**MAP, "rank_uuid": "second", "cleaning_complete": False}
        # The last has the rank_uuid of the first, and is kept beside it.
        sent = [(ROBOT, MAP), (OTHER, {"added_by_newer_firmware": "caf\u00e9"}), (ROBOT, unfinished), (ROBOT, MAP)]
        for robot, body in sent:
            self.assertTrue(store.save_map(robot, body))
        stored = self.maps()
        self.assertEqual([row["id"] for row in stored], [1, 2, 3, 4])
        self.assertEqual([(RobotId(row["vendor"], row["serial"]), json.loads(row["map_json"])) for row in stored], sent)
        # As CLAUDE.md shows it done, by another program while the server runs.
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            done = "json_extract(map_json, '$.cleaning_complete')"
            binary = "json_extract(map_json, '$.map.real_binary')"
            found = db.execute(f"SELECT id, {done}, {binary} FROM maps WHERE serial = 'board1' ORDER BY id").fetchall()
        self.assertEqual(found, [(1, 1, "cmVhbA=="), (3, 0, "cmVhbA=="), (4, 1, "cmVhbA==")])

    def test_maps_of_a_robot_are_read_back_newest_first_without_their_binaries(self) -> None:
        store = self.open()
        self.assertEqual(store.maps(ROBOT, 10), [])
        unfinished = {**MAP, "rank_uuid": "second", "cleaning_complete": False}
        # A map from firmware that sends something else, and numbers that have to come back as they were sent.
        odd = {"map": "elsewhere", "added_by_newer_firmware": "caf\u00e9", "area": 0.09440000355243683, "long": 10 ** 400}
        for robot, body in ((ROBOT, MAP), (OTHER, MAP), (ROBOT, unfinished), (OTHER, odd), (ROBOT, {})):
            store.save_map(robot, body)
        stored = {row["id"]: row for row in self.maps()}
        listed = store.maps(ROBOT, 10)
        self.assertEqual([row["id"] for row in listed], [5, 3, 1])
        for row in listed:
            # A row as it is stored but for the binaries, and with those the map is the one that was sent. None was named.
            self.assertEqual({**row, "map_json": None}, {**stored[row["id"]], "map_json": None, "name": None})
        self.assertEqual(json.loads(listed[0]["map_json"]), {})
        self.assertEqual(json.loads(listed[1]["map_json"]), {**unfinished, "map": {"origin": {"x": -120, "y": 85}}})
        self.assertEqual(json.loads(listed[2]["map_json"]), {**MAP, "map": {"origin": {"x": -120, "y": 85}}})
        self.assertNotIn("cmFuaw==", listed[2]["map_json"])
        self.assertEqual([row["id"] for row in store.maps(ROBOT, 2)], [5, 3])
        self.assertEqual([json.loads(row["map_json"]) for row in store.maps(OTHER, 10)],
                         [odd, {**MAP, "map": {"origin": {"x": -120, "y": 85}}}])
        self.assertEqual(store.maps(RobotId("3", "board1"), 10), [])

    def test_one_map_is_read_back_whole(self) -> None:
        store = self.open()
        store.save_map(ROBOT, MAP)
        store.save_map(OTHER, {**MAP, "rank_uuid": "second"})
        first, second = self.maps()
        # As the row is stored, with its binaries.
        self.assertEqual(store.map(ROBOT, 1), first)
        self.assertEqual(json.loads(store.map(ROBOT, 1)["map_json"]), MAP)
        self.assertEqual(store.map(OTHER, 2), second)
        # A map is asked of its robot, and one of another robot is not found.
        self.assertIsNone(store.map(ROBOT, 2))
        self.assertIsNone(store.map(ROBOT, 3))

    def test_map_is_given_a_name_changed_and_has_it_taken_away(self) -> None:
        store = self.open()
        for robot, body in ((ROBOT, MAP), (OTHER, MAP), (ROBOT, {**MAP, "rank_uuid": "second"}), (ROBOT, {})):
            store.save_map(robot, body)
        before = self.maps()
        self.assertEqual((self.called(), store.map_names(ROBOT)), ([], []))
        self.assertTrue(store.save_map_name(ROBOT, 3, "Kitchen"))
        self.assertEqual(self.called(), [("n", "board1", 3, "Kitchen")])
        # A map is listed with its name, and one that has none without, as the map of a floor plan is.
        self.assertEqual([(row["id"], row["name"]) for row in store.maps(ROBOT, 10)], [(4, None), (3, "Kitchen"), (1, None)])
        self.assertEqual([row["name"] for row in store.maps(OTHER, 10)], [None])
        store.save_floorplan(ROBOT, "second", 3)
        self.assertEqual([(row["id"], row["name"]) for row in store.floorplan_maps(ROBOT, 4)], [(3, "Kitchen")])
        # Two maps may have one name, and each is named by what the robot knows it by as well, which a map may lack.
        self.assertTrue(store.save_map_name(ROBOT, 4, "Caf\u00e9 \U0001f9f9"))
        self.assertTrue(store.save_map_name(ROBOT, 1, "Kitchen"))
        self.assertEqual(store.map_names(ROBOT), [
            {"rank_uuid": MAP["rank_uuid"], "name": "Kitchen"},
            {"rank_uuid": "second", "name": "Kitchen"},
            {"rank_uuid": None, "name": "Caf\u00e9 \U0001f9f9"},
        ])
        self.assertEqual(store.map_names(OTHER), [])
        # A new name takes the place of the old one, and the map itself stays as it was sent.
        self.assertTrue(store.save_map_name(ROBOT, 3, "Hall"))
        self.assertEqual(store.maps(ROBOT, 10)[1]["name"], "Hall")
        self.assertEqual(self.maps(), before)
        # Without its name a map has no row there, and one without a name has none to lose.
        for _ in range(2):
            self.assertTrue(store.save_map_name(ROBOT, 3, None))
            self.assertEqual([map_id for _, _, map_id, _ in self.called()], [1, 4])
        self.assertIsNone(store.maps(ROBOT, 10)[1]["name"])
        store.close()
        self.assertEqual([row["name"] for row in self.open().maps(ROBOT, 10)], ["Caf\u00e9 \U0001f9f9", None, "Kitchen"])

    def test_map_name_that_cannot_be_stored(self) -> None:
        store = self.open()
        store.save_map(ROBOT, MAP)
        store.save_map_name(ROBOT, 1, "Kitchen")
        with self.assertLogs("deorbit", "ERROR") as logs:
            self.assertFalse(store.save_map_name(ROBOT, 1, "\ud800"))  # not text that UTF-8 can carry
            self.assertEqual(self.called(), [("n", "board1", 1, "Kitchen")])
            with contextlib.closing(sqlite3.connect(self.path)) as db:
                db.execute("DROP TABLE map_names")
            self.assertFalse(store.save_map_name(ROBOT, 1, "Kitchen"))
            self.assertFalse(store.save_map_name(ROBOT, 1, None))
        self.assertEqual(len(logs.output), 3)
        for line in logs.output[1:]:
            self.assertIn("[n/board1] not saved to the database: no such table: map_names", line)
        # A map is listed with its name, so its row alone is not enough.
        for read in (lambda: store.maps(ROBOT, 10), lambda: store.floorplan_maps(ROBOT, 2), lambda: store.map_names(ROBOT)):
            with self.assertRaisesRegex(StoreError, "^cannot read the database: no such table: map_names$"):
                read()

    def test_file_without_a_map_names_table_gets_one(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.save_map(ROBOT, MAP)
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE map_names")  # as in a file from before maps had names
        before = self.rows(), self.maps()
        store = self.open()
        # Every map in it goes by when its run began, until it is given a name.
        self.assertEqual([row["name"] for row in store.maps(ROBOT, 10)], [None])
        self.assertTrue(store.save_map_name(ROBOT, 1, "Kitchen"))
        self.assertEqual(store.maps(ROBOT, 10)[0]["name"], "Kitchen")
        self.assertEqual((self.rows(), self.maps()), before)

    def test_map_that_cannot_be_stored(self) -> None:
        store = self.open()
        store.save_map(ROBOT, MAP)
        before = self.maps()
        with self.assertLogs("deorbit", "ERROR") as logs:
            self.assertFalse(store.save_map(ROBOT, {**MAP, "battery_consumed": float("inf")}))  # not a number JSON has
            self.assertFalse(store.save_map(ROBOT, {**MAP, "rank_uuid": "\ud800"}))  # not text that UTF-8 can carry
            self.assertEqual(self.maps(), before)
            with contextlib.closing(sqlite3.connect(self.path)) as db:
                db.execute("DROP TABLE maps")
            self.assertFalse(store.save_map(ROBOT, MAP))
        self.assertEqual(len(logs.output), 3)
        self.assertIn("[n/board1] not saved to the database: CHECK constraint failed: map_json_is_json", logs.output[0])
        self.assertIn("[n/board1] not saved to the database: no such table: maps", logs.output[2])

    def test_file_without_a_maps_table_gets_one(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.add_event(ROBOT, "login")
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE maps")  # as in a file from before maps were stored
        before = self.rows(), self.logged()
        self.assertTrue(self.open().save_map(ROBOT, MAP))
        self.assertEqual((self.rows(), self.logged()), before)

    def test_file_from_before_maps_were_listed_gets_their_index(self) -> None:
        store = self.open()
        store.save_map(ROBOT, MAP)
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP INDEX maps_by_robot")
        store = self.open()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute("SELECT tbl_name FROM sqlite_master WHERE name = 'maps_by_robot'").fetchall(),
                             [("maps",)])
        self.assertEqual([row["id"] for row in store.maps(ROBOT, 10)], [1])

    def test_floor_plan_is_noted_with_the_map_it_was_made_of(self) -> None:
        store = self.open()
        self.assertEqual(store.floorplans(ROBOT), [])
        self.assertTrue(store.save_floorplan(ROBOT, "first", 3))
        self.assertTrue(store.save_floorplan(OTHER, "first", 4))
        self.assertTrue(store.save_floorplan(ROBOT, "second", 5))
        self.assertEqual(self.plans(), [("n", "board1", "first", 3), ("n", "board1", "second", 5), ("n", "board2", "first", 4)])
        # A robot's own, as the rows are stored, and the one it accepted last first.
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("UPDATE floorplans SET at = '2026-10-06T12:00:00.000Z' WHERE rank_uuid = 'second'")
            db.commit()
        newest, oldest = store.floorplans(ROBOT)
        self.assertEqual(newest, {"vendor": "n", "serial": "board1", "rank_uuid": "first", "map_id": 3, "at": newest["at"]})
        self.assertJustNow(newest["at"])
        self.assertEqual((oldest["rank_uuid"], oldest["at"]), ("second", "2026-10-06T12:00:00.000Z"))
        self.assertEqual([row["map_id"] for row in store.floorplans(OTHER)], [4])
        self.assertEqual(store.floorplans(RobotId("3", "board1")), [])
        # A floor plan alone does not make a robot, and it is neither a map nor an event.
        self.assertEqual((self.rows(), self.logged(), self.maps()), ({}, [], []))
        # One that is made again is the same floor plan, of the map and the time it was last made of.
        self.assertTrue(store.save_floorplan(ROBOT, "second", 7))
        again = {row["rank_uuid"]: row for row in store.floorplans(ROBOT)}
        self.assertEqual({name: row["map_id"] for name, row in again.items()}, {"first": 3, "second": 7})
        self.assertJustNow(again["second"]["at"])
        store.close()
        self.assertEqual(len(self.open().floorplans(ROBOT)), 2)

    def test_maps_of_floor_plans_are_read_back_however_old(self) -> None:
        store = self.open()
        for robot in (ROBOT, ROBOT, OTHER, ROBOT, ROBOT, ROBOT):
            store.save_map(robot, MAP)
        self.assertEqual(store.floorplan_maps(ROBOT, 6), [])
        # The other robot's floor plans are its own, whichever map one names, and a map that is gone is none to give.
        for robot, rank_uuid, number in ((ROBOT, "first", 1), (ROBOT, "second", 4), (ROBOT, "third", 5),
                                         (OTHER, "fourth", 2), (OTHER, "fifth", 3), (ROBOT, "gone", 9)):
            self.assertTrue(store.save_floorplan(robot, rank_uuid, number))
        # Those older than the map that is named, newest first, each as a list of maps gives it.
        listed = store.floorplan_maps(ROBOT, 5)
        self.assertEqual([row["id"] for row in listed], [4, 1])
        self.assertEqual(listed, [row for row in store.maps(ROBOT, 10) if row["id"] in (4, 1)])
        self.assertNotIn("cmFuaw==", listed[0]["map_json"])
        self.assertEqual([row["id"] for row in store.floorplan_maps(ROBOT, 6)], [5, 4, 1])
        self.assertEqual([row["id"] for row in store.floorplan_maps(ROBOT, 2**63 - 1)], [5, 4, 1])
        self.assertEqual(store.floorplan_maps(ROBOT, 1), [])
        self.assertEqual([row["id"] for row in store.floorplan_maps(OTHER, 6)], [3])
        self.assertEqual(store.floorplan_maps(RobotId("3", "board1"), 6), [])
        # A map that is no floor plan any more is no longer among them.
        store.delete_floorplan(ROBOT, "second")
        self.assertEqual([row["id"] for row in store.floorplan_maps(ROBOT, 6)], [5, 1])

    def test_floor_plan_takes_the_place_of_another_or_is_dropped(self) -> None:
        store = self.open()
        for robot in (ROBOT, OTHER):
            store.save_floorplan(robot, "first", 1)
            store.save_floorplan(robot, "second", 2)
        # The other robot's of the same name stays, and so does this robot's other one.
        self.assertTrue(store.save_floorplan(ROBOT, "third", 3, "first"))
        others = [("n", "board2", "first", 1), ("n", "board2", "second", 2)]
        self.assertEqual(self.plans(), [("n", "board1", "second", 2), ("n", "board1", "third", 3), *others])
        # In place of one the server never knew of, and in place of one that is already there.
        self.assertTrue(store.save_floorplan(ROBOT, "fourth", 4, "elsewhere"))
        self.assertTrue(store.save_floorplan(ROBOT, "second", 5, "third"))
        self.assertEqual(self.plans(), [("n", "board1", "fourth", 4), ("n", "board1", "second", 5), *others])
        # One that is dropped is gone, and one that was never held is dropped as well as any.
        for _ in range(2):
            self.assertTrue(store.delete_floorplan(ROBOT, "fourth"))
            self.assertEqual(self.plans(), [("n", "board1", "second", 5), *others])
        self.assertTrue(store.delete_floorplan(RobotId("3", "board1"), "second"))
        self.assertEqual(len(self.plans()), 3)

    def test_floor_plan_that_cannot_be_noted(self) -> None:
        with mock.patch("deorbit.store._BUSY_TIMEOUT", 0.05):
            store = self.open()
        store.save_floorplan(ROBOT, "first", 1)
        before = self.plans()
        with contextlib.closing(sqlite3.connect(self.path)) as db, self.assertLogs("deorbit", "ERROR") as logs:
            self.assertFalse(store.save_floorplan(ROBOT, "\ud800", 2))  # not text that UTF-8 can carry
            # Another program has the file for longer than the store waits for it.
            db.execute("BEGIN IMMEDIATE")
            self.assertFalse(store.save_floorplan(ROBOT, "second", 2))
            self.assertFalse(store.delete_floorplan(ROBOT, "first"))
            db.execute("ROLLBACK")
            # The new one is not let in, when the one it takes the place of has already gone.
            db.execute("CREATE TRIGGER no_insert BEFORE INSERT ON floorplans BEGIN SELECT RAISE(ABORT, 'full'); END")
            self.assertFalse(store.save_floorplan(ROBOT, "second", 2, "first"))
            self.assertEqual(self.plans(), before)
            db.execute("DROP TRIGGER no_insert")
        self.assertEqual(len(logs.output), 4)
        for line, why in zip(logs.output[1:], ("database is locked", "database is locked", "full")):
            self.assertIn(f"[n/board1] not saved to the database: {why}", line)
        # None of that left the store in the middle of anything: what it writes next is in the file.
        self.assertTrue(store.save_floorplan(ROBOT, "second", 2, "first"))
        self.assertEqual(self.plans(), [("n", "board1", "second", 2)])

    def test_file_without_a_floorplans_table_gets_one(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.add_event(ROBOT, "login")
        store.save_map(ROBOT, MAP)
        store.save_name(ROBOT, "Rosie")
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE floorplans")  # as in a file from before floor plans were noted
        before = self.rows(), self.logged(), self.maps(), self.names()
        store = self.open()
        self.assertEqual(store.floorplans(ROBOT), [])
        self.assertTrue(store.save_floorplan(ROBOT, MAP["rank_uuid"], 1))
        self.assertEqual(self.plans(), [("n", "board1", MAP["rank_uuid"], 1)])
        self.assertEqual((self.rows(), self.logged(), self.maps(), self.names()), before)

    def test_track_is_noted_with_what_was_drawn(self) -> None:
        store = self.open()
        self.assertEqual(store.tracks(ROBOT), [])
        self.assertTrue(store.save_track(ROBOT, "first", "lines", "no-go", None, None, [[0, 0, 5, 5], [1, 2, 3, 4]]))
        self.assertTrue(store.save_track(ROBOT, "first", "zone-a", "cleaning", "Kitchen", "eco", [5, 6, 7, 8]))
        self.assertTrue(store.save_track(ROBOT, "first", "zone-b", "cleaning", "hall", "turbo", [1, 2, 3, 4]))
        self.assertTrue(store.save_track(ROBOT, "else", "zone-c", "cleaning", "Attic", "max", [0, 0, 0, 0]))
        self.assertTrue(store.save_track(OTHER, "first", "zone-a", "cleaning", "Kitchen", "eco", [5, 6, 7, 8]))
        # By floor plan, its zones first in the order they were noted, not by name, then its no-go lines; each as the row is stored.
        listed = store.tracks(ROBOT)
        self.assertEqual([row["track_uuid"] for row in listed], ["zone-c", "zone-a", "zone-b", "lines"])
        zone, lines = listed[1], listed[3]
        self.assertEqual(zone, {"vendor": "n", "serial": "board1", "track_uuid": "zone-a", "rank_uuid": "first",
                                "type": "cleaning", "name": "Kitchen", "mode": "eco", "shape_json": "[5,6,7,8]", "at": zone["at"]})
        self.assertJustNow(zone["at"])
        self.assertEqual((lines["type"], lines["name"], lines["mode"], lines["shape_json"]),
                         ("no-go", None, None, "[[0,0,5,5],[1,2,3,4]]"))
        self.assertEqual([row["track_uuid"] for row in store.tracks(OTHER)], ["zone-a"])
        # A track alone makes no robot and no floor plan.
        self.assertEqual((self.rows(), self.plans()), ({}, []))
        # One that is saved again is the same track, as it was last drawn, and in the place it had.
        self.assertTrue(store.save_track(ROBOT, "first", "zone-a", "cleaning", "Pantry", "max", [1, 1, 2, 2]))
        again = store.tracks(ROBOT)
        self.assertEqual([row["track_uuid"] for row in again], ["zone-c", "zone-a", "zone-b", "lines"])
        self.assertEqual([again[1][name] for name in ("name", "mode", "shape_json")], ["Pantry", "max", "[1,1,2,2]"])
        # One that is dropped is gone, and one that was never held is dropped as well as any.
        for _ in range(2):
            self.assertTrue(store.delete_tracks(ROBOT, ["zone-b"]))
            self.assertEqual([row["track_uuid"] for row in store.tracks(ROBOT)], ["zone-c", "zone-a", "lines"])
        self.assertEqual([row["track_uuid"] for row in store.tracks(OTHER)], ["zone-a"])
        store.close()
        self.assertEqual(len(self.open().tracks(ROBOT)), 3)

    def test_tracks_go_with_their_floor_plan(self) -> None:
        store = self.open()
        for robot in (ROBOT, OTHER):
            store.save_floorplan(robot, "first", 1)
            store.save_floorplan(robot, "second", 2)
            for plan in ("first", "second", "third"):
                store.save_track(robot, plan, f"{plan}-zone", "cleaning", "Hall", "eco", [0, 0, 1, 1])
                store.save_track(robot, plan, f"{plan}-lines", "no-go", None, None, [[0, 0, 1, 1]])

        def kept(robot: RobotId = ROBOT) -> list[str]:
            return [row["track_uuid"] for row in store.tracks(robot)]

        # A floor plan that is dropped takes its zones and its no-go lines with it.
        self.assertTrue(store.delete_floorplan(ROBOT, "first"))
        self.assertEqual(kept(), ["second-zone", "second-lines", "third-zone", "third-lines"])
        # So does one that another takes the place of, and the other comes without any.
        self.assertTrue(store.save_floorplan(ROBOT, "fourth", 3, "second"))
        self.assertEqual(kept(), ["third-zone", "third-lines"])
        # A floor plan is made without them, even where the robot kept it before.
        self.assertTrue(store.save_floorplan(ROBOT, "third", 4))
        self.assertEqual(kept(), [])
        self.assertEqual(len(kept(OTHER)), 6)

    def test_track_that_cannot_be_noted(self) -> None:
        with mock.patch("deorbit.store._BUSY_TIMEOUT", 0.05):
            store = self.open()
        store.save_floorplan(ROBOT, "first", 1)
        store.save_track(ROBOT, "first", "zone", "cleaning", "Hall", "eco", [0, 0, 1, 1])
        before = self.plans(), self.tracked()
        with contextlib.closing(sqlite3.connect(self.path)) as db, self.assertLogs("deorbit", "ERROR") as logs:
            self.assertFalse(store.save_track(ROBOT, "first", "zone", "cleaning", "\ud800", "eco", [0, 0, 1, 1]))
            # A shape that JSON cannot read back, which a page could not draw.
            self.assertFalse(store.save_track(ROBOT, "first", "zone", "cleaning", "Hall", "eco", [float("inf")]))
            # Another program has the file for longer than the store waits for it.
            db.execute("BEGIN IMMEDIATE")
            self.assertFalse(store.save_track(ROBOT, "first", "zone", "cleaning", "Kitchen", "eco", [0, 0, 1, 1]))
            self.assertFalse(store.delete_tracks(ROBOT, ["zone"]))
            db.execute("ROLLBACK")
            # A floor plan is not dropped without its tracks.
            db.execute("CREATE TRIGGER no_delete BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT, 'full'); END")
            self.assertFalse(store.delete_floorplan(ROBOT, "first"))
            self.assertEqual((self.plans(), self.tracked()), before)
            db.execute("DROP TRIGGER no_delete")
        self.assertEqual(len(logs.output), 5)
        for line, why in zip(logs.output[1:], ("CHECK constraint failed: shape_json_is_json", "database is locked",
                                               "database is locked", "full")):
            self.assertIn(f"[n/board1] not saved to the database: {why}", line)
        self.assertTrue(store.delete_floorplan(ROBOT, "first"))
        self.assertEqual((self.plans(), self.tracked()), ([], []))

    def test_file_without_a_tracks_table_gets_one(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        store.save_floorplan(ROBOT, MAP["rank_uuid"], 1)
        store.close()
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE tracks")  # as in a file from before zones were drawn
        before = self.rows(), self.plans()
        store = self.open()
        self.assertEqual(store.tracks(ROBOT), [])
        self.assertTrue(store.save_track(ROBOT, MAP["rank_uuid"], "zone", "cleaning", "Hall", "eco", [0, 0, 1, 1]))
        self.assertEqual(len(self.tracked()), 1)
        self.assertEqual((self.rows(), self.plans()), before)

    def fill(self, store: Store) -> None:
        """Give both robots something in every table."""
        for robot in (ROBOT, OTHER):
            store.save_state(robot, STATE)
            store.save_heartbeat(robot)
            store.add_event(robot, "login")
            store.add_event(robot, "request", "robots.notify", {"message_code": "bin_full"})
            store.save_map(robot, MAP)
            store.save_name(robot, "Rosie")
            store.save_map_name(robot, store.maps(robot, 1)[0]["id"], "Hall")
            store.save_floorplan(robot, MAP["rank_uuid"], 1)
            store.save_track(robot, MAP["rank_uuid"], "zone", "cleaning", "Kitchen", "eco", [1, 2, 3, 4])

    def held(self) -> tuple:
        """All that the file holds, table by table."""
        return self.rows(), self.logged(), self.maps(), self.names(), self.called(), self.plans(), self.tracked()

    def test_robot_is_deleted_from_every_table(self) -> None:
        store = self.open()
        self.fill(store)
        rows, logged, maps, names, called, plans, tracked = self.held()
        self.assertTrue(store.delete(ROBOT))
        # The other robot has all it had, and this one nothing.
        self.assertEqual(self.held(), (
            {OTHER: rows[OTHER]},
            [event for event in logged if event["serial"] == "board2"],
            [row for row in maps if row["serial"] == "board2"],
            {OTHER: "Rosie"},
            [("n", "board2", 2, "Hall")],
            [("n", "board2", MAP["rank_uuid"], 1)],
            [("n", "board2", "zone", MAP["rank_uuid"], "cleaning", "Kitchen", "eco", "[1,2,3,4]")],
        ))
        self.assertEqual([len(found) for found in self.held()], [1, 2, 1, 1, 1, 1, 1])
        self.assertIsNone(store.robot(ROBOT))
        self.assertEqual((store.events(ROBOT, 10), store.maps(ROBOT, 10), store.map_names(ROBOT), store.floorplans(ROBOT),
                          store.tracks(ROBOT)), ([], [], [], [], []))
        # A robot the file has nothing of is deleted as well as any.
        self.assertTrue(store.delete(ROBOT))
        self.assertTrue(store.delete(RobotId("3", "board2")))
        self.assertEqual(set(self.rows()), {OTHER})
        # No table of the file is left out.
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            tables = [name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        self.assertEqual(sorted(tables), sorted(_TABLES))

    def test_deleted_robot_is_not_left_in_the_file(self) -> None:
        store = self.open()
        self.fill(store)
        # Something in each table that only this robot has, the map long enough to take pages of its own.
        gone = RobotId("n", "serial-of-the-deleted")
        store.save_state(gone, {"state": "state-of-the-deleted"})
        store.add_event(gone, "request", "robots.notify", {"message_code": "event-of-the-deleted"})
        store.save_map(gone, {"map": {"rank_binary": "map-of-the-deleted" * 5000}})
        store.save_name(gone, "name-of-the-deleted")
        store.save_map_name(gone, store.maps(gone, 1)[0]["id"], "label-of-the-deleted")
        store.save_floorplan(gone, "plan-of-the-deleted", 1)
        store.save_track(gone, "plan-of-the-deleted", "track-of-the-deleted", "cleaning", "zone-of-the-deleted", "eco", [])
        for what in (b"serial", b"state", b"event", b"map", b"name", b"label", b"plan", b"track", b"zone"):
            self.assertIn(what + b"-of-the-deleted", self.path.read_bytes())
        before = self.held()
        self.assertTrue(store.delete(gone))
        # Not as rows, and not as what rows leave behind in the pages they were on.
        self.assertNotIn(b"-of-the-deleted", self.path.read_bytes())
        self.assertEqual([len(found) for found in self.held()], [len(found) - 1 for found in before])

    def test_robot_that_cannot_be_deleted_keeps_all_it_has(self) -> None:
        with mock.patch("deorbit.store._BUSY_TIMEOUT", 0.05):
            store = self.open()
        self.fill(store)
        before = self.held()
        with contextlib.closing(sqlite3.connect(self.path)) as db, self.assertLogs("deorbit", "ERROR") as logs:
            # Another program has the file for longer than the store waits for it.
            db.execute("BEGIN IMMEDIATE")
            self.assertFalse(store.delete(ROBOT))
            db.execute("ROLLBACK")
            # The last table that is gone through lets nothing go, when the others already have.
            db.execute(f"CREATE TRIGGER no_delete BEFORE DELETE ON {_TABLES[-1]} BEGIN SELECT RAISE(ABORT, 'full'); END")
            self.assertFalse(store.delete(ROBOT))
            self.assertEqual(self.held(), before)
            db.execute("DROP TRIGGER no_delete")
        self.assertEqual(len(logs.output), 2)
        self.assertIn("[n/board1] not deleted from the database: database is locked", logs.output[0])
        self.assertIn("[n/board1] not deleted from the database: full", logs.output[1])
        # Neither left the store in the middle of anything: what it writes next is in the file, and so is a delete.
        store.add_event(OTHER, "disconnect")
        self.assertEqual(len(self.logged()), len(before[1]) + 1)
        self.assertTrue(store.delete(ROBOT))
        self.assertEqual(set(self.rows()), {OTHER})

    def test_file_that_cannot_be_read(self) -> None:
        store = self.open()
        store.save_state(ROBOT, STATE)
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("DROP TABLE names")
            # A robot is read with its name, so its row alone is not enough.
            for read in (store.robots, lambda: store.robot(ROBOT)):
                with self.assertRaisesRegex(StoreError, "^cannot read the database: no such table: names$"):
                    read()
            db.execute("DROP TABLE robots")
            db.execute("DROP TABLE events")
            db.execute("DROP TABLE maps")
            db.execute("DROP TABLE floorplans")
            db.execute("DROP TABLE tracks")
        for table, read in (("robots", store.robots), ("robots", lambda: store.robot(ROBOT)),
                            ("events", lambda: store.events(ROBOT, 10)), ("maps", lambda: store.maps(ROBOT, 10)),
                            ("maps", lambda: store.map(ROBOT, 1)), ("maps", lambda: store.floorplan_maps(ROBOT, 9)),
                            ("floorplans", lambda: store.floorplans(ROBOT)), ("tracks", lambda: store.tracks(ROBOT))):
            with self.assertRaisesRegex(StoreError, f"^cannot read the database: no such table: {table}$"):
                read()

    def test_file_that_cannot_be_opened(self) -> None:
        self.path.write_text("not a database, and not a directory either")
        for path in (self.path, self.path / "deorbit.db"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(StoreError, f"cannot open the database {path}: "):
                    Store(path)
        self.assertEqual(self.path.read_text(), "not a database, and not a directory either")


if __name__ == "__main__":
    unittest.main()
