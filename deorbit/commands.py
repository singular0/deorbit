"""What the web UI can send a robot: its commands and the changes to its schedule, its floor plans, their zones and no-go lines and its settings, each an ability invoked through ``Session.call``."""

import base64
import json
import math
import re
import unicodedata
import zlib
from collections.abc import Callable
from datetime import datetime

# By the name a robot's state gives the command under ``available_commands``:
# the ability to invoke and what is sent with it, which is nothing for all but
# the first. The last is the one a state does not list: ``utilities.find_me``,
# which has the robot make the sound it is found by (section 6.4 of the spec),
# under the name of its action.
#
# ``cleaning.start`` takes ``runs``, at least one, each with its ``settings``
# and its ``map`` (section 6.1 of the spec). A map of ``None`` is a cleaning on
# no saved floor plan, which is what the Start button asks for unless it is
# given a run of its own (see ``command``). The mode may be eco, turbo, auto or
# max and the navigation mode normal or gentle; these two are the ones a robot
# gave for a run started from its own button.
COMMANDS: dict[str, tuple[str, dict]] = {
    "start": ("cleaning.start", {"runs": [{"map": None, "settings": {"mode": "eco", "navigation_mode": "normal"}}]}),
    "pause": ("cleaning.pause", {}),
    "resume": ("cleaning.resume", {}),
    "cancel": ("cleaning.cancel", {}),
    "return_to_base": ("navigation.return_to_base", {}),
    "find_me": ("utilities.find_me", {}),
}

# What an event of a robot's schedule may name (section 6.2 of the spec, and
# 6.1 for the settings of a run). The page's script lists the same.
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
MODES = ("eco", "turbo", "auto", "max")
NAVIGATION_MODES = ("normal", "gentle")

_ID = re.compile(r"[0-9]+")
_TIME = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")
# What a robot knows a floor plan by. To the spec a UUID is any string that is
# not empty, and the ones a robot gave have this shape. A robot deletes a floor
# plan by it, and what it does with any other text is not known, so nothing
# else is sent for one.
_UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
# A UTC timestamp as the spec writes one, which is how a robot gives the end of a run.
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")


def _fields(given: object, where: str, *names: str) -> list:
    """The values of the fields ``names`` of ``given``, which has to be an object of just those."""
    if not isinstance(given, dict) or set(given) != set(names):
        raise ValueError(f"{where} must be an object of {', '.join(names)} and nothing else")
    return [given[name] for name in names]


def _among(value: object, allowed: tuple[str, ...], where: str) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"{where} must be one of {', '.join(allowed)}")
    return value


