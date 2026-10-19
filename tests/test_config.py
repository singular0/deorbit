"""Settings file tests: what ``load`` accepts and rejects, and which file the entry point reads."""

import contextlib
import dataclasses
import io
import ipaddress
import logging
import socket
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography import x509

from deorbit import __main__ as cli
from deorbit.certs import DEFAULT_HOSTS
from deorbit.config import Config, ConfigError, load, local_address


class ConfigTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def write(self, text: str, name: str = "deorbit.yml") -> Path:
        path = self.dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path


class LoadTests(ConfigTestCase):
    def test_empty_file_keeps_defaults(self) -> None:
        defaults = Config()
        self.assertEqual(
            load(self.write("")),
            dataclasses.replace(
                defaults,
                cert=self.dir / defaults.cert,
                key=self.dir / defaults.key,
                database=self.dir / defaults.database,
            ),
        )

    def test_every_setting(self) -> None:
        config = load(self.write(
            "host: 127.0.0.1\n"
            "port: 4000\n"
            "cert: tls/server.crt\n"
            "key: tls/server.key\n"
            "generate_certs: false\n"
            "keys: robots\n"
            "database: var/robots.db\n"
            "web: false\n"
            "web_host: 127.0.0.1\n"
            "web_port: 8000\n"
            "public_address: 192.168.1.50\n"
            "mqtt_host: broker.lan\n"
            "mqtt_port: 8883\n"
            "mqtt_username: deorbit\n"
            "mqtt_password: secret\n"
            "mqtt_topic: home/robots\n"
            "mqtt_discovery_prefix: ha\n"
            "timezone: Europe/London\n"
            "heartbeat_interval: 5\n"
            "idle_timeout: 12.5\n"
            "login_timeout: 3\n"
            "max_frame_size: 1024\n"
            "max_clock_skew: 0\n"
            "full: true\n"
            "verbose: true\n"
        ))
        self.assertEqual(
            config,
            Config(
                cert=self.dir / "tls/server.crt",
                key=self.dir / "tls/server.key",
                generate_certs=False,
                host="127.0.0.1",
                port=4000,
                keys=self.dir / "robots",
                database=self.dir / "var/robots.db",
                web=False,
                web_host="127.0.0.1",
                web_port=8000,
                public_address="192.168.1.50",
                mqtt_host="broker.lan",
                mqtt_port=8883,
                mqtt_username="deorbit",
                mqtt_password="secret",
                mqtt_topic="home/robots",
                mqtt_discovery_prefix="ha",
                timezone="Europe/London",
                heartbeat_interval=5.0,
                idle_timeout=12.5,
                login_timeout=3.0,
                max_frame_size=1024,
                max_clock_skew=0.0,
                full=True,
                verbose=True,
            ),
        )
        self.assertIsInstance(config.heartbeat_interval, float)

    def test_empty_value_keeps_default(self) -> None:
        config = load(self.write("port:\nkeys:\ntimezone:\n"))
        self.assertEqual(config.port, Config().port)
        self.assertIsNone(config.keys)
        self.assertEqual(config.timezone, Config().timezone)

    def test_absolute_and_home_paths_are_not_moved(self) -> None:
        config = load(self.write("cert: /etc/deorbit/server.crt\nkeys: ~/robots\n"))
        self.assertEqual(config.cert, Path("/etc/deorbit/server.crt"))
        self.assertEqual(config.keys, Path.home() / "robots")

    def test_rejected(self) -> None:
        cases = {
            "prot: 3443": "unknown setting 'prot'",
            "port: '3443'": "port must be an integer",
            "port: 34.5": "port must be an integer",
            "port: true": "port must be an integer",
            "full: 1": "full must be true or false",
            "host: 127": "host must be a string",
            "keys: 5": "keys must be a path",
            "heartbeat_interval: fast": "heartbeat_interval must be a number",
            "heartbeat_interval: true": "heartbeat_interval must be a number",
            "timezone: Mars/Olympus": "timezone must be an IANA time zone name",
            "mqtt_password: 1234": "mqtt_password must be a string",
            "mqtt_topic: deorbit/+": "mqtt_topic must be MQTT topic levels without wildcards, not 'deorbit/+'",
            "mqtt_topic: '#'": "mqtt_topic must be MQTT topic levels without wildcards",
            "mqtt_topic: ''": "mqtt_topic must be MQTT topic levels without wildcards, not ''",
            "mqtt_topic: home//robots": "mqtt_topic must be MQTT topic levels without wildcards",
            "mqtt_discovery_prefix: /homeassistant": "mqtt_discovery_prefix must be MQTT topic levels without wildcards",
            "- port": "expected a mapping",
            "port: [3443": "not valid YAML",
        }
        for text, problem in cases.items():
            with self.subTest(text):
                with self.assertRaises(ConfigError) as caught:
                    load(self.write(text))
                self.assertIn(problem, str(caught.exception))

    def test_missing_file(self) -> None:
        with self.assertRaisesRegex(ConfigError, "cannot read .*nowhere.yml"):
            load(self.dir / "nowhere.yml")


