"""Robot-to-server services, routed by ``to.service``.

A handler takes the store, the robot and the request body, and returns
``(code, body)``, or ``None`` when the robot expects no answer. The handlers
of ``peer.state`` and ``maps.create`` store what they are sent; every other
service gets the minimal reply that keeps the robot happy. Each but that of
``peer.state`` logs a line of what it was told, the session logging the whole
message only at the debug level. The event log is not kept here: the session
adds a message to it before calling the handler.
"""

import logging
from collections.abc import Callable
from typing import Any

from .auth import RobotId
from .store import Store, StoreError

log = logging.getLogger(__name__)

Reply = tuple[int, Any] | None


def _field(body: Any, name: str) -> Any:
    """A field of a body, or ``None`` where the body is no object, for a log line, which takes what the robot sent."""
    return body.get(name) if isinstance(body, dict) else None


def _peer_state(store: Store, robot: RobotId, body: Any) -> Reply:
    if isinstance(body, dict):
        store.save_state(robot, body)
    else:
        # Nothing to store, and the last good state is worth more than a blank.
        log.warning("[%s] peer.state without a state object: not saved", robot)
    return None


def _error_codes(store: Store, robot: RobotId, body: Any) -> Reply:
    # A warning whatever its severity: an error is this server's own.
    log.warning("[%s] alert %r, severity %r", robot, _field(body, "code"), _field(body, "severity"))
    return None


def _notify(store: Store, robot: RobotId, body: Any) -> Reply:
    log.info("[%s] notification %r", robot, _field(body, "message_code"))
    # A request on the wire, but the robot never waits for the response.
    return None


def _robots_link(store: Store, robot: RobotId, body: Any) -> Reply:
    log.info("[%s] linked to user %r", robot, _field(body, "user_id"))
    return 201, {}


def _firmware_check(store: Store, robot: RobotId, body: Any) -> Reply:
    log.info("[%s] firmware check from version %r: no update offered", robot, _field(body, "version"))
    # Any code other than 200 means "no update".
    return 404, {}


def _maps_create(store: Store, robot: RobotId, body: Any) -> Reply:
    # 201 says the map is kept, so it is answered only once it is in the file.
    # The robot takes any other code for a failed upload, which it does not
    # send again (section 7.3 of the spec).
    if not isinstance(body, dict):
        log.warning("[%s] maps.create without a map object: not saved", robot)
        return 400, {}
    # A robot sends an upload again, under its rank_uuid, when its connection
    # dropped before the answer came, and the spec has the server take it for
    # the one it has (section 7.3): it is answered as kept, and not kept twice.
    rank_uuid = body.get("rank_uuid")
    try:
        again = isinstance(rank_uuid, str) and store.has_map(robot, rank_uuid)
    except StoreError as exc:
        # Not known, so it is kept, and a map twice in the file is better than one not in it.
        log.error("[%s] %s", robot, exc)
        again = False
    if again:
        log.info("[%s] map %r uploaded again: already saved", robot, rank_uuid)
    elif store.save_map(robot, body):
        log.info("[%s] map %r uploaded: saved", robot, rank_uuid)
    else:
        return 500, {}
    # Never a floor plan: on true the robot promotes the map by itself.
    return 201, {"floorplan": False}


def _logs_list_files(store: Store, robot: RobotId, body: Any) -> Reply:
    files = _field(body, "files")
    log.info("[%s] offers %d log file(s) to upload: none asked for", robot, len(files) if isinstance(files, list) else 0)
    # No upload URLs: the robot has nothing to PUT.
    return 200, {"urls": []}


def _logs_update_status(store: Store, robot: RobotId, body: Any) -> Reply:
    log.info("[%s] log upload %r: %r", robot, _field(body, "log_id"), _field(body, "state"))
    return 200, {}


SERVICES: dict[str, Callable[[Store, RobotId, Any], Reply]] = {
    "peer.state": _peer_state,
    "robots.error_codes": _error_codes,
    "robots.notify": _notify,
    "robots.link": _robots_link,
    "firmware.check": _firmware_check,
    "maps.create": _maps_create,
    "logs.list_files": _logs_list_files,
    "logs.update_status": _logs_update_status,
}
