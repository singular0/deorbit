"""What the web UI can send a robot: its commands and the changes to its schedule, its floor plans and its settings, each an ability invoked through ``Session.call``."""

import base64
import json
import math
import re
from collections.abc import Callable

# By the name a robot's state gives the command under ``available_commands``:
# the ability to invoke and what is sent with it, which is nothing for all but
# the first.
#
# ``cleaning.start`` takes ``runs``, at least one, each with its ``settings``
# and its ``map`` (section 6.1 of the spec). A map of ``None`` is a cleaning on
# no saved floor plan, which is the only kind the Start button asks for. The
# mode may be eco, turbo, auto or max and the navigation mode normal or gentle;
# these two are the ones a robot gave for a run started from its own button.
COMMANDS: dict[str, tuple[str, dict]] = {
    "start": ("cleaning.start", {"runs": [{"map": None, "settings": {"mode": "eco", "navigation_mode": "normal"}}]}),
    "pause": ("cleaning.pause", {}),
    "resume": ("cleaning.resume", {}),
    "cancel": ("cleaning.cancel", {}),
    "return_to_base": ("navigation.return_to_base", {}),
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


def floorplan(action: str, rank_uuid: str, old_rank_uuid: str, uploaded: str | None, created: str) -> tuple[str, dict]:
    """The ability for an action on a robot's floor plans and what is sent with it, or a ``ValueError`` that says what is wrong.

    ``demote`` has the robot drop the floor plan ``rank_uuid``. The other two
    make a floor plan of ``uploaded``, the JSON of a map as the robot uploaded
    it: ``promote`` a new one, and ``update`` one that takes the place of
    ``old_rank_uuid``. The spec lets ``maps.promote_floorplan`` name a floor
    plan to supersede as well; here it never does, and ``maps.update_floorplan``
    always does. ``created`` is the time the floor plan is to say it was made.

    A floor plan has the map's ``rank_uuid``, its two binaries and where the
    base was, each checked and nothing else of the map passed on: section 6.3
    of the spec has a robot refuse a base with a field too many.
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
        "date_created": created,
    }
    if action == "update":
        return "maps.update_floorplan", plan
    # Without a no-go map and with no zones, which is how a robot promotes a map by itself (section 7.3).
    return "maps.promote_floorplan", {**plan, "nogo_track": None, "cleaning_tracks": []}


# What a robot's sounds may be set to (section 6.4 of the spec). To the spec a
# volume is "conventionally" 0 to 100, and nothing else is sent. The page's
# script lists the same.
VOICES = ("on", "off")
VOLUME_MAX = 100


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


def _sounds(given: object) -> dict:
    # The spec has only enabled required, and a volume left out set to 100, so a change says all three.
    enabled, voice, volume = _fields(given, "value", "enabled", "voice", "volume")
    if not isinstance(volume, int) or isinstance(volume, bool) or not 0 <= volume <= VOLUME_MAX:
        raise ValueError(f"value.volume must be a whole number from 0 to {VOLUME_MAX}")
    return {"enabled": _flag(enabled, "value.enabled"), "voice": _among(voice, VOICES, "value.voice"), "volume": volume}


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
# too, which is no setting and cannot be undone, so it is not among these.
_SETTERS = {
    "robot_language": _language,
    "sounds": _sounds,
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
