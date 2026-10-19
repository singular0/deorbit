"""Command-line entry point: ``python -m deorbit``."""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .certs import DEFAULT_HOSTS, generate
from .config import DEFAULT_PATH, Config, ConfigError, load, local_address
from .mqtt import Mqtt
from .server import Server
from .store import StoreError
from .web import Web, WebError


async def _serve(config: Config) -> None:
    server = Server(config)
    web = Web(server) if config.web else None
    mqtt = Mqtt(server) if config.mqtt_host else None
    try:
        server.start()
        if web is not None:
            await web.start()
        if mqtt is not None:
            mqtt.start()  # it connects in the background, and keeps trying while the broker cannot be reached
        await server.serve_forever()
    finally:
        if mqtt is not None:
            await mqtt.stop()
        if web is not None:
            await web.stop()
        await server.stop()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="deorbit",
        description="Robot-facing Orbital protocol server. Prints every message it exchanges.",
    )
    parser.add_argument("-c", "--config", type=Path, metavar="FILE",
                        help=f"YAML settings file (default: {DEFAULT_PATH} in the current directory; "
                             "if that is absent, every setting takes its default)")
    args = parser.parse_args()

    # Only the default file may be missing: one that was asked for by name must exist.
    path = args.config
    if path is None and DEFAULT_PATH.exists():
        path = DEFAULT_PATH
    try:
        config = Config() if path is None else load(path)
    except ConfigError as exc:
        parser.error(str(exc))

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s.%(msecs)03d %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stdout,
    )
    log = logging.getLogger("deorbit")
    log.setLevel(logging.DEBUG if config.verbose else logging.INFO)
    if path is None:
        log.info("no %s in the current directory: using the default settings", DEFAULT_PATH)
    else:
        log.info("settings read from %s", path)

    missing = [file for file in (config.cert, config.key) if not file.exists()]
    if missing and not config.generate_certs:
        parser.error(f"{missing[0]} not found; create a development certificate with: python -m deorbit.certs")
    if len(missing) == 1:
        # Half a pair looks like a mistyped path, and generating would write over the half that is there.
        (present,) = {config.cert, config.key} - set(missing)
        parser.error(f"{missing[0]} not found; not generating a certificate because {present} exists")
    if missing:
        try:
            ca = generate(config.cert, config.key, DEFAULT_HOSTS)
        except OSError as exc:
            parser.error(f"cannot create a certificate at {config.cert}: {exc}")
        log.warning("generated a development certificate at %s; robots must trust %s", config.cert, ca)

    if config.web and not config.public_address:
        # Only "Bind a robot" in the web UI uses it, and that has no other address to point a robot at.
        config.public_address = local_address(config.host)
        if config.public_address:
            log.info('public_address is not set: detected %s, which "Bind a robot" points a robot at',
                     config.public_address)
        else:
            log.warning('public_address is not set and none was detected: '
                        '"Bind a robot" cannot point a robot at this server')

    try:
        asyncio.run(_serve(config))
    except (StoreError, WebError) as exc:
        parser.error(str(exc))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
