"""TLS listener and the registry of live robot sessions."""

import asyncio
import logging
import socket
import ssl

from .auth import Authenticator, RobotId, delete_key, load_keys
from .config import Config
from .session import Session, describe
from .store import Store

log = logging.getLogger(__name__)

# How long a closing connection waits for the robot's TLS close_notify.
_TLS_SHUTDOWN_TIMEOUT = 5.0


class Server:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.sessions: dict[RobotId, Session] = {}
        keys = load_keys(config.keys) if config.keys is not None else None
        self.authenticator = Authenticator(keys, config.max_clock_skew)
        self._ssl = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self._ssl.load_cert_chain(config.cert, config.key)
        self._listener: socket.socket | None = None
        self._connections: set[asyncio.Task] = set()
        # Every session until it has ended, with the task it runs in. One that a
        # newer login replaced is no longer in ``sessions`` and still in here.
        self._running: dict[Session, asyncio.Task] = {}
        if keys is None:
            log.warning("no robot keys configured: login signatures are NOT verified")
        else:
            log.info("%d robot key(s) loaded from %s", len(keys), config.keys)
        # Opened last, so that nothing above can fail and leave it open.
        self.store = Store(config.database)

    @property
    def port(self) -> int:
        return self._listener.getsockname()[1]

    def start(self) -> None:
        self._listener = socket.create_server((self.config.host, self.config.port))
        self._listener.setblocking(False)
        log.info("listening on %s:%d", self.config.host, self.port)

    async def serve_forever(self) -> None:
        """Accept connections until cancelled. Call ``stop()`` afterwards."""
        loop = asyncio.get_running_loop()
        while True:
            try:
                sock, address = await loop.sock_accept(self._listener)
            except OSError as exc:
                log.error("accept failed: %s", exc)
                await asyncio.sleep(1)
                continue
            task = loop.create_task(self._handle(sock, address))
            self._connections.add(task)
            task.add_done_callback(self._connections.discard)

    async def stop(self) -> None:
        if self._listener is not None:
            self._listener.close()
        for task in self._connections:
            task.cancel()
        await asyncio.gather(*self._connections, return_exceptions=True)
        self.store.close()

    def register(self, session: Session) -> None:
        """Make ``session`` the robot's only live session, dropping any older one."""
        older = self.sessions.get(session.robot)
        self.sessions[session.robot] = session
        if older is not None:
            older.close("replaced by a newer login")

    def unregister(self, session: Session) -> None:
        if self.sessions.get(session.robot) is session:
            del self.sessions[session.robot]

    async def delete(self, robot: RobotId) -> bool:
        """Forget a robot: remove its key, end its sessions and delete all that the database holds of it.

        Says whether the database now holds nothing of it. A key file that
        cannot be removed is an ``OSError``, raised before anything else is done.
        """
        if self.config.keys is not None:
            # First, so that the robot cannot log in again while its sessions end.
            delete_key(self.config.keys, robot)
            self.authenticator.forget(robot)
        # A session writes to the database until it has ended, its disconnect
        # last, so the rows are deleted only then. Without keys the robot may
        # have logged in again by that time, which is what the loop is for.
        while ending := [(session, task) for session, task in self._running.items() if session.robot == robot]:
            for session, _ in ending:
                session.close("robot deleted")
            await asyncio.wait([task for _, task in ending])
        # Nothing was awaited since no session of the robot's was found, so none has begun.
        return self.store.delete(robot)

    async def _handle(self, sock: socket.socket, address: tuple[str, int]) -> None:
        # The handshake is driven by hand rather than through
        # asyncio.start_server(ssl=...), which swallows handshake failures:
        # a robot that rejects our certificate would never show up in the log.
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(loop=loop)
        protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
        try:
            # No Nagle, so a small frame or the tail of a large one is not held back for the robot's ACK.
            # asyncio sets this only on a socket whose proto is TCP, and create_server's sockets have 0.
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            transport, _ = await loop.connect_accepted_socket(
                lambda: protocol, sock, ssl=self._ssl, ssl_shutdown_timeout=_TLS_SHUTDOWN_TIMEOUT
            )
        except OSError as exc:
            log.warning("[%s:%d] TLS handshake failed: %s", *address[:2], describe(exc))
            return
        writer = asyncio.StreamWriter(transport, protocol, reader, loop)
        tls = transport.get_extra_info("ssl_object")
        log.debug("[%s:%d] connected, %s %s", *address[:2], tls.version(), tls.cipher()[0])
        session = Session(self, reader, writer, address)
        self._running[session] = asyncio.current_task()
        try:
            await session.run()
        finally:
            del self._running[session]
