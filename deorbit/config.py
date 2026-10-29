"""Server settings and the YAML file they are read from."""

import ipaddress
import logging
import os
import socket
import typing
import zoneinfo
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_PATH = Path("deorbit.yml")

# Below DEBUG: what debug logs, with signatures and binaries in full.
TRACE = 5
logging.addLevelName(TRACE, "TRACE")
# The values of ``log_level``, most quiet first, and the level each sets.
LOG_LEVELS = {"error": logging.ERROR, "warning": logging.WARNING, "info": logging.INFO, "debug": logging.DEBUG, "trace": TRACE}

# How an error message describes the value a setting of each type expects.
_EXPECTED = {Path: "a path", str: "a string", int: "an integer", float: "a number", bool: "true or false"}


class ConfigError(Exception):
    """The settings file cannot be read or holds something invalid."""


def local_timezone() -> str:
    """The host's IANA zone, which is most likely the robot's too."""
    name = os.path.realpath("/etc/localtime").partition("zoneinfo/")[2]
    return name if name in zoneinfo.available_timezones() else "UTC"


def local_address(host: str) -> str:
    """The address robots on the network most likely reach a server listening on ``host`` at, or "" for none found."""
    try:
        bound = ipaddress.ip_address(host)
    except ValueError:
        return ""  # a name, and which of this machine's addresses it stands for is not looked up
    if not bound.is_unspecified:
        # The server listens on this address alone, which only this machine reaches if it is the loopback.
        return "" if bound.is_loopback else str(bound)
    # It listens on every address, so the one this machine would send from to
    # another network. Connecting a UDP socket sends nothing: it only has the
    # system choose a route, here to an address that is set aside for examples.
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            found = ipaddress.ip_address(probe.getsockname()[0])
    except (OSError, ValueError):
        return ""  # no network to route to
    return "" if found.is_loopback or found.is_unspecified else str(found)


@dataclass
class Config:
    cert: Path = Path("certs/server.crt")
    key: Path = Path("certs/server.key")
    generate_certs: bool = True  # create a development certificate when cert and key are both missing
    host: str = "0.0.0.0"
    port: int = 3443
    keys: Path | None = None  # robot public keys; None disables signature checks
    database: Path = Path("data/deorbit.db")  # SQLite file of each robot's last state, heartbeat time, events, maps and name
    web: bool = True  # serve the web UI, which has no authentication
    web_host: str = "0.0.0.0"
    web_port: int = 8080
    # Host or IP that robots on the network reach this server at. The web UI's
    # "Bind a robot" writes it into a robot's hosts file for orbital.deorbit. Empty:
    # `main` looks for one at startup (`local_address`), and where it finds none
    # "Bind a robot" has nothing to write.
    public_address: str = ""
    # Home Assistant, through the MQTT broker it uses: empty for none. The robots
    # are announced to it by MQTT discovery, and it sends commands back.
    mqtt_host: str = ""
    mqtt_port: int = 1883
    mqtt_username: str = ""  # empty: connect without logging in
    mqtt_password: str = ""
    mqtt_topic: str = "deorbit"  # what the topics of the robots start with
    mqtt_discovery_prefix: str = "homeassistant"  # where Home Assistant looks for devices
    timezone: str = field(default_factory=local_timezone)  # IANA name sent to robots at login
    heartbeat_interval: float = 30.0
    idle_timeout: float = 150.0  # robots send a heartbeat every 60 seconds
    login_timeout: float = 30.0
    max_frame_size: int = 16 * 1024 * 1024
    max_clock_skew: float = 300.0
    log_level: str = "info"  # one of LOG_LEVELS, for the server's own loggers


def _kind(hint: object) -> type:
    """The concrete type behind a field annotation such as ``Path | None``."""
    return next((arg for arg in typing.get_args(hint) if arg is not type(None)), hint)


def load(path: Path) -> Config:
    """Read settings from a YAML mapping keyed by ``Config`` field name.

    A setting that is absent or left empty keeps its default. Relative paths,
    defaults included, start at the file's directory rather than the working
    directory, so a file means the same wherever the server is started from.
    """
    try:
        with path.open("rb") as stream:
            document = yaml.safe_load(stream)
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc.strerror or exc}") from exc
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} is not valid YAML: {exc}") from exc
    if document is None:  # an empty file
        document = {}
    if not isinstance(document, dict):
        raise ConfigError(f"{path}: expected a mapping of settings")

    kinds = {name: _kind(hint) for name, hint in typing.get_type_hints(Config).items()}
    settings = {}
    for name, value in document.items():
        kind = kinds.get(name)
        if kind is None:
            raise ConfigError(f"{path}: unknown setting {name!r}")
        if value is None:
            continue
        if kind is Path and isinstance(value, str):
            # No shell stands between this file and us to expand "~".
            settings[name] = Path(os.path.expanduser(value))
        elif kind is float and type(value) is int:
            settings[name] = float(value)
        elif type(value) is kind:  # exact, so that a YAML boolean is not taken for an integer
            settings[name] = value
        else:
            raise ConfigError(f"{path}: {name} must be {_EXPECTED[kind]}, not {value!r}")

    config = Config(**settings)
    if config.log_level not in LOG_LEVELS:
        raise ConfigError(f"{path}: log_level must be one of {', '.join(LOG_LEVELS)}, not {config.log_level!r}")
    if config.timezone not in zoneinfo.available_timezones():
        raise ConfigError(f"{path}: timezone must be an IANA time zone name, not {config.timezone!r}")
    for name in ("mqtt_topic", "mqtt_discovery_prefix"):
        # Each is the start of a topic that is subscribed to, where these would be wildcards or empty levels.
        topic = getattr(config, name)
        if not topic or "+" in topic or "#" in topic or "" in topic.split("/"):
            raise ConfigError(f"{path}: {name} must be MQTT topic levels without wildcards, not {topic!r}")
    for name, kind in kinds.items():
        if kind is Path and getattr(config, name) is not None:
            setattr(config, name, path.parent / getattr(config, name))
    return config
