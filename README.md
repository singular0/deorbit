# deorbit

A replacement for the Neato cloud that you run yourself, for the Neato D8, D9
and D10 robot vacuums. Your robot connects to it instead of to Neato's servers,
which are gone, and a web page gives back part of what the MyNeato app did:
seeing what the robot is doing, starting and stopping a cleaning, sending the
robot back to its base, its schedule and its maps.

This is early work, and much of what the app did is still missing. The
[features table](#features) says what works.

## Background

### The shutdown

Neato Robotics made robot vacuums until 2023, when Vorwerk, its owner since
2017, closed the company. Vorwerk said then that Neato's cloud would keep
running for five more years. In October 2025 it announced that the cloud was
being switched off after all, about three years early, saying that the old
systems could no longer be run to current security and compliance requirements
([9to5Mac](https://9to5mac.com/2025/10/27/neato-cloud-shutdown-is-the-latest-example-of-a-failed-company-bricking-smart-products/),
[heise](https://heise.de/-11206228)).

For owners that ended the MyNeato app and everything that went through it:

- starting, pausing or stopping a cleaning from a phone
- setting a cleaning schedule
- maps, zones and no-go lines
- voice assistants and other smart-home links
- firmware updates

What is left is the button on the robot, which starts a cleaning of the whole
house.

### Why the D8, D9 and D10 are the hard ones

Neato's older Wi-Fi robots (the Botvac Connected and the D3 to D7) have a debug
port that takes commands. Community projects such as neato-connected attach a
small Wi-Fi board to it and control the robot with no cloud at all.

The fourth generation, the D8, D9 and D10, is different hardware with different
software, and its debug interface is much harder to get at, so that approach
has not carried over. These robots do everything beyond their start button by
talking to the cloud, over a protocol of their own called Orbital:

- The robot opens one encrypted (TLS) connection to a server whose name is in
  its configuration, and keeps it open.
- It accepts only a server that shows a certificate the robot was told to
  trust.
- Commands, the schedule, the robot's status and its maps all travel over that
  one connection, in a message format of Neato's own.

So with Neato's server gone the robot has nothing to talk to, and nothing on a
home network can simply stand in for it. Bringing one of these robots back
takes two things, and deorbit is both:

1. **A server that speaks Orbital.** This one is a clean-room implementation,
   written from a specification of the protocol alone.
2. **A way to make the robot connect to it.** "Bind a robot" on the web page
   does that once, over a USB cable: it points the robot at your server's
   address and gives it your server's certificate to trust.

From then on the robot connects to your server over your own network, and what
it reports is kept in a database file on your machine.

## Features

✅ works · 🟡 works in part · ❌ not there

| Feature | Status | Notes |
| --- | --- | --- |
| Robots connect to your server instead of Neato's cloud | ✅ | Any number of robots. |
| Bind a robot to your server over USB, from the web page | 🟡 | Chrome or Edge only, and it needs a file that is not in this repository: see [Binding a robot](#binding-a-robot). |
| Put a robot on your Wi-Fi network | ❌ | The robot has to be on your Wi-Fi already. |
| Let in only the robots whose key you have | ✅ | Off by default: see [Checking robots' keys](#checking-robots-keys). |
| List of robots: connected or not, what each is doing, its charge | ✅ | The page refreshes itself every few seconds. |
| A robot's status: battery, base, errors, how its last run went | ✅ | |
| Start a cleaning | ✅ | Start cleans the whole house in eco mode with normal navigation. The arrow beside it opens a menu to choose the mode, the navigation, and a floor plan the page lists or a zone of one. |
| Pause, resume, return to base | ✅ | |
| Cancel a cleaning | ✅ | |
| See the robot's cleaning schedule | ✅ | Read from the robot, so only while it is connected. |
| Add, change and delete scheduled cleanings | ✅ | Time, days, mode, navigation and floor plan. |
| Maps of past cleanings | ✅ | Every map a robot uploads is kept and drawn: floor, walls, the area cleaned, the robot and its base. A map can be zoomed into and dragged about. |
| Keep a map as a floor plan, replace a floor plan, delete one | 🟡 | On the Maps tab, with the buttons in a map's row, while the robot is connected. The page ticks the maps it had the robot keep as floor plans, not those the robot got from Neato's cloud. |
| Clean by a floor plan | 🟡 | A cleaning, started or scheduled, can be put on one of the floor plans the page lists, or on a zone of one. A scheduled cleaning on a floor plan that is not listed has a warning sign, because the robot may not have it. |
| Zones and no-go lines | 🟡 | Drawn on the Maps tab, on the picture of a map the page had the robot keep as a floor plan, while the robot is connected: a zone as a rectangle with a name and a cleaning mode, and no-go lines one at a time. A cleaning, started or scheduled, can clean a zone and mind the no-go lines. If the robot cannot use them, a cleaning started on them from the page says so, and deleting the zone or the lines puts it right. Zones and lines the robot got from Neato's cloud are not shown. |
| History of what a robot reported | ✅ | Its connections, its messages and error reports, and the commands it was sent. |
| Notifications | 🟡 | A robot's notifications are in that history; nothing is sent to a phone or by e-mail. |
| Name a robot | ✅ | Kept by the server; the robot is not told. |
| Delete a robot with everything kept of it | ✅ | |
| Robot settings: language, sounds, cleaning options, automatic updates | 🟡 | On the Settings tab, read from the robot, so only while it is connected. A factory reset is not offered. A robot may answer with an error of its own instead of giving its sounds, which then cannot be changed. |
| Find the robot by sound | ❌ | |
| Firmware updates | ❌ | A robot that asks is told there is no update. |
| MyNeato app, Alexa, Google Assistant | ❌ | The web page takes the app's place. |
| Home Assistant and other integrations | ❌ | The page's own JSON API can be scripted; [CLAUDE.md](CLAUDE.md) describes it. |
| Login and HTTPS for the web page | ❌ | Whoever can reach the page controls the robots: see [The web page](#the-web-page). |
| Older robots (Botvac Connected, D3 to D7) | ❌ | They talk to a different cloud service, which this server does not replace. |

## Server configuration

The settings are in `deorbit.yml`, a YAML file. Every setting is optional, and
the `deorbit.yml` in this repository lists them all at their defaults, each
with a comment. The server reads the file once, as it starts, so restart it
after a change. A misspelt setting, or a value of the wrong type, stops the
server at startup with a message that names it.

| Setting | Default | What it is |
| --- | --- | --- |
| `public_address` | found at startup | The IP address robots reach this server at. "Bind a robot" writes it into the robot: see [The address robots are given](#the-address-robots-are-given). |
| `timezone` | this machine's | The IANA time zone robots are told when they log in, such as `Europe/Berlin`. |
| `web` | `true` | Serve the web page. |
| `web_host` | `0.0.0.0` | The IPv4 address the web page listens on. |
| `web_port` | `8080` | The port of the web page. |
| `host` | `0.0.0.0` | The IPv4 address robots are listened for on. |
| `port` | `3443` | The port robots are listened for on. A robot always connects to 3443. |
| `cert` | `certs/server.crt` | The server's TLS certificate chain (PEM). |
| `key` | `certs/server.key` | The server's TLS private key (PEM). |
| `generate_certs` | `true` | Create a certificate authority and a certificate when `cert` and `key` are both missing: see [Certificates](#certificates). |
| `keys` | empty | A folder of robots' public keys. Empty: any robot is let in. See [Checking robots' keys](#checking-robots-keys). |
| `database` | `data/deorbit.db` | The SQLite file that holds each robot's last status, its history, its maps, the floor plans it was given and its name. It is created when missing. |
| `heartbeat_interval` | `30` | Seconds between the heartbeats that keep a robot's connection open. A robot hangs up after 70 seconds of silence. |
| `idle_timeout` | `150` | Seconds after which a robot that has sent nothing is dropped. |
| `login_timeout` | `30` | Seconds a new connection has to log in. |
| `max_frame_size` | `16777216` | Bytes. A robot that sends a larger message is dropped. |
| `max_clock_skew` | `300` | Seconds a robot's clock may differ from this machine's when `keys` is set. |
| `full` | `false` | Print signatures and map data in full in the log, where it otherwise gives their length. |
| `verbose` | `false` | Also print heartbeats in the log. |

A path that is not absolute starts at the folder that holds `deorbit.yml`, and
`~` is your home folder.

### The address robots are given

`public_address` is the address your robots are told to connect to: the IP
address of the machine the server runs on, as your Wi-Fi network sees it, for
example `192.168.1.20`. "Bind a robot" writes it into the robot, so it has to
stay the same. Give the machine a fixed address, or a reservation in your
router; if the address changes, bind the robots again.

Left empty, the server looks for the machine's address as it starts and prints
what it found. What it finds is wrong in a container, where it is the
container's own address, and may be wrong on a machine with several networks or
a VPN, so set it yourself there. Where it finds none, it says so, and "Bind a
robot" binds nothing.

### Certificates

At its first start the server creates a certificate authority of its own and a
certificate for itself, in `certs/`. "Bind a robot" puts that authority's
certificate, `certs/ca.crt`, on the robot, which is what makes the robot trust
this server.

So keep `certs/`, and back it up. If it is lost, the server creates a new
authority at its next start, your robots refuse it, and each of them has to be
bound again. `ca.key` and `server.key` in it are secrets.

When only one of `cert` and `key` is missing the server stops and creates
nothing, so that a file already in place is never overwritten. With
`generate_certs: false` it stops whenever either is missing.

### The web page

The web page has no login and is served over plain HTTP. Anyone who can reach
it sees every robot, and can command it, change its schedule, its settings and
its name, and delete it. Keep it to a network you trust, and do not open its port to the
internet; neither of the two ports has to be reachable from outside your home.

`web_host: 127.0.0.1` keeps the page to the machine the server runs on, and
`web: false` turns it off. Behind a reverse proxy, the proxy has to pass on the
`Host` header it was asked under, or the page's buttons are refused.

### Checking robots' keys

As it comes, the server lets in any robot that reaches it. With `keys` set to a
folder, a robot is let in only if its RSA public key is in that folder, as

```text
<vendor>/<board serial>.pem
```

and its login is signed with that key. The names are matched without regard to
upper and lower case, and the keys are read when the server starts. The time in
a login then has to be within `max_clock_skew` seconds of this machine's clock,
and a login cannot be used a second time; `max_clock_skew: 0` turns both of
those checks off.

Deleting a robot on the web page removes its key file, and the robot is refused
from then on. Putting the file back lets it in again at the next start.

## Running the server in a container

You need:

- a machine that is always on and that your robots can reach over your Wi-Fi
  network, with Docker and Docker Compose
- Chrome or Edge, on a computer the robot can be plugged into, to bind a robot

### Starting it

1. Put this repository on the machine.
2. In `deorbit.yml`, set the two things a container cannot find out by itself:

   ```yaml
   public_address: 192.168.1.20   # this machine's address on your network
   timezone: Europe/Berlin        # otherwise robots are told UTC
   ```

3. Build the image and start the server:

   ```sh
   docker compose up -d --build
   ```

4. Open `http://localhost:8080` on that machine, or `http://<its address>:8080`
   from another one.

The compose file keeps three things in this folder, outside the container, so
that they outlast it:

| Here | What it is |
| --- | --- |
| `deorbit.yml` | the settings |
| `certs/` | the certificate authority and the server's certificate, created at the first start |
| `data/` | the database |

It publishes port 3443 for the robots and port 8080 for the web page. Inside
the container leave `web_host` at `0.0.0.0`; to keep the web page to the
machine itself, change its port line in `docker-compose.yml` to
`"127.0.0.1:8080:8080"`. To check robots' keys, set `keys: keys` and take the
comment sign off the `keys` line of the compose file. That line mounts the
folder read-only, and a robot whose key file cannot be removed cannot be
deleted on the web page: leave out the `:ro` if you want that.

### Binding a robot

A robot has to be on your Wi-Fi network already. Binding tells it where your
server is:

1. Open the web page in Chrome or Edge, on a computer the robot can be plugged
   into. The browser lets a page use USB only when the page was opened as
   `http://localhost:8080` or over HTTPS; under any other address the "Bind a
   robot" button is greyed out. If the server is on another machine, forward
   its port first with `ssh -L 8080:localhost:8080 user@that-machine` and open
   `http://localhost:8080`.
2. Press **Bind a robot**. The dialog shows the address it is about to give the
   robot. It should be the `public_address` you set.
3. Plug the robot into the computer with a USB cable, press **Configure
   robot**, and choose the robot when the browser asks which device to use.
4. When the dialog says that the robot is set up, unplug it. It connects when
   it is next online, and is in the list once it has sent its first status.

Binding changes three files on the robot: its hosts file and its vendor
settings, so that it looks for its cloud at your server's address, and the
certificate it trusts, which becomes your server's. The page saves no copy of
the files it replaces.

Binding needs a helper file, `deorbit/static/mtp-fs.js`, that is not part of
this repository; [Implementation details](#implementation-details) says why. It
has to be in that folder when the image is built. Without it everything else
works, and the dialog says that the USB helpers could not be loaded.

If a bound robot does not turn up in the list, look at the log:

- A `TLS handshake failed` line is a robot that reached the server and refused
  its certificate. It was bound when `certs/` held a different authority: bind
  it again.
- No line at all from the robot means it does not reach the server. Check
  `public_address`, that the robot is on your Wi-Fi network, and that nothing
  on the machine blocks port 3443.

### Day to day

```sh
docker compose logs -f          # what the server and the robots are saying
docker compose restart          # after a change to deorbit.yml
docker compose down             # stop the server
docker compose up -d --build    # after updating this repository
```

To back the server up, copy `deorbit.yml`, `certs/` and `data/`.

The server also runs without Docker, on Python 3.11 or later: `pip install -e .`
and then `python -m deorbit` in the folder that holds `deorbit.yml`.

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

deorbit is free software under the GNU General Public License, version 3: you
may use it, change it and pass it on under the terms in [LICENSE](LICENSE). It
comes with no warranty.
