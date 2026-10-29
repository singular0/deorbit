"""One robot connection: login, heartbeats and message routing."""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any

from .auth import LoginRejected, RobotId
from .config import TRACE
from .framing import CLOSE, HEARTBEAT, FrameTooLarge, encode_frame, read_frame
from .services import SERVICES
from .store import now

if TYPE_CHECKING:
    from .server import Server

log = logging.getLogger(__name__)

# Signatures and map binaries stay out of the event log, and out of the console
# but at the trace level.
_REDACTED_KEYS = {"signature", "rank_binary", "real_binary", "track_binary"}
# Services whose messages are not added to the event log: the database already
# holds each robot's latest state.
_UNLOGGED = {"peer.state"}


class Disconnect(Exception):
    """Ends the session; the message becomes the logged disconnect reason.

    ``fault`` is for a robot that did what it must not, whose disconnect is a warning.
    """

    def __init__(self, reason: str, *, fault: bool = False) -> None:
        super().__init__(reason)
        self.fault = fault


def describe(exc: BaseException) -> str:
    """An exception as log text; a bare ``ConnectionResetError()`` has no message."""
    return str(exc) or type(exc).__name__


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: f"<{len(item)} chars>" if key in _REDACTED_KEYS and isinstance(item, str) else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


class Session:
    def __init__(
        self,
        server: "Server",
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        address: tuple[str, int],
    ) -> None:
        self._server = server
        self._config = server.config
        self._reader = reader
        self._writer = writer
        self._write_lock = asyncio.Lock()
        # Calls this server made to the robot, by request ID: who waits for the
        # answer, since when, the ability asked for, and the ability with who
        # asked for it, as the log names the call. Requests from the
        # robot are answered inline, so that direction needs no bookkeeping.
        self._pending: dict[str, tuple[asyncio.Future, float, str, str]] = {}
        self._close_reason: str | None = None
        self.ip = address[0]
        self.peer = f"{address[0]}:{address[1]}"
        self.robot: RobotId | None = None
        # Known once the robot has logged in; the web UI shows them.
        self.firmware: str | None = None
        self.since: str | None = None  # when the login was accepted

    @property
    def label(self) -> str:
        return str(self.robot) if self.robot else self.peer

    async def run(self) -> None:
        # A fault is a disconnect that the robot or this server caused by doing what it must not.
        reason, fault = "internal error", True
        heartbeat = None
        try:
            await self._login()
            heartbeat = asyncio.create_task(self._heartbeat())
            reason, fault = await self._receive(), False
        except Disconnect as exc:
            reason, fault = str(exc), exc.fault
        except FrameTooLarge as exc:
            reason = str(exc)
        except asyncio.IncompleteReadError as exc:
            reason, fault = "connection closed by robot" + (" mid-frame" if exc.partial else ""), False
        except OSError as exc:
            reason, fault = f"connection error: {describe(exc)}", False
        except asyncio.CancelledError:
            reason, fault = "server shutting down", False
            raise
        except Exception:
            log.exception("[%s] session failed", self.label)
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
            self._server.unregister(self)
            if self._close_reason is not None:
                reason, fault = self._close_reason, False
            for future, *_ in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError(f"session closed: {reason}"))
            self._pending.clear()
            self._say(logging.WARNING if fault else logging.INFO, "disconnected: %s", reason)
            if self.robot is not None:  # it had logged in, so the log holds a login that this ends
                self._server.store.add_event(self.robot, "disconnect", body={"reason": reason})
            self._writer.close()
            with contextlib.suppress(OSError):
                await self._writer.wait_closed()

    def close(self, reason: str) -> None:
        """Drop the connection without waiting for the robot."""
        self._close_reason = reason
        self._writer.transport.abort()

    async def call(
        self, ability: str, params: dict | None = None, *, timeout: float = 30.0, origin: str | None = None
    ) -> dict:
        """Invoke a robot ability and return the robot's response message.

        Raises ``TimeoutError`` if the robot does not answer in time and
        ``ConnectionError`` if the session closes first. The event log gets
        the call, and the response once there is one. The console gets the
        answer, or a warning that there was none, naming ``origin`` as who
        asked, such as "the web UI".
        """
        call_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        asked = ability if origin is None else f"{ability} from {origin}"
        self._pending[call_id] = (future, time.monotonic(), ability, asked)
        try:
            body = {**(params or {}), "ability": ability}
            self._server.store.add_event(self.robot, "call", body=_redact(body))
            await self._send_json({"type": "request", "id": call_id, "body": body}, f"request {asked} id={call_id}")
            async with asyncio.timeout(timeout):
                return await future
        except TimeoutError:  # before OSError, which it is one of
            self._say(logging.WARNING, "%s: no answer within %g s", asked, timeout)
            raise
        except OSError as exc:  # not sent, or the session closed first
            self._say(logging.WARNING, "%s: no answer: %s", asked, describe(exc))
            raise
        finally:
            self._pending.pop(call_id, None)

    async def _login(self) -> None:
        login = self._decode(await self._read(self._config.login_timeout))
        self._trace(logging.DEBUG, "<- login", login)
        authenticator = self._server.authenticator
        try:
            self.robot = authenticator.authenticate(login)
        except LoginRejected as exc:
            await self._send_json({"code": exc.code}, f"login response {exc.code}")
            raise Disconnect(f"login rejected: {exc}", fault=True) from None
        firmware = login.get("firmware")
        self.firmware = firmware if isinstance(firmware, str) else None
        self.since = now()
        self._say(
            logging.INFO,
            "logged in from %s, firmware %s%s",
            self.peer,
            login.get("firmware"),
            "" if authenticator.enabled else " (signature NOT verified)",
        )
        noted = {"address": self.ip, "firmware": self.firmware, "verified": authenticator.enabled}
        self._server.store.add_event(self.robot, "login", body=noted)
        self._server.register(self)
        body = {"ip_address": self.ip, "timezone": self._config.timezone}
        await self._send_json({"code": 200, "body": body}, "login response 200")

    async def _heartbeat(self) -> None:
        # The robot gives up after 70 seconds without a frame from us.
        with contextlib.suppress(OSError):  # the receive loop reports a dead connection
            while True:
                await asyncio.sleep(self._config.heartbeat_interval)
                self._say(logging.DEBUG, "-> heartbeat")
                await self._send(HEARTBEAT)

    async def _receive(self) -> str:
        while True:
            payload = await self._read(self._config.idle_timeout)
            if payload == HEARTBEAT:
                self._say(logging.DEBUG, "<- heartbeat")
                self._server.store.save_heartbeat(self.robot)
            elif payload == CLOSE:
                return "closed by robot"
            else:
                await self._dispatch(self._decode(payload))

    async def _dispatch(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "response":
            self._on_response(message)
        elif kind in ("request", "event"):
            await self._on_service(kind, message)
        else:
            self._trace(logging.WARNING, f"<- message of unknown type {kind!r}", message)

    def _on_response(self, message: dict) -> None:
        call_id = message.get("id")
        pending = self._pending.pop(call_id, None) if isinstance(call_id, str) else None
        code = message.get("code")
        if pending is None:
            self._trace(logging.WARNING, f"<- response {code!r} id={call_id!r} (no such call pending)", message)
            return
        future, started, ability, asked = pending
        # Anything but 200 is the robot not doing what it was asked.
        level = logging.INFO if code == 200 else logging.WARNING
        self._trace(level, f"{asked}: {code!r} after {(time.monotonic() - started) * 1000:.0f} ms", message)
        # The ability is noted with it: a response names only the ID of its call.
        noted = {"ability": ability, "code": code, "body": _redact(message.get("body"))}
        self._server.store.add_event(self.robot, "response", body=noted)
        if not future.done():
            future.set_result(message)

    async def _on_service(self, kind: str, message: dict) -> None:
        to = message.get("to")
        service = to.get("service") if isinstance(to, dict) else None
        request_id = message.get("id")
        body = message.get("body")
        # The handler logs what it was told, as far as it is news.
        self._trace(logging.DEBUG, f"<- {kind} {service} id={request_id}", message)

        name = service if isinstance(service, str) else None
        if name not in _UNLOGGED:
            self._server.store.add_event(self.robot, kind, name, _redact(body))
        handler = SERVICES.get(name)
        if handler is None:
            self._say(logging.WARNING, "no such service: %r", service)
            reply = (404, None)
        else:
            reply = handler(self._server.store, self.robot, body)
        if reply is None or kind != "request":
            return
        if request_id is None:
            self._say(logging.WARNING, "cannot answer a request without an id")
            return
        code, body = reply
        response = {"type": "response", "id": request_id, "code": code}
        if body is not None:
            response["body"] = body
        await self._send_json(response, f"response {code} id={request_id}")

    async def _read(self, timeout: float) -> bytes:
        try:
            async with asyncio.timeout(timeout) as deadline:
                return await read_frame(self._reader, self._config.max_frame_size)
        except TimeoutError:
            if not deadline.expired():
                raise
            raise Disconnect(f"no frame received for {timeout:g}s") from None

    def _decode(self, payload: bytes) -> dict:
        try:
            message = json.loads(payload)
        except ValueError:
            raise Disconnect(f"invalid JSON in a {len(payload)} byte frame: {payload[:64]!r}", fault=True) from None
        if not isinstance(message, dict):
            raise Disconnect("frame is not a JSON object", fault=True)
        return message

    async def _send(self, payload: bytes) -> None:
        # The lock spans the drain so concurrent senders queue up behind a slow
        # robot instead of piling frames into the transport buffer.
        async with self._write_lock:
            self._writer.write(encode_frame(payload))
            await self._writer.drain()

    async def _send_json(self, message: dict, summary: str) -> None:
        self._trace(logging.DEBUG, f"-> {summary}", message)
        await self._send(json.dumps(message, separators=(",", ":")).encode())

    def _say(self, level: int, text: str, *args: object) -> None:
        log.log(level, "[%s] " + text, self.label, *args)

    def _trace(self, level: int, summary: str, message: dict) -> None:
        """Log a line about a message, followed from the debug level on by the message itself, on one line."""
        if not log.isEnabledFor(level):
            return
        if not log.isEnabledFor(logging.DEBUG):
            self._say(level, "%s", summary)
            return
        shown = message if log.isEnabledFor(TRACE) else _redact(message)
        self._say(level, "%s %s", summary, json.dumps(shown, separators=(",", ":"), ensure_ascii=False))