class LocalAddressTests(unittest.TestCase):
    def test_the_one_address_listened_on(self) -> None:
        with mock.patch.object(socket, "socket") as made:
            self.assertEqual(local_address("192.168.1.10"), "192.168.1.10")
            self.assertEqual(local_address("fd00::10"), "fd00::10")
            # Only this machine reaches the first two, and a name is not looked up.
            for host in ("127.0.0.1", "::1", "localhost", "server.lan", ""):
                with self.subTest(host):
                    self.assertEqual(local_address(host), "")
        made.assert_not_called()

    def test_every_address_listened_on(self) -> None:
        for host in ("0.0.0.0", "::"):
            with self.subTest(host), mock.patch.object(socket, "socket") as made:
                probe = made.return_value.__enter__.return_value
                probe.getsockname.return_value = ("192.168.1.23", 50000)
                self.assertEqual(local_address(host), "192.168.1.23")
                made.assert_called_once_with(socket.AF_INET, socket.SOCK_DGRAM)
                # It asks for a route and sends nothing.
                self.assertEqual([call[0] for call in probe.method_calls], ["connect", "getsockname"])

    def test_no_address_found(self) -> None:
        for found in ("127.0.0.1", "0.0.0.0", OSError("Network is unreachable")):
            with self.subTest(found), mock.patch.object(socket, "socket") as made:
                probe = made.return_value.__enter__.return_value
                if isinstance(found, OSError):
                    probe.connect.side_effect = found
                else:
                    probe.getsockname.return_value = (found, 50000)
                self.assertEqual(local_address("0.0.0.0"), "")

    def test_on_this_machine(self) -> None:
        # Whatever network the tests run on, or none: an address robots could use, or nothing.
        found = local_address("0.0.0.0")
        if found:
            self.assertFalse(ipaddress.ip_address(found).is_loopback)


