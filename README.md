# deorbit

A self-hosted replacement for the Neato cloud, for the Neato D8, D9 and D10
robot vacuums. Your robot connects to your own server instead of Neato's, which
is gone, and a web page brings back part of the MyNeato app: the robot's status,
starting and stopping cleanings, the schedule, maps, floor plans, zones and
no-go lines.

This is early work. The [features table](#features) shows what works.

## Background

Vorwerk closed Neato Robotics in 2023 and promised to keep its cloud running for
five more years. In October 2025 it announced that the cloud would be switched
off about three years early, citing security and compliance requirements
([9to5Mac](https://9to5mac.com/2025/10/27/neato-cloud-shutdown-is-the-latest-example-of-a-failed-company-bricking-smart-products/),
[heise](https://heise.de/-11206228)). That ended the MyNeato app, and with it
remote control, schedules, maps, zones, smart-home links and firmware updates.
All that is left is the start button on the robot.

Older Neato robots (Botvac Connected, D3 to D7) can be controlled through a
debug port, as projects like neato-connected do. The D8, D9 and D10 can't: they
do everything through the cloud, over a protocol called Orbital. The robot keeps
one TLS connection open to the server named in its configuration, and accepts
only a server whose certificate it was told to trust.

deorbit provides the two things these robots need:

1. **A server that speaks Orbital.** It is a clean-room implementation, written
   from a specification of the protocol alone.
2. **A way to point the robot at it.** "Bind a robot" on the web page connects
   to the robot once over USB and gives it your server's address and
   certificate.

From then on the robot talks to your server over your home network, and what it
reports is stored in a database on your machine.

## Features

✅ works · 🟡 works in part · ❌ not there

| Feature | Status | Notes |
| --- | --- | --- |
| Robots connect to your server | ✅ | |
| Bind a robot over USB from the web page | 🟡 | Chrome or Edge only, and it needs a file that is not in this repository: see [Binding a robot](#binding-a-robot). |
| Put a robot on your Wi-Fi | ❌ | The robot must already be on your Wi-Fi. |
| Let in only robots whose key you have | ✅ | Off by default: see [Robot keys](#robot-keys). |
| Robot list and status | ✅ | |
| Start, pause, resume and cancel a cleaning | ✅ | |
| Return to base | ✅ | |
| Cleaning schedule | ✅ | |
| Maps of past cleanings | ✅ | |
| Floor plans | ✅ | |
| Zones and no-go lines | 🟡 | Only simple rectangular shaped zones are supported. |
| History | ✅ | Connections, messages, errors and the commands sent. |
| Notifications | 🟡 | Shown in the history only; nothing goes to a phone or by e-mail. |
| Name robots and maps | ✅ | Names are kept on the server only. |
| Delete a robot and all its data | ✅ | |
| Robot settings | 🟡 | No sounds or factory reset. |
| Find the robot by sound | ✅ | |
| Firmware updates | ❌ | Firmware updates will not be supported. |
| MyNeato app | ❌ | The web page replaces the app. |
| Home Assistant and other integrations | ❌ | |
| Login and HTTPS for the web page | ❌ | Anyone who can reach the page controls the robots: see [Web page security](#web-page-security). |
| Older robots (Botvac Connected, D3 to D7) | ❌ | |

## Settings

Settings are read from `deorbit.yml` when the server starts, so restart it after
a change. All of them are optional; the `deorbit.yml` in this repository lists
them at their defaults. A misspelt setting or a wrong value stops the server
with a message that names it. Relative paths start at the folder that holds
`deorbit.yml`, and `~` is your home folder.

| Setting | Default | Meaning |
| --- | --- | --- |
| `public_address` | detected | The IP address robots reach the server at: see [Server address](#server-address). |
| `timezone` | this machine's | The time zone robots are given, such as `Europe/Berlin`. |
| `web` | `true` | Serve the web page. |
| `web_host` | `0.0.0.0` | IPv4 address the web page listens on. |
| `web_port` | `8080` | Port of the web page. |
| `host` | `0.0.0.0` | IPv4 address robots connect to. |
| `port` | `3443` | Port robots connect to. Robots always use 3443. |
| `cert` | `certs/server.crt` | The server's TLS certificate chain (PEM). |
| `key` | `certs/server.key` | The server's TLS private key (PEM). |
| `generate_certs` | `true` | Create a certificate authority and the server's certificate when `cert` and `key` are both missing. |
| `keys` | empty | Folder of robots' public keys. Empty lets any robot in: see [Robot keys](#robot-keys). |
| `database` | `data/deorbit.db` | The SQLite file holding everything the server keeps. Created if missing. |
| `heartbeat_interval` | `30` | Seconds between heartbeats to a robot. A robot hangs up after 70 seconds of silence. |
| `idle_timeout` | `150` | Seconds before a silent robot is dropped. |
| `login_timeout` | `30` | Seconds a new connection has to log in. |
| `max_frame_size` | `16777216` | Largest message a robot may send, in bytes. |
| `max_clock_skew` | `300` | Seconds a robot's clock may be off, when `keys` is set. |
| `full` | `false` | Log signatures and map data in full, not just their length. |
| `verbose` | `false` | Also log heartbeats. |

### Server address

`public_address` is where your robots connect: the server machine's IP address
on your network, such as `192.168.1.20`. Binding writes it into the robot, so it
must not change. Give the machine a fixed address or a reservation in your
router; if it changes anyway, bind the robots again.

Left empty, the server guesses the address at startup and logs its guess. Set
it yourself in a container, where the guess is the container's own address, and
on a machine with several networks or a VPN.

### Certificates

On its first start the server creates its own certificate authority and
certificate in `certs/`. Binding installs `certs/ca.crt` on the robot, which is
why the robot trusts your server. Back up `certs/`: if it is lost, a new
authority is created and every robot has to be bound again. `ca.key` and
`server.key` are secrets.

### Web page security

The web page has no login and uses plain HTTP. Anyone who can reach it can
command your robots, change their schedules and settings, and delete them. Keep
it on a network you trust, and don't open either port to the internet; neither
needs to be reachable from outside your home.

`web_host: 127.0.0.1` limits the page to the server machine, and `web: false`
turns it off. A reverse proxy must pass on the `Host` header, or the page's
buttons are refused.

### Robot keys

By default any robot that reaches the server is let in. Set `keys` to a folder
holding each robot's RSA public key as `<vendor>/<board serial>.pem`
(upper and lower case don't matter), and only robots that sign their login with
that key get in. The keys are read at startup. Logins must then also be within
`max_clock_skew` seconds of the server's clock and can't be replayed;
`max_clock_skew: 0` turns both checks off.

Deleting a robot on the web page deletes its key file, so the robot is refused
from then on.

## Running the server in a container

You need:

- an always-on machine with Docker Compose that your robots can reach over
  Wi-Fi
- Chrome or Edge on a computer you can plug the robot into, for binding

### Starting the server

1. Put this repository on the machine.
2. Set the two things a container can't detect, in `deorbit.yml`:

   ```yaml
   public_address: 192.168.1.20   # this machine's address on your network
   timezone: Europe/Berlin        # otherwise robots are told UTC
   ```

3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://<this machine's address>:8080`.

`deorbit.yml`, `certs/` and `data/` stay in this folder, outside the container,
so they survive it. Port 3443 is for robots and 8080 for the web page.

- To keep the web page to this machine, change its port line in
  `docker-compose.yml` to `"127.0.0.1:8080:8080"`, and leave `web_host` at
  `0.0.0.0`.
- To check robot keys, set `keys: keys` and uncomment the `keys` line in
  `docker-compose.yml`. It mounts the folder read-only, so a robot with a key
  can't be deleted on the web page; remove `:ro` to allow that.

### Binding a robot

The robot must already be on your Wi-Fi.

1. Open the web page in Chrome or Edge at `http://localhost:8080`. Browsers
   allow USB only on `localhost` or HTTPS, and elsewhere the **Bind a robot**
   button is greyed out. If the server is on another machine, forward the port
   first: `ssh -L 8080:localhost:8080 user@that-machine`.
2. Click **Bind a robot**. Check that the address it shows is your
   `public_address`; if not, fix the setting and restart the server.
3. Plug the robot in with a USB cable, click **Configure robot**, and choose
   the robot when the browser asks.
4. When it says the robot is set up, unplug it. The robot shows up in the list
   once it next connects.

Binding changes three files on the robot: its hosts file and vendor settings,
so it looks for its cloud at your server, and the certificate it trusts. No
copy of the old files is kept.

Binding needs `deorbit/static/mtp-fs.js`, which is not in this repository (see
[Implementation details](#implementation-details)). Put it in that folder before
building the image. Without it, everything but binding works.

If a bound robot doesn't show up, check the log:

- `TLS handshake failed`: the robot refused the certificate, because it was
  bound to a different `certs/`. Bind it again.
- Nothing from the robot at all: it can't reach the server. Check
  `public_address`, the robot's Wi-Fi, and that port 3443 isn't blocked.

### Day to day

```sh
docker compose logs -f          # what the server and the robots are saying
docker compose restart          # after changing deorbit.yml
docker compose down             # stop the server
docker compose up -d --build    # after updating this repository
```

To back up, copy `deorbit.yml`, `certs/` and `data/`.

Without Docker, on Python 3.11 or later: run `pip install -e .`, then
`python -m deorbit` in the folder with `deorbit.yml`.

## Implementation details

1. **The code is 100% "vibe-coded".** Every line in this repository was written
   by an AI coding agent working from prompts, and none of it by hand. Read it,
   and rely on it, with that in mind.
2. **`mtp-fs.js` is withheld from the source.** Binding a robot over USB needs
   the file `deorbit/static/mtp-fs.js`, and it is not in this repository,
   because it contains an exploit that the [Vacuula](https://github.com/vacuula)
   team is in the process of disclosing to Vorwerk. Everything but "Bind a
   robot" works without it.

## License

deorbit is free software under the GNU General Public License, version 3. You
may use, change and share it under the terms in [LICENSE](LICENSE). It comes
with no warranty.