def _id(value: object, where: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError(f"{where} must be a string of digits")
    return value


def _run(given: object, where: str) -> dict:
    """A ``CleaningRun`` of the spec, made of the one ``given``."""
    settings, place = _fields(given, where, "settings", "map")
    mode, navigation = _fields(settings, f"{where}.settings", "mode", "navigation_mode")
    run = {
        "settings": {
            "mode": _among(mode, MODES, f"{where}.settings.mode"),
            "navigation_mode": _among(navigation, NAVIGATION_MODES, f"{where}.settings.navigation_mode"),
        },
        "map": None,
    }
    if place is not None:
        rank, track, nogo = _fields(place, f"{where}.map, unless null,", "rank_id", "track_id", "nogo_enabled")
        if not isinstance(rank, str) or not rank:
            raise ValueError(f"{where}.map.rank_id must be a string that is not empty")
        if track is not None and (not isinstance(track, str) or not track):
            raise ValueError(f"{where}.map.track_id must be null or a string that is not empty")
        if not isinstance(nogo, bool):
            raise ValueError(f"{where}.map.nogo_enabled must be true or false")
        run["map"] = {"rank_id": rank, "track_id": track, "nogo_enabled": nogo}
    return run


def command(name: str, run: str) -> tuple[str, dict]:
    """The ability for the command ``name`` and what is sent with it, or a ``ValueError`` that says what is wrong.

    ``run`` is the JSON of the one run a ``start`` is to clean, checked as a
    run of an event of a schedule is and built anew, or empty for the run of
    ``COMMANDS``. No other command takes one. The spec lets ``cleaning.start``
    take several runs, the zones of one floor plan; here it is given one, and
    no ``force_floorplan``, which a robot replaces with its own setting.
    """
    if name not in COMMANDS:
        raise ValueError(f"command must be one of {', '.join(COMMANDS)}")
    if not run:
        return COMMANDS[name]
    if name != "start":
        raise ValueError("run is taken only with start")
    try:
        given = json.loads(run)
    except (ValueError, RecursionError):  # as for an event of a schedule
        raise ValueError("run must be JSON") from None
    return "cleaning.start", {"runs": [_run(given, "run")]}


def _event(given: object, *, known: bool) -> dict:
    """An event of a schedule, made of the one ``given``: with its ``id`` when it is ``known`` to the robot, without one when new.

    Nothing of ``given`` is passed on as it came: the event holds what the spec
    gives one and no more, each value checked.
    """
    names = ("enabled", "days", "time", "command")
    if known:
        number, *values = _fields(given, "event", "id", *names)
        event = {"id": _id(number, "event.id")}
    else:
        values = _fields(given, "event", *names)
        event = {}
    enabled, days, time, command = values
    if not isinstance(enabled, bool):
        raise ValueError("event.enabled must be true or false")
    # The spec allows a list of no days. What a robot makes of one is not known, so none is sent.
    if not isinstance(days, list) or not days or any(not isinstance(day, str) or day not in DAYS for day in days):
        raise ValueError(f"event.days must be a list of one or more of {', '.join(DAYS)}")
    if not isinstance(time, str) or not _TIME.fullmatch(time):
        raise ValueError("event.time must be a time from 00:00 to 23:59")
    ability, runs = _fields(command, "event.command", "ability", "runs")
    if ability != "cleaning.start":
        raise ValueError("event.command.ability must be cleaning.start")
    if not isinstance(runs, list) or not runs:
        raise ValueError("event.command.runs must be a list of one or more runs")
    runs = [_run(run, f"event.command.runs[{n}]") for n, run in enumerate(runs)]
    # More runs than one are the zones of one floor plan (section 6.1).
    maps = [run["map"] for run in runs]
    if len(runs) > 1 and (None in maps or len({place["rank_id"] for place in maps}) > 1):
        raise ValueError("event.command.runs, when more than one, must each have a map of the same rank_id")
    return {
        **event,
        "enabled": enabled,
        "days": [day for day in DAYS if day in days],
        "time": time,
        "command": {"ability": ability, "runs": runs},
    }


def scheduling(action: str, number: str, event: str) -> tuple[str, dict]:
    """The ability for an action on a robot's schedule and what is sent with it, or a ``ValueError`` that says what is wrong.

    ``number`` is the ``id`` of the event to delete, and ``event`` the JSON of
    the one to add or of the one to put in place of that whose ``id`` it has.
    The spec gives ``scheduling.add`` and ``scheduling.update`` one body, with
    an ``id`` that may be left out to make a new event; here ``add`` never
    sends one and ``update`` always does.
    """
    if action == "show":
        return "scheduling.show", {}
    if action == "delete":
        return "scheduling.delete", {"id": _id(number, "id")}
    if action in ("add", "update"):
        try:
            given = json.loads(event)
        except (ValueError, RecursionError):  # the second for brackets nested deeper than Python follows them
            raise ValueError("event must be JSON") from None
        return f"scheduling.{action}", {"event": _event(given, known=action == "update")}
    raise ValueError("action must be one of show, add, update, delete")


def _uuid(value: object, where: str) -> str:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise ValueError(f"{where} must be a UUID")
    return value


def _binary(value: object, where: str) -> str:
    """An encoded map, which goes back to the robot as the Base64 text it came as."""
    try:
        held = isinstance(value, str) and base64.b64decode(value, validate=True)
    except ValueError:  # not Base64
        held = False
    if not held:
        raise ValueError(f"{where} must be Base64 that is not empty")
    return value


def _base(given: object, where: str) -> dict:
    """Where a robot's base is, made of the place ``given``: the three fields a floor plan takes and nothing else."""
    if not isinstance(given, dict):
        raise ValueError(f"{where} must be an object of x, y, dir")
    base = {}
    for name in ("x", "y"):
        base[name] = given.get(name)
        if not isinstance(base[name], int) or isinstance(base[name], bool):
            raise ValueError(f"{where}.{name} must be a whole number")
    heading = given.get("dir")
    whole = isinstance(heading, int) and not isinstance(heading, bool)
    if not whole and not (isinstance(heading, float) and math.isfinite(heading)):
        raise ValueError(f"{where}.dir must be a number")
    return {**base, "dir": heading}


def _ended(timing: object) -> str:
    """The ``end`` of a map's ``timing``: a UTC timestamp as the spec has one, which is a time that is."""
    end = timing.get("end") if isinstance(timing, dict) else None
    try:
        if isinstance(end, str) and _UTC.fullmatch(end) and datetime.strptime(end, "%Y-%m-%dT%H:%M:%SZ"):
            return end
    except ValueError:  # such as the 30th of February
        pass
    raise ValueError("the map's timing.end must be a UTC time as YYYY-MM-DDTHH:MM:SSZ")


def floorplan(action: str, rank_uuid: str, old_rank_uuid: str, uploaded: str | None) -> tuple[str, dict]:
    """The ability for an action on a robot's floor plans and what is sent with it, or a ``ValueError`` that says what is wrong.

    ``demote`` has the robot drop the floor plan ``rank_uuid``. The other two
    make a floor plan of ``uploaded``, the JSON of a map as the robot uploaded
    it: ``promote`` a new one, and ``update`` one that takes the place of
    ``old_rank_uuid``. The spec lets ``maps.promote_floorplan`` name a floor
    plan to supersede as well; here it never does, and ``maps.update_floorplan``
    always does.

    A floor plan has the map's ``rank_uuid``, its two binaries and where the
    base was, each checked and nothing else of the map passed on: section 6.3
    of the spec has a robot refuse a base with a field too many. It says it was
    made when the map's run ended, which is what a robot sends when it promotes
    a map by itself (section 7.3), and which it keeps as the floor plan's end.
    """
    if action == "demote":
        return "maps.demote_floorplan", {"rank_uuid": _uuid(rank_uuid, "rank_uuid")}
    if action not in ("promote", "update"):
        raise ValueError("action must be one of promote, update, demote")
    old = _uuid(old_rank_uuid, "old_rank_uuid") if action == "update" else None
    try:
        given = json.loads(uploaded)
    except (ValueError, RecursionError):  # as for an event of a schedule
        raise ValueError("the map must be JSON") from None
    if not isinstance(given, dict):
        raise ValueError("the map must be an object")
    binaries, places = (given[name] if isinstance(given.get(name), dict) else {} for name in ("map", "robot"))
    new = _uuid(given.get("rank_uuid"), "the map's rank_uuid")
    if old is not None and old.lower() == new.lower():
        raise ValueError("old_rank_uuid must not be the map's own rank_uuid")
    plan = {
        "rank_uuid": new,
        "rank_binary": _binary(binaries.get("rank_binary"), "the map's map.rank_binary"),
        "real_binary": _binary(binaries.get("real_binary"), "the map's map.real_binary"),
        "old_rank_uuid": old,
        "base": _base(places.get("base"), "the map's robot.base"),
        "date_created": _ended(given.get("timing")),
    }
    if action == "update":
        return "maps.update_floorplan", plan
    # Without a no-go map and with no zones, which is how a robot promotes a map by itself (section 7.3).
    return "maps.promote_floorplan", {**plan, "nogo_track": None, "cleaning_tracks": []}


# The zones and the no-go lines of a floor plan are tracks to the spec (section
# 6.3): each is sent as a binary of its own, an "encoded map", with what the
# robot knows it by and the floor plan it is of. A floor plan has one track of
# no-go lines, as ``maps.promote_floorplan`` has one ``nogo_track``, and a zone
# is a cleaning track with a name and a cleaning mode.
#
# Section 6.3.1 of the spec gives the file such a binary is, read off the
# robot's own loader: a binary PGM of two bytes to a cell, little-endian, with
# a maxval of 65535, compressed with zlib; as large as the floor plan, and
# placed against its ``real_binary``, whose header it has as it is but for the
# maxval, so that a cell of it is the cell of the floor plan's maps that the
# page shows, the two being of one size and lined up cell for cell. A marked
# cell holds 1024, which is the value the robot's zone loader turns into a
# cell of the zone; every other is 0. An 8-bit file of a byte to a cell fails
# the reader's maxval check instead, and the run dies with pm_load_fail —
# which is how this was found: a zone of 255 in an 8-bit file, under the
# header of the ``rank_binary``, made a real robot (firmware 1.7.0) fail to
# load it. A zone is a rectangle of cells, and a line goes from cell to cell
# without a corner that a diagonal step could pass through. These are this
# server's choices, and so are the limits below.
ZONE_NAME_MAX = 32  # the most characters a zone's name may have
# The most zones a floor plan may have, which is how many colours the page has
# for them that are told apart from each other and from the rest of a map.
ZONES_MAX = 6
LINES_MAX = 100  # the most no-go lines a floor plan may have
_MARKED = 1024  # the value of a marked cell, as the robot's zone loader reads it
_MARKED_BYTES = _MARKED.to_bytes(2, "little")
_MAXVAL = b"65535"  # the maxval of a track's file of two bytes to a cell
_HEADER_MAX = 4096  # how much of a floor plan's binary is inflated to read its header
_CELLS_MAX = 32 * 1024 * 1024  # the most cells a binary is drawn with; a robot's maps had 4 million


def _grid(uploaded: str) -> tuple[bytes, int, int]:
    """The header a track of a floor plan is drawn with — that of the PGM file the floor plan's ``real_binary`` inflates to, but with the maxval of a track's file — and the width and height of that file in cells, which are those of the ``rank_binary`` too."""
    try:
        given = json.loads(uploaded)
    except (ValueError, RecursionError):  # as for a floor plan
        raise ValueError("the floor plan's map must be JSON") from None
    binaries = given.get("map") if isinstance(given, dict) else None
    binaries = binaries if isinstance(binaries, dict) else {}
    header, end, width, height = _pgm(binaries.get("real_binary"), "the floor plan's map.real_binary")
    _, _, *size = _pgm(binaries.get("rank_binary"), "the floor plan's map.rank_binary")
    if size != [width, height]:
        raise ValueError("the floor plan's map.rank_binary and map.real_binary must be of one size")
    return header + _MAXVAL + end, width, height


def _pgm(given: object, where: str) -> tuple[bytes, bytes, int, int]:
    """The header of the PGM file that an encoded map inflates to, as far as its maxval, the one byte of white space after it, and the width and height of the file in cells."""
    binary = _binary(given, where)
    unreadable = ValueError(f"{where} must be zlib data of a binary PGM file of a byte to a cell")
    try:
        start = zlib.decompressobj().decompress(base64.b64decode(binary), _HEADER_MAX)
    except zlib.error:
        raise unreadable from None
    # Its words, between white space and comments, which run from "#" to the end of a line.
    words, at = [], 0
    while len(words) < 4:
        while at < len(start) and start[at] in b" \t\n\v\f\r":
            at += 1
        if at < len(start) and start[at] == ord("#"):
            while at < len(start) and start[at] not in b"\n\r":
                at += 1
            continue
        begin = at
        while at < len(start) and start[at] not in b" \t\n\v\f\r#":
            at += 1
        words.append(start[begin:at])
        if len(words) == 4:
            maxval_at = begin
    # One byte of white space ends the header.
    if at >= len(start) or start[at] not in b" \t\n\v\f\r" or words[0] != b"P5" or not all(w.isdigit() for w in words[1:]):
        raise unreadable
    width, height, most = (int(word) for word in words[1:])
    if not (width and height and 0 < most < 256):
        raise unreadable
    # What a robot reads a file of a byte to a cell with takes no other (section 6.3.1).
    if most <= 128:
        raise ValueError(f"{where} must be a PGM file whose maxval is from 129 to 255")
    if width * height > _CELLS_MAX:
        raise ValueError(f"{where} is a PGM file of more than {_CELLS_MAX} cells")
    return start[:maxval_at], start[at : at + 1], width, height


def _drawn(header: bytes, width: int, height: int, zone: list[int] | None = None, lines: list[list[int]] = ()) -> str:
    """A binary of the floor plan whose track header this is, two bytes to a cell: a zone, a rectangle of cells, or lines drawn on it."""
    cells = bytearray(width * height * 2)
    if zone is not None:
        left, top, right, bottom = zone
        marked = _MARKED_BYTES * (right - left + 1)
        for row in range(top, bottom + 1):
            at = (row * width + left) * 2
            cells[at : at + len(marked)] = marked
    for x, y, x1, y1 in lines:
        # Bresenham's, with the cell at each corner of the line marked too, so that nothing goes through it on the diagonal.
        dx, dy = abs(x1 - x), -abs(y1 - y)
        sx, sy = (1 if x < x1 else -1), (1 if y < y1 else -1)
        error = dx + dy
        while True:
            cells[(y * width + x) * 2 : (y * width + x + 1) * 2] = _MARKED_BYTES
            if x == x1 and y == y1:
                break
            twice = 2 * error
            across = twice >= dy
            if across:
                error += dy
                x += sx
            if twice <= dx:
                if across:
                    cells[(y * width + x) * 2 : (y * width + x + 1) * 2] = _MARKED_BYTES
                error += dx
                y += sy
    return base64.b64encode(zlib.compress(header + cells)).decode("ascii")


def _cells(given: object, width: int, height: int, where: str) -> list[int]:
    """Four whole numbers that are cells of the floor plan's map: two across it and two down it, in that order, from 0."""
    if not isinstance(given, list) or len(given) != 4:
        raise ValueError(f"{where} must be a list of four whole numbers")
    for n, (value, most) in enumerate(zip(given, (width, height) * 2)):
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < most:
            raise ValueError(f"{where}[{n}] must be a whole number from 0 to {most - 1}")
    return list(given)


def _zone_name(value: object) -> str:
    """The name of a zone, as it is sent: one line, its words a space apart."""
    name = " ".join(value.split()) if isinstance(value, str) else ""
    if not 0 < len(name) <= ZONE_NAME_MAX:
        raise ValueError(f"zone.name must be from 1 to {ZONE_NAME_MAX} characters")
    # The second is a lone surrogate, which JSON can carry and UTF-8 cannot.
    if any(unicodedata.category(character) in ("Cc", "Cs") for character in name):
        raise ValueError("zone.name must not hold control characters")
    return name


def track(action: str, rank_uuid: str, track_uuid: str, given: str, uploaded: str | None = None) -> tuple[str, dict, tuple | None]:
    """The ability for an action on the zones and no-go lines of a robot's floor plan, what is sent with it and what is noted once the robot accepts, or a ``ValueError`` that says what is wrong.

    ``zone`` has the robot keep the zone ``given``, the JSON of its ``name``,
    its ``cleaning_mode`` and its ``rect``, as the track ``track_uuid`` of the
    floor plan ``rank_uuid``; ``nogo`` has it keep the lines ``given``, the
    JSON of a list of them, as that floor plan's no-go lines. Both are drawn on
    ``uploaded``, the JSON of the map the floor plan was made of, as the robot
    uploaded it, and a rectangle and a line are each four cells of it: from the
    left and from the top of the one corner, then of the other, which for a
    rectangle are its top left and its bottom right. What is noted is the
    track's type, its name and its mode, and what was drawn. ``delete`` has the
    robot drop the track ``track_uuid``, and nothing is noted but that.
    """
    if action == "delete":
        return "maps.delete_track", {"tracks": [_uuid(track_uuid, "track_uuid")]}, None
    if action not in ("zone", "nogo"):
        raise ValueError("action must be one of zone, nogo, delete")
    header, width, height = _grid(uploaded)
    try:
        shape = json.loads(given)
    except (ValueError, RecursionError):  # as for an event of a schedule
        raise ValueError(f"{'zone' if action == 'zone' else 'lines'} must be JSON") from None
    if action == "zone":
        name, mode, rect = _fields(shape, "zone", "name", "cleaning_mode", "rect")
        name, mode = _zone_name(name), _among(mode, MODES, "zone.cleaning_mode")
        left, top, right, bottom = shape = _cells(rect, width, height, "zone.rect")
        if left > right or top > bottom:
            raise ValueError("zone.rect must give its top left corner before its bottom right one")
        kept = ("cleaning", name, mode, shape)
        binary = _drawn(header, width, height, zone=shape)
    else:
        if not isinstance(shape, list) or not 0 < len(shape) <= LINES_MAX:
            raise ValueError(f"lines must be a list of from 1 to {LINES_MAX} lines")
        shape = [_cells(line, width, height, f"lines[{n}]") for n, line in enumerate(shape)]
        for n, line in enumerate(shape):
            if line[:2] == line[2:]:
                raise ValueError(f"lines[{n}] must not end where it starts")
        # The spec has a no-go track go without a name and a mode, "conventionally".
        kept = ("no-go", None, None, shape)
        binary = _drawn(header, width, height, lines=shape)
    sent = {
        "rank_uuid": rank_uuid,
        "track_uuid": track_uuid,
        "track_name": kept[1],
        "track_binary": binary,
        "type": kept[0],
        "cleaning_mode": kept[2],
    }
    return "maps.save_track", {"tracks": [sent]}, kept


def _flag(value: object, where: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{where} must be true or false")
    return value


def _language(given: object) -> dict:
    (language,) = _fields(given, "value", "language")
    # The robot matches it against the languages it lists, in whatever case, so that is the robot's to check.
    if not isinstance(language, str) or not language:
        raise ValueError("value.language must be a string that is not empty")
    return {"language": language}


def _switch(name: str) -> Callable[[object], dict]:
    """What checks the value of a setting that is the one field ``name``, true or false."""

    def checked(given: object) -> dict:
        (value,) = _fields(given, "value", name)
        return {name: _flag(value, f"value.{name}")}

    return checked


# The settings a robot keeps (section 6.4 of the spec), each under the action
# that reads it, and what checks a value for the action that changes it, which
# is the same name after ``set_``. The spec has the one field of
# ``settings.set_cleaning_options`` optional; it is never left out here, since
# a change that sets nothing is none. The group has ``settings.factory_reset``
# too, which is no setting and cannot be undone, so it is not among these, and
# ``settings.sounds`` and ``settings.set_sounds``, which are not sent either.
_SETTERS = {
    "robot_language": _language,
    "cleaning_options": _switch("force_floorplan"),
    "ota_updates": _switch("auto"),
}
SETTINGS = tuple(_SETTERS)


def settings(action: str, value: str) -> tuple[str, dict]:
    """The ability for an action on a robot's settings and what is sent with it, or a ``ValueError`` that says what is wrong.

    ``action`` is one of the spec's: the name of a setting reads it, and that
    name after ``set_`` changes it to ``value``, the JSON of an object of the
    fields that action takes. A value is built anew from checked values, as an
    event of a schedule is, never passed on.
    """
    if action in _SETTERS:
        return f"settings.{action}", {}
    setting = action.removeprefix("set_")
    if setting == action or setting not in _SETTERS:
        actions = (name for setting in SETTINGS for name in (setting, f"set_{setting}"))
        raise ValueError(f"action must be one of {', '.join(actions)}")
    try:
        given = json.loads(value)
    except (ValueError, RecursionError):  # as for an event of a schedule
        raise ValueError("value must be JSON") from None
    return f"settings.{action}", _SETTERS[setting](given)
