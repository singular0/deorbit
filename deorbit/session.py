"""One robot connection: login, heartbeats and message routing."""

import asyncio
import contextlib
import json
import logging
import textwrap
import time
import uuid
from typing import TYPE_CHECKING, Any

from .auth import LoginRejected, RobotId
from .framing import CLOSE, HEARTBEAT, FrameTooLarge, encode_frame, read_frame
from .services import SERVICES
from .store import now

if TYPE_CHECKING:
    from .server import Server

log = logging.getLogger(__name__)

# Signatures and map binaries stay out of the event log, and out of the console
# unless the ``full`` setting is on.
_REDACTED_KEYS = {"signature", "rank_binary", "real_binary", "track_binary"}
# Services whose messages are not added to the event log: the database already
# holds each robot's latest state.
_UNLOGGED = {"peer.state"}


class Disconnect(Exception):
    """Ends the session; the message becomes the logged disconnect reason."""


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
        # answer, since when, and the ability asked for. Requests from the
        # robot are answered inline, so that direction needs no bookkeeping.
        self._pending: dict[str, tuple[asyncio.Future, float, str]] = {}
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
        reason = "internal error"
        heartbeat = None
        try:
            await self._login()
            heartbeat = asyncio.create_task(self._heartbeat())
            reason = await self._receive()
        except (Disconnect, FrameTooLarge) as exc:
            reason = str(exc)
        except asyncio.IncompleteReadError as exc:
            reason = "connection closed by robot" + (" mid-frame" if exc.partial else "")
        except OSError as exc:
            reason = f"connection error: {describe(exc)}"
        except asyncio.CancelledError:
            reason = "server shutting down"
            raise
        except Exception:
            log.exception("[%s] session failed", self.label)
        finally:
            if heartbeat is not None:
                heartbeat.cancel()
            self._server.unregister(self)
            reason = self._close_reason or reason
            for future, *_ in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError(f"session closed: {reason}"))
            self._pending.clear()
            self._say(logging.INFO, "disconnected: %s", reason)
            if self.robot is not None:  # it had logged in, so the log holds a login that this ends
                self._server.store.add_event(self.robot, "disconnect", body={"reason": reason})
            self._writer.close()
            with contextlib.suppress(OSError):
                await self._writer.wait_closed()

    def close(self, reason: str) -> None:
        """Drop the connection without waiting for the robot."""
        self._close_reason = reason
        self._writer.transport.abort()

    async def call(self, ability: str, params: dict | None = None, *, timeout: float = 30.0) -> dict:
        """Invoke a robot ability and return the robot's response message.

        Raises ``TimeoutError`` if the robot does not answer in time and
        ``ConnectionError`` if the session closes first. The event log gets
        the call, and the response once there is one.
        """
        call_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = (future, time.monotonic(), ability)
        try:
            body = {**(params or {}), "ability": ability}
            self._server.store.add_event(self.robot, "call", body=_redact(body))
            await self._send_json({"type": "request", "id": call_id, "body": body}, f"request {ability} id={call_id}")
            async with asyncio.timeout(timeout):
                return await future
        finally:
            self._pending.pop(call_id, None)

    async def _login(self) -> None:
        login = self._decode(await self._read(self._config.login_timeout))
        self._trace("<-", "login", login)
        authenticator = self._server.authenticator
        try:
            self.robot = authenticator.authenticate(login)
        except LoginRejected as exc:
            await self._send_json({"code": exc.code}, f"login response {exc.code}")
            raise Disconnect(f"login rejected: {exc}") from None
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
            self._trace("<-", f"message of unknown type {kind!r}", message, logging.WARNING)

    def _on_response(self, message: dict) -> None:
        call_id = message.get("id")
        pending = self._pending.pop(call_id, None) if isinstance(call_id, str) else None
        summary = f"response {message.get('code')} id={call_id}"
        if pending is None:
            self._trace("<-", f"{summary} (no such call pending)", message, logging.WARNING)
            return
        future, started, ability = pending
        self._trace("<-", f"{summary} after {(time.monotonic() - started) * 1000:.0f} ms", message)
        # The ability is noted with it: a response names only the ID of its call.
        noted = {"ability": ability, "code": message.get("code"), "body": _redact(message.get("body"))}
        self._server.store.add_event(self.robot, "response", body=noted)
        if not future.done():
            future.set_result(message)

    async def _on_service(self, kind: str, message: dict) -> None:
        to = message.get("to")
        service = to.get("service") if isinstance(to, dict) else None
        request_id = message.get("id")
        body = message.get("body")
        self._trace("<-", f"{kind} {service} id={request_id}", message)

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
            raise Disconnect(f"invalid JSON in a {len(payload)} byte frame: {payload[:64]!r}") from None
        if not isinstance(message, dict):
            raise Disconnect("frame is not a JSON object")
        return message

    async def _send(self, payload: bytes) -> None:
        # The lock spans the drain so concurrent senders queue up behind a slow
        # robot instead of piling frames into the transport buffer.
        async with self._write_lock:
            self._writer.write(encode_frame(payload))
            await self._writer.drain()

    async def _send_json(self, message: dict, summary: str) -> None:
        self._trace("->", summary, message)
        await self._send(json.dumps(message, separators=(",", ":")).encode())

    def _say(self, level: int, text: str, *args: object) -> None:
        log.log(level, "[%s] " + text, self.label, *args)

    def _trace(self, arrow: str, summary: str, message: dict, level: int = logging.INFO) -> None:
        if not log.isEnabledFor(level):
            return
        shown = message if self._config.full else _redact(message)
        text = json.dumps(shown, indent=2, ensure_ascii=False)
        log.log(level, "[%s] %s %s\n%s", self.label, arrow, summary, textwrap.indent(text, "    "))