class CommandLineTests(ConfigTestCase):
    """``main`` runs in the temporary directory, with the server it would start stubbed out."""

    def setUp(self) -> None:
        super().setUp()
        # The machine the tests run on has whatever address it has, so `main` finds none unless a test says so.
        self.detect = mock.Mock(return_value="")

    def main(self, *argv: str) -> Config:
        """Run ``deorbit`` and return the settings it goes on to serve with."""
        log = logging.getLogger("deorbit")
        self.addCleanup(log.setLevel, log.level)
        with (
            contextlib.chdir(self.dir),
            mock.patch("sys.argv", ["deorbit", *argv]),
            # Left in place, the console handler would print the rest of the test run.
            mock.patch.object(logging, "basicConfig"),
            mock.patch.object(cli, "_serve") as serve,
            mock.patch.object(cli, "local_address", self.detect),
        ):
            cli.main()
        (config,) = serve.call_args.args
        return config

    def error(self, *argv: str) -> str:
        """Run ``deorbit`` and return the error it exits with instead of serving."""
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit):
            self.main(*argv)
        return stderr.getvalue()

    def tree(self) -> dict[str, str]:
        """Every file in the temporary directory and its content."""
        return {str(path.relative_to(self.dir)): path.read_text() for path in self.dir.rglob("*") if path.is_file()}

    def test_default_file_is_read(self) -> None:
        self.write("cert: from-default-file.crt\ngenerate_certs: false\n")
        self.assertIn("from-default-file.crt not found", self.error())

    def test_default_file_may_be_absent(self) -> None:
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(self.main(), Config())
        self.assertIn("using the default settings", logs.output[0])

    def test_named_file_is_read_instead(self) -> None:
        self.write("cert: from-default-file.crt\ngenerate_certs: false\n")
        self.write("cert: tls/server.crt\ngenerate_certs: false\n", "conf/other.yml")
        self.assertIn("conf/tls/server.crt not found", self.error("--config", "conf/other.yml"))

    def test_named_file_must_exist(self) -> None:
        self.assertIn("cannot read other.yml", self.error("-c", "other.yml"))

    def test_invalid_file(self) -> None:
        self.write("port: robot\n")
        self.assertIn("port must be an integer", self.error())

    def test_former_options_are_gone(self) -> None:
        self.assertIn("unrecognized arguments", self.error("--port", "4000"))

    def test_missing_certificate_is_generated(self) -> None:
        self.write("cert: tls/server.crt\nkey: private/server.key\n")
        with self.assertLogs("deorbit", "WARNING") as logs:
            config = self.main()
        self.assertIn("robots must trust tls/ca.crt", logs.output[0])
        self.assertEqual(
            set(self.tree()),
            {"deorbit.yml", "tls/server.crt", "tls/ca.crt", "private/server.key", "private/ca.key"},
        )
        # The pair belongs together, is signed by that CA and names the hosts robots connect to.
        cert_path, key_path = self.dir / config.cert, self.dir / config.key
        ssl.create_default_context(ssl.Purpose.CLIENT_AUTH).load_cert_chain(cert_path, key_path)
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        cert.verify_directly_issued_by(x509.load_pem_x509_certificate((self.dir / "tls/ca.crt").read_bytes()))
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        self.assertEqual(names.get_values_for_type(x509.DNSName), DEFAULT_HOSTS)

    def test_existing_certificate_is_kept(self) -> None:
        self.write("installed by hand", "certs/server.crt")
        self.write("installed by hand", "certs/server.key")
        before = self.tree()
        self.main()
        self.assertEqual(self.tree(), before)

    def test_certificate_without_key_is_kept(self) -> None:
        self.write("installed by hand", "certs/server.crt")
        before = self.tree()
        self.assertIn("certs/server.key not found; not generating", self.error())
        self.assertEqual(self.tree(), before)

    def test_key_without_certificate_is_kept(self) -> None:
        self.write("installed by hand", "certs/server.key")
        before = self.tree()
        self.assertIn("certs/server.crt not found; not generating", self.error())
        self.assertEqual(self.tree(), before)

    def test_generation_can_be_turned_off(self) -> None:
        self.write("generate_certs: false\n")
        before = self.tree()
        self.assertIn("certs/server.crt not found", self.error())
        self.assertEqual(self.tree(), before)

    def test_certificate_cannot_be_written(self) -> None:
        self.write("", "certs")  # a file where the directory has to go
        self.assertIn("cannot create a certificate at certs/server.crt", self.error())

    def test_missing_address_is_detected(self) -> None:
        self.write("host: 192.168.1.10\ngenerate_certs: false\n")
        self.write("installed by hand", "certs/server.crt")
        self.write("installed by hand", "certs/server.key")
        self.detect.return_value = "192.168.1.23"
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(self.main().public_address, "192.168.1.23")
        self.detect.assert_called_once_with("192.168.1.10")
        self.assertIn("public_address is not set: detected 192.168.1.23", logs.output[-1])

    def test_address_that_is_not_found(self) -> None:
        self.write("generate_certs: false\n")
        self.write("installed by hand", "certs/server.crt")
        self.write("installed by hand", "certs/server.key")
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(self.main().public_address, "")
        self.detect.assert_called_once_with("0.0.0.0")
        self.assertIn("public_address is not set and none was detected", logs.output[-1])

    def test_address_that_is_set_is_kept(self) -> None:
        self.write("public_address: 10.0.0.5\ngenerate_certs: false\n")
        self.write("installed by hand", "certs/server.crt")
        self.write("installed by hand", "certs/server.key")
        with self.assertLogs("deorbit", "INFO") as logs:
            self.assertEqual(self.main().public_address, "10.0.0.5")
        self.detect.assert_not_called()
        self.assertNotIn("public_address", "".join(logs.output))

    def test_address_is_not_detected_without_the_web_ui(self) -> None:
        self.write("web: false\ngenerate_certs: false\n")
        self.write("installed by hand", "certs/server.crt")
        self.write("installed by hand", "certs/server.key")
        self.assertEqual(self.main().public_address, "")
        self.detect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
