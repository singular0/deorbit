// The web UI: the robots in the server's database as a list, and a page for
// each with its name, its schedule, its maps and floor plans, its events, the
// commands it takes and the way to delete it.
// Whatever a robot sent reaches the page as text nodes, never as markup.

import { PALETTES, paint, readBinary } from './map.js';

const POLL_MS = 3000; // how often the view on screen is fetched again
const FETCH_TIMEOUT_MS = 8000;
const EAGER_POLL_MS = 500; // how often instead, while the status that follows a command the robot accepted is due
const EAGER_FOR_MS = 10000; // how long after that command the page keeps asking that often
const COMMAND_TIMEOUT_MS = 15000; // longer than the server gives a robot to answer a command
const ACCEPTED_MS = 5000; // how long the page says that a robot accepted a command
const ANSWER_LIMIT = 160; // how much of a robot's answer to a command is said under the buttons; the events hold all of it
const SKELETON_MS = 180; // an answer quicker than this is drawn without a placeholder first
// JSON longer than this is shown without colours, which cost a node per token.
const HIGHLIGHT_LIMIT = 200000;
const EVENTS_STEP = 25; // how many events a robot's page shows at first, and how many more each time it is asked
const EVENTS_MAX = 1000; // the most the server gives at once
const MAPS_STEP = 10; // the same two numbers for its maps
const MAPS_MAX = 100;
const MAP_SIDE = 560; // about how long the longer side of a map's picture is
const NAME_MAX = 64; // the most characters the server takes for a robot's name
const SVG = 'http://www.w3.org/2000/svg';

const app = document.getElementById('app');
const notice = document.getElementById('notice');
const noticeText = document.getElementById('notice-text');
const live = document.getElementById('live');
const liveText = document.getElementById('live-text');
const dialog = document.getElementById('add'); // what "Bind a robot" opens, over the page

// The server's clock minus this browser's, so that "5 s ago" is right even
// when the two disagree.
let clockOffset = 0;

// The view on screen: its robot (null for the list), which tab of the robot's
// page is shown, how many of the robot's events and maps it asks for and which
// of them are open, the pictures of the maps that have been, the name being
// entered for it, the command last sent from it and when the robot last accepted one,
// the robot's schedule and what is being done to it, what is being asked of the
// robot about a floor plan, whether the robot is being deleted, the server's
// last answer, what was last drawn and the fetch under
// way. Navigating makes a new one, and a fetch that returns to find its view
// replaced drops the result.
let view = null;

// ---- Building nodes ----

function fill(node, attributes, children) {
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value != null && value !== false) node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

function h(tag, attributes, ...children) {
  return fill(document.createElement(tag), attributes, children);
}

function svg(tag, attributes, ...children) {
  return fill(document.createElementNS(SVG, tag), attributes, children);
}

function icon(name) {
  return svg('svg', { class: 'icon', 'aria-hidden': 'true' }, svg('use', { href: `#icon-${name}` }));
}

function pill(tone, text, glyph) {
  return h('span', { class: `pill ${tone}` }, glyph && icon(glyph), text);
}

function none(text = '—') {
  return h('span', { class: 'none' }, text);
}

// ---- Reading a robot ----

// SQLite reads true and false out of a state as 1 and 0.
const isOn = (value) => value === 1 || value === true;
const isOff = (value) => value === 0 || value === false;

/** What a value that may be JSON holds: the object or array, or else the value as it is. */
function parsed(value) {
  if (typeof value !== 'string' || !/^[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** What a robot sent where an object belongs: that object, or an empty one when it sent something else. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isEmpty(value) {
  return value == null || value === '' || (typeof value === 'object' && Object.keys(value).length === 0);
}

const hasErrors = (robot) => !isEmpty(parsed(robot.errors));

/** The charge as a length for a bar, or null when the robot sent no number. */
function chargeLevel(robot) {
  return typeof robot.charge === 'number' ? Math.max(0, Math.min(100, robot.charge)) : null;
}

function chargeTone(level) {
  if (level == null) return 'quiet';
  return level <= 15 ? 'bad' : level <= 40 ? 'warn' : 'good';
}

function chargeText(robot) {
  return typeof robot.charge === 'number' ? `${robot.charge}%` : plain(robot.charge);
}

/** The vendor a robot logged in as, which the server keeps in lowercase, by name where it has one. */
function vendorName(robot) {
  return robot.vendor === 'n' ? 'Neato' : robot.vendor;
}

/** What a robot is called: the name it was given here, or else its board serial, which is what it logs in as. */
function nameOf(robot) {
  return robot.name ?? robot.serial;
}

// The serial, not the name, which two robots may share and which may change.
function hrefOf(robot) {
  return `#/robots/${encodeURIComponent(robot.vendor)}/${encodeURIComponent(robot.serial)}`;
}

// ---- Showing a value ----

function plain(value) {
  return value == null || value === '' ? none() : String(value);
}

function flag(value) {
  if (isOn(value)) return h('span', { class: 'flag on' }, 'Yes');
  if (isOff(value)) return h('span', { class: 'flag off' }, 'No');
  return plain(value);
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() + clockOffset - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h ago`;
}

function clock(at) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString()
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A timestamp as "5 s ago", which `tick` keeps current. */
function when(stamp) {
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return plain(stamp);
  return h('time', { datetime: stamp, title: new Date(at).toLocaleString(), 'data-at': at }, ago(at));
}

/** A timestamp both ways: how long ago, and the time on the clock. */
function moment(stamp) {
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return plain(stamp);
  return h('span', { class: 'moment' }, when(stamp), h('span', { class: 'faint' }, clock(at)));
}

/** When a robot reached a step of its run: it gives seconds since 1970 by its own clock, and -1 for a step not reached. */
function step(value) {
  if (value === -1) return none();
  const date = new Date(typeof value === 'number' ? value * 1000 : NaN);
  return Number.isNaN(date.getTime()) ? plain(value) : moment(date.toISOString());
}

function tick() {
  for (const node of app.querySelectorAll('time[data-at]')) node.textContent = ago(Number(node.dataset.at));
}

function pretty(json) {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function code(text) {
  const block = h('pre', { class: 'code', tabindex: '0' });
  let done = 0;
  for (const match of text.length > HIGHLIGHT_LIMIT ? [] : text.matchAll(TOKEN)) {
    const [token, quoted, colon] = match;
    const kind = quoted ? (colon ? 'key' : 'string') : /^[tfn]/.test(token) ? 'word' : 'number';
    block.append(text.slice(done, match.index), h('span', { class: kind }, quoted ?? token), colon ?? '');
    done = match.index + token.length;
  }
  block.append(text.slice(done));
  return block;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Browsers offer no clipboard to a page fetched over plain HTTP from another machine.
    const area = h('textarea', { class: 'offscreen', readonly: '' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function copyButton(text) {
  const label = h('span', null, 'Copy');
  const button = h('button', {
    class: 'button',
    type: 'button',
    'data-focus': 'copy',
    onclick: async () => {
      await copy(text);
      button.focus();
      label.textContent = 'Copied';
      setTimeout(() => { label.textContent = 'Copy'; }, 1600);
    },
  }, icon('copy'), label);
  return button;
}

// ---- Parts shared by the list and the robot's page ----

/** What a robot is called, as a `tag`: a serial is set as the code it is, a name as the words it is. */
function called(tag, robot) {
  return h(tag, { class: robot.name == null ? 'serial' : 'name' }, nameOf(robot));
}

function presence(robot) {
  return h('span', { class: `pill ${robot.session ? 'good' : 'quiet'}` },
    h('span', { class: 'dot' }), robot.session ? 'Online' : 'Offline');
}

// The state and the action each wear one icon whatever they say, which is what
// tells the two words apart: the spec names neither's values.
function statePill(robot) {
  if (robot.state == null) return pill('quiet', 'No state yet', 'pulse');
  if (hasErrors(robot)) return pill('bad', String(robot.state), 'alert');
  return pill(robot.state === 'idle' ? 'quiet' : 'accent', String(robot.state), 'pulse');
}

/** The action beside the state, as the robot sent it, or nothing when it sent none. */
function actionPill(robot) {
  return robot.action != null && robot.action !== '' && pill('quiet', String(robot.action), 'route');
}

// ---- The list ----

function battery(robot) {
  const level = chargeLevel(robot);
  const bar = h('span', { class: 'meter-fill' });
  bar.style.width = `${level ?? 0}%`;
  return h('div', { class: `battery ${chargeTone(level)}` },
    h('span', { class: 'battery-value' }, chargeText(robot)),
    h('span', { class: 'meter' }, bar));
}

/** What else a card says of its robot, or nothing when there is nothing to say. */
function facts(robot) {
  const fact = (glyph, text, tone) => h('span', { class: `fact ${tone ?? ''}` }, icon(glyph), text);
  const said = [
    isOn(robot.is_charging) && fact('bolt', 'Charging'),
    hasErrors(robot) && fact('alert', 'Reports errors', 'bad'),
  ].filter(Boolean);
  return said.length > 0 && h('div', { class: 'facts' }, said);
}

function card(robot) {
  return h('a', { class: `card robot${robot.session ? ' online' : ''}`, href: hrefOf(robot), 'data-focus': hrefOf(robot) },
    called('strong', robot),
    battery(robot),
    facts(robot),
    h('div', { class: 'robot-foot' },
      h('div', { class: 'robot-pills' }, presence(robot), statePill(robot), actionPill(robot)),
      icon('chevron')));
}

function message(title, text, back) {
  return h('div', { class: 'card empty' },
    h('div', { class: 'avatar' }, icon('robot')),
    h('h1', null, title),
    h('p', { class: 'lead' }, text),
    back && h('a', { class: 'back', href: '#/', 'data-focus': 'back' }, icon('back'), 'All robots'));
}

function listPage(mine, robots) {
  const online = robots.filter((robot) => robot.session).length;
  const total = robots.length === 1 ? '1 robot' : `${robots.length} robots`;
  const empty = WEBUSB
    ? 'No robots yet. Bind one over USB, or wait for one to connect and send its first state or heartbeat.'
    : 'No robots yet. One is listed once it connects and sends its first state or heartbeat.';
  const lead = robots.length === 0 ? empty : `${total} in the database, ${online} online`;
  return h('div', null,
    h('div', { class: 'heading heading-row' },
      h('div', null,
        h('h1', null, 'Robots'),
        h('p', { class: 'lead' }, lead)),
      addButton(mine)),
    robots.length > 0 && h('div', { class: 'grid' }, robots.map(card)));
}

// ---- Adding a robot over USB ----
//
// Pointing a robot at this server is done entirely in the browser: it connects
// to the plugged-in robot over WebUSB and rewrites the robot's hosts file,
// vendor config and trusted certificate. The helpers that do it live beside this
// file; they are imported only when the dialog is opened, so the rest of the UI
// does not depend on them being served, and so the device prompt in `runAdd`
// stays the first await of the click that starts it (WebUSB needs a gesture).
//
// The dialog is a modal over the page and no part of it: `drawAdd` draws it
// from the view's `adding` when that has changed, and a poll that draws the
// list anew leaves it as it is.

let helpers = null; // the add-robot helper modules, once loaded
let helpersError = null; // why they could not be loaded, if so

// Whether this browser has WebUSB. Chrome and Edge do, and only on a page from
// https or localhost. Without it the button is disabled, so the dialog is never
// open and nothing below has to ask again.
const WEBUSB = Boolean(navigator.usb);
const NO_WEBUSB = 'this browser has no WebUSB. Use Chrome or Edge, over http://localhost or https';

function errText(err) {
  return err && err.message ? err.message : String(err);
}

async function loadHelpers() {
  if (helpers || helpersError) return;
  try {
    const parts = await Promise.all([
      import('./webusb-transport.js'),
      import('./mtp-client.js'),
      import('./mtp-fs.js'),
      import('./neato-config.js'),
    ]);
    helpers = Object.assign({}, ...parts);
  } catch (err) {
    helpersError = err;
  }
}

async function fetchSetup() {
  const [status, body] = await ask('api/setup', new AbortController(), FETCH_TIMEOUT_MS);
  return status === 200 ? body : null;
}

function addButton(mine) {
  return h('button', {
    class: 'button add-robot',
    type: 'button',
    disabled: !WEBUSB,
    title: !WEBUSB && `Bind a robot: ${NO_WEBUSB}`,
    'data-focus': 'add-robot',
    onclick: () => openAdd(mine),
  }, icon('link'), 'Bind a robot');
}

function openAdd(mine) {
  if (mine.adding) return;
  const add = { log: [], busy: false, done: false, error: null, asking: true, setup: null };
  mine.adding = add;
  drawAdd(mine);
  dialog.showModal();
  dialog.querySelector('[data-focus="add-configure"]')?.focus();
  // The helpers are loaded now, so the gesture in `runAdd` is spent on the device prompt, not on an import.
  loadHelpers().then(() => {
    if (mine.adding === add) drawAdd(mine);
  });
  // The address to point a robot at and the certificate it is to trust are the server's to say.
  fetchSetup().then((setup) => {
    if (mine.adding !== add) return;
    add.asking = false;
    add.setup = setup;
    drawAdd(mine);
  });
}

function closeAdd(mine) {
  mine.adding = null;
  if (dialog.open) dialog.close();
  dialog.replaceChildren();
  // The button that opened it may have been drawn anew since, so the browser cannot hand the focus back.
  app.querySelector('[data-focus="add-robot"]')?.focus();
}

// Escape asks for the dialog to be closed, which is not done while a robot is being written to.
dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (view?.adding && !view.adding.busy) closeAdd(view);
});

// A browser closes it unasked when Escape is pressed again with nothing done in between.
// `closeAdd` ends up here as well, with `adding` gone by then.
dialog.addEventListener('close', () => {
  const add = view?.adding;
  if (!add) return;
  if (add.busy) dialog.showModal();
  else closeAdd(view);
});

/**
 * Why there is no address to point a robot at, or null when there is one or the
 * server has yet to say. The address is the server's alone to give: its
 * `public_address`, or what it found for itself when it started.
 */
function noAddress(add) {
  if (add.asking || add.setup?.address) return null;
  return add.setup
    ? 'This server has no address to give a robot: none is set, and it found none when it started. '
      + 'Set public_address in its settings and restart it.'
    : 'The server did not say what its address is. Close this and open it again.';
}

/** Connect to the plugged-in robot over USB and point it at this server. Started by a click, so nothing is awaited before the device prompt. */
async function runAdd(mine) {
  const add = mine.adding;
  const ip = add.setup?.address;
  if (add.busy || !ip || !helpers) return; // the dialog says why, and holds the button back

  add.busy = true;
  add.done = false;
  add.error = null;
  add.log = [];
  drawAdd(mine);

  const log = (text) => {
    add.log.push(text);
    if (mine.adding === add) drawAdd(mine);
  };
  let transport = null;
  try {
    // The server's certificate goes onto every robot. A server that has none to give, with no ca.crt beside its own, installs none.
    const certBytes = add.setup.ca ? new TextEncoder().encode(add.setup.ca) : null;
    if (!certBytes) log('No certificate from the server, so none is installed on the robot.');
    log('Choose the robot in the browser’s device prompt…');
    transport = new helpers.WebUSBTransport();
    await transport.open(); // the device prompt: the first await, so the click still counts as a user gesture
    log('Connected over USB. Opening a session…');
    const client = new helpers.MtpClient(transport);
    await client.openSession();
    // NOTE: mtp-fs.js was not read (see CLAUDE.md). This builds its file system
    // from the contract neato-config.js documents: an MtpFileSystem over an
    // already-open MTP session, with a `log` it calls as it works. Correct this
    // one line if the file's exports differ.
    const fs = new helpers.MtpFileSystem(client);
    fs.log = log;
    log(`Pointing orbital.deorbit at ${ip}…`);
    // The write contract requires an onConfirm answer for every change;
    // without one each write aborts unanswered. The user already consented by
    // starting the bind, so every change is approved without asking again.
    // Backups of replaced files are kept in memory only (for verify/restore),
    // not downloaded.
    const onConfirm = async () => true;
    const result = await helpers.reconfigureNeato(fs, { ip, certBytes, onConfirm });
    if (result && result.ok === false) {
      throw new Error(result.aborted ? 'aborted - no changes made' : result.error || 'the robot refused a write');
    }
    add.done = true;
    log('Done. Unplug the robot; it connects to this server when it next comes online.');
  } catch (err) {
    add.error = errText(err);
    log(`Failed: ${errText(err)}`);
  } finally {
    if (transport) {
      try { await transport.close(); } catch { /* best effort */ }
    }
    add.busy = false;
    if (mine.adding === add) drawAdd(mine);
  }
}

/** What the dialog holds: what is about to happen, the address the robot is pointed at, how it is going, and its two buttons. */
function addForm(mine) {
  const add = mine.adding;
  const address = add.setup?.address;
  // Why a robot cannot be configured at this moment, if so.
  const why = add.busy ? 'the robot is being configured'
    : helpersError ? 'the USB helpers could not be loaded'
    : !helpers ? 'the USB helpers are still being loaded'
    : add.asking ? 'waiting for the server to say its address'
    : !address && 'the server gave no address';
  const said = (tone, text) => text && h('p', { class: `command-said ${tone}`, role: 'status' }, text);
  return h('form', {
    class: 'add-form',
    onsubmit: (event) => {
      event.preventDefault();
      runAdd(mine);
    },
  },
  h('div', null,
    h('h2', { class: 'add-title', id: 'add-title' }, 'Bind a robot'),
    h('p', { class: 'add-lead' }, 'Plug the robot into this computer over USB and click Configure robot button '
      + 'to bind it to this Deorbit server.')),
  h('div', { class: 'add-address' },
    h('span', { class: 'add-label' }, 'Server address'),
    address
      ? h('span', { class: 'add-value serial' }, address)
      : h('span', { class: 'add-value none' }, add.asking ? '…' : 'none'),
    h('span', { class: 'add-note' }, 'This address was either explicitly set as public_address in the server’s '
      + 'configuration file, or auto-detected at server startup. To change it, set public_address in deorbit.yml and '
      + 'restart the server. Robot must be able to connect to this address via its Wi-Fi network.')),
  add.log.length > 0 && h('pre', { class: 'code add-log' }, add.log.join('\n')),
  !add.busy && helpersError && said('bad',
    `The USB helpers could not be loaded: ${errText(helpersError)}. This server may not provide mtp-fs.js.`),
  !add.busy && said('bad', noAddress(add)),
  !add.busy && said('bad', add.error),
  add.done && said('good', 'The robot is now set up for this server.'),
  h('div', { class: 'add-actions' },
    // Both are held back, not disabled: the keyboard is put on the first as the dialog opens,
    // before the server has answered, and stays where it is while the robot is configured.
    h('button', {
      class: add.busy ? 'command busy' : 'command',
      type: 'submit',
      'aria-disabled': why && 'true',
      title: why && `Configure robot: ${why}`,
      'data-focus': 'add-configure',
    }, icon('link'), 'Configure robot'),
    h('button', {
      class: 'button',
      type: 'button',
      'aria-disabled': add.busy && 'true',
      title: add.busy && 'Cancel: the robot is being configured',
      'data-focus': 'add-cancel',
      onclick: () => { if (!add.busy) closeAdd(mine); },
    }, add.done ? 'Close' : 'Cancel')));
}

/** Draw the dialog from the view's `adding`. */
function drawAdd(mine) {
  if (mine !== view || !mine.adding) return;
  // Whatever had the keyboard's focus is replaced too, so hand it to its successor, as `draw` does.
  const focus = dialog.contains(document.activeElement) && document.activeElement.dataset.focus;
  dialog.replaceChildren(addForm(mine));
  if (focus) dialog.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  // The last line of the log is the one that says where things are.
  const log = dialog.querySelector('.add-log');
  if (log) log.scrollTop = log.scrollHeight;
}

// ---- The events of one robot ----

/** A value a robot sent as a word for a sentence, or null when it is not one. */
function word(value) {
  return (typeof value === 'string' && value !== '') || typeof value === 'number' ? String(value) : null;
}

const named = (label, value) => word(value) && `${label} ${value}`;

// How an event is shown: its label, icon and tone, and what its body says in a
// line. A login and a disconnect are the server's own, and so are a call, which
// is what a command is sent as, and the robot's response to one; the others are
// named by the service a robot sent a message to, and a service not listed here
// goes under its own name. These are maps because a robot chooses that name,
// and "constructor" must not find anything.
const CONNECTION = new Map([
  ['login', ['Login', 'login', 'good', (body) => [
    named('from', body.address),
    named('firmware', body.firmware),
    body.verified === false && 'signature not verified',
  ]]],
  ['disconnect', ['Disconnect', 'logout', 'quiet', (body) => [word(body.reason)]]],
  ['call', ['Command', 'forward', 'accent', (body) => [word(body.ability)]]],
  ['response', ['Answer', 'back', 'quiet', (body) => [word(body.ability), named('code', body.code)]]],
]);
const SERVICES = new Map([
  ['robots.notify', ['Notification', 'bell', 'accent', (body) => [word(body.message_code)]]],
  ['robots.error_codes', ['Error', 'alert', 'bad', (body) => [word(body.code), word(body.severity)]]],
  ['robots.link', ['Link', 'link', 'accent', (body) => [named('user', body.user_id), word(body.timezone)]]],
  ['firmware.check', ['Firmware check', 'download', 'quiet', (body) => [
    named('version', body.version),
    body.only_mandatory === true && 'mandatory only',
  ]]],
  ['maps.create', ['Map', 'map', 'quiet', (body) => [word(body.rank_uuid)]]],
  ['logs.list_files', ['Log files', 'file', 'quiet', (body) => [
    Array.isArray(body.files) && (body.files.length === 1 ? '1 file' : `${body.files.length} files`),
  ]]],
  ['logs.update_status', ['Log upload', 'file', 'quiet', (body) => [word(body.state), word(body.log_id)]]],
]);

/** When an event happened: the time on the clock first, as a log is read, then how long ago. */
function eventTime(stamp) {
  const at = Date.parse(stamp);
  return h('span', { class: 'event-time' },
    Number.isNaN(at) ? plain(stamp) : [clock(at), h('span', { class: 'faint' }, when(stamp))]);
}

/** What opening an event shows: when and what it was as the database has it, and its whole body. */
function eventDetail(event) {
  const what = event.service == null && CONNECTION.has(event.kind)
    ? event.kind
    : `${event.kind} to ${event.service ?? 'no service'}`;
  return [
    h('p', { class: 'event-meta' }, `${event.at} · ${what}`),
    event.body_json == null ? none('No body') : code(pretty(event.body_json)),
  ];
}

/**
 * A row that opens, as an event and a map each are: its `line`, and under that
 * what `detail` gives. `open` is the view's set of the rows that are open, by
 * `id`, and `focus` names the row to the keyboard's focus.
 */
function entry(id, open, focus, line, detail) {
  // The detail is laid out when the row is first opened: most rows never are.
  const under = h('div', { class: 'event-detail' });
  const row = h('details', {
    class: 'event',
    ontoggle: () => {
      if (!row.open) {
        open.delete(id);
        return;
      }
      open.add(id);
      if (!under.hasChildNodes()) under.append(...detail());
    },
  }, h('summary', { 'data-focus': focus }, line, icon('chevron')), under);
  // A row that was open stays open when the page is drawn again.
  if (open.has(id)) {
    under.append(...detail());
    row.open = true;
  }
  return row;
}

// How many of a list a robot's page asks for at first and then more each time
// it is asked, and the most the server gives at once.
const LISTS = { events: [EVENTS_STEP, EVENTS_MAX], maps: [MAPS_STEP, MAPS_MAX] };

/** A way to the older rows of a list, while the server says there are more than it gave. */
function older(mine, list, more) {
  const [step, most] = LISTS[list];
  return more && h('div', { class: 'more' }, mine.asked[list] < most
    ? h('button', {
      class: 'button',
      type: 'button',
      'data-focus': `older-${list}`,
      onclick: () => {
        mine.asked[list] = Math.min(mine.asked[list] + step, most);
        refresh(mine);
      },
    }, 'Show older')
    : h('p', { class: 'hint' }, `These are the latest ${most}. Older ${list} are in the database.`));
}

function eventRow(event, mine) {
  const known = event.service == null ? CONNECTION.get(event.kind) : SERVICES.get(event.service);
  const [label, glyph, tone, says] = known ?? [String(event.service ?? event.kind), 'message', 'quiet', () => []];
  const said = says(record(parsed(event.body_json))).filter(Boolean).join(' · ');
  const line = [eventTime(event.at), pill(tone, label, glyph), h('span', { class: 'event-what' }, said)];
  return entry(event.id, mine.open, `event-${event.id}`, line, () => eventDetail(event));
}

/** The robot's events, newest first. */
function eventLog(mine, events, more) {
  if (events.length === 0) return none('Nothing yet.');
  return [h('div', { class: 'events' }, events.map((event) => eventRow(event, mine))), older(mine, 'events', more)];
}

// ---- The maps of one robot ----

// The tone of each state the spec gives a run. Any other is quiet.
const RUN_TONES = new Map([
  ['done', 'good'],
  ['in_progress', 'accent'],
  ['paused', 'accent'],
  ['suspend_charging', 'accent'],
  ['not_reachable', 'bad'],
  ['error', 'bad'],
]);

/** A number of seconds as "1 min 6 s". */
function lasting(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long it was from the start to the end a robot gave, or null when one of them is not a time. */
function took(timing) {
  const seconds = Math.round((Date.parse(timing.end) - Date.parse(timing.start)) / 1000);
  return seconds >= 0 ? lasting(seconds) : null;
}

/** What these runs cleaned between them, which a robot gives in square metres, or null when none says. */
function areaOf(runs) {
  const areas = runs.map((run) => record(run.stats).area).filter((area) => typeof area === 'number');
  return areas.length > 0 ? `${areas.reduce((sum, area) => sum + area, 0).toFixed(2)} m²` : null;
}

/** What a map says of its run, beside the picture. */
function mapFacts(map, runs) {
  const timing = record(map.timing);
  return rows([
    ['Started', moment(timing.start)],
    ['Ended', moment(timing.end)],
    ['Paused', typeof timing.pause === 'number' ? lasting(timing.pause) : plain(timing.pause)],
    ['Started by', plain(map.started_by)],
    ['Cleaning complete', flag(map.cleaning_complete)],
    ...runs.map((run, n) => {
      const settings = record(run.settings);
      const said = [word(run.state), areaOf([run]), word(settings.mode), word(settings.navigation_mode)].filter(Boolean);
      return [runs.length === 1 ? 'Run' : `Run ${n + 1}`, said.length > 0 ? said.join(' · ') : none()];
    }),
    ['Rank UUID', h('span', { class: 'mono' }, plain(map.rank_uuid))],
    // The floor plan the run was on: a robot gave here what its schedule named as the floor plan to clean.
    ['Persistent rank UUID', h('span', { class: 'mono' }, plain(map.persistent_rank_uuid))],
  ]);
}

/** Mark a place on a map's picture: the robot as a disc with a line the way it faces, its base as a square. */
function stamp(pen, { name, x, y, dir }, palette, ratio) {
  const size = 6 * ratio;
  const colour = `rgb(${palette[name]})`;
  pen.lineWidth = 2 * ratio;
  pen.lineCap = 'round';
  if (name === 'robot' && dir !== null) {
    // A heading turns anticlockwise from the x axis, and y runs down a canvas.
    const turn = (dir * Math.PI) / 180;
    pen.strokeStyle = colour;
    pen.beginPath();
    pen.moveTo(x, y);
    pen.lineTo(x + Math.cos(turn) * size * 2.2, y - Math.sin(turn) * size * 2.2);
    pen.stroke();
  }
  pen.beginPath();
  if (name === 'robot') pen.arc(x, y, size, 0, 2 * Math.PI);
  else pen.rect(x - size, y - size, size * 2, size * 2);
  pen.fillStyle = colour;
  pen.fill();
  pen.strokeStyle = `rgb(${palette.unseen})`;
  pen.stroke();
}

/** A map as a picture with its legend: what its two binaries hold, and where the robot and its base were. */
async function picture(map) {
  const binaries = record(map.map);
  const places = record(map.robot);
  const notes = [];
  const read = async (name) => {
    try {
      return await readBinary(binaries[name]);
    } catch (error) {
      throw new Error(`${name} ${error.message}`);
    }
  };
  const rank = await read('rank_binary');
  // The floor and the walls are worth showing without what was cleaned.
  const real = await read('real_binary').catch((error) => {
    notes.push(`The cleaned cells are not shown: ${error.message}.`);
    return null;
  });
  const palette = PALETTES[matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'];
  // A whole number of the screen's pixels to each of the page's keeps the cells sharp.
  const ratio = Math.min(3, Math.ceil(devicePixelRatio || 1));
  // The robot last, so that it is drawn over the base it stands on.
  const made = paint(rank, real, { base: places.base, robot: places.pos }, palette, MAP_SIDE, ratio);
  const canvas = h('canvas', { class: 'map-canvas', width: made.width, height: made.height, role: 'img', 'aria-label': 'The map' });
  canvas.style.width = `${made.width / ratio}px`;
  const pen = canvas.getContext('2d');
  pen.putImageData(new ImageData(made.rgba, made.width, made.height), 0, 0);
  for (const mark of made.marks) stamp(pen, mark, palette, ratio);

  const key = (name, label) => {
    // Not a class of that name: `robot` is a card in the list.
    const swatch = h('span', { class: name === 'robot' ? 'swatch round' : 'swatch' });
    swatch.style.background = `rgb(${palette[name]})`;
    return h('li', null, swatch, label);
  };
  const marked = new Set(made.marks.map((mark) => mark.name));
  const metres = (millimetres) => (millimetres / 1000).toFixed(1);
  if (real !== null && made.cleaned === null) {
    notes.push('The cleaned cells are not shown: real_binary is not laid out as rank_binary is.');
  }
  if (made.odd.length > 0) {
    const held = made.odd.map(([value, count]) => `${value} in ${count} cells`).join(', ');
    notes.push(`real_binary also holds ${held}, which this page has no meaning for.`);
  }
  return [
    canvas,
    h('ul', { class: 'map-legend' },
      key('floor', 'Floor'),
      key('wall', 'Wall'),
      made.cleaned !== null && key('cleaned', 'Cleaned'),
      marked.has('robot') && key('robot', 'Robot'),
      marked.has('base') && key('base', 'Base')),
    made.span && h('p', { class: 'hint' },
      `The robot saw ${metres(made.span.width)} m by ${metres(made.span.height)} m, at ${made.cell} mm to a cell.`),
    ...notes.map((note) => h('p', { class: 'hint' }, note)),
  ].filter(Boolean);
}

/** Fetch a map with its binaries and put its picture in `node`, or why there is none and a way to try again. */
async function loadMap(mine, id, node) {
  node.replaceChildren(h('p', { class: 'hint' }, 'Reading the map…'));
  const address = `api/map?${new URLSearchParams({ ...mine.robot, id })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS);
  try {
    if (status !== 200) throw new Error(answer?.error ?? 'no answer from the server');
    node.replaceChildren(...await picture(record(parsed(record(answer.map).map_json))));
  } catch (error) {
    node.replaceChildren(
      h('p', { class: 'map-failed' }, `Cannot show this map: ${error.message}.`),
      h('button', {
        class: 'button',
        type: 'button',
        'data-focus': `map-again-${id}`,
        onclick: () => loadMap(mine, id, node),
      }, 'Try again'));
  }
}

/**
 * The picture of a map. The view keeps the node, so a map is fetched and read
 * once, when it is first opened, however often the page is drawn again.
 */
function drawing(mine, id) {
  let node = mine.drawings.get(id);
  if (!node) {
    node = h('div', { class: 'map-drawing' });
    mine.drawings.set(id, node);
    loadMap(mine, id, node);
  }
  return node;
}

function mapRow(row, mine, robot, plans) {
  const map = record(parsed(row.map_json));
  const runs = (Array.isArray(map.runs) ? map.runs : []).map(record);
  // A map of one run, as the rule is, wears the state of that run.
  const state = runs.length === 1 ? word(runs[0].state) : null;
  const label = state ?? (runs.length > 1 ? `${runs.length} runs` : 'Map');
  const kept = plans.some((plan) => plan.map_id === row.id) && 'floor plan';
  const said = [kept, areaOf(runs), took(record(map.timing)), named('started by', map.started_by)].filter(Boolean).join(' · ');
  const line = [eventTime(row.at), pill(RUN_TONES.get(state) ?? 'quiet', label, 'map'), h('span', { class: 'event-what' }, said)];
  return entry(row.id, mine.openMaps, `map-${row.id}`, line, () => [h('div', { class: 'map-detail' },
    drawing(mine, row.id),
    h('div', { class: 'map-facts' }, mapFacts(map, runs), mapTools(mine, robot, plans, row.id, map)))]);
}

/** The maps the robot uploaded, newest first. */
function mapList(mine, { robot, maps, more_maps: more, floorplans: plans }) {
  if (maps.length === 0) return none('Nothing yet.');
  return [h('div', { class: 'events' }, maps.map((row) => mapRow(row, mine, robot, plans))), older(mine, 'maps', more)];
}

// ---- The floor plans of one robot ----
//
// A floor plan is a map that the robot keeps, to clean by. The robot makes one
// of a map it uploaded when the server tells it to, and the server remembers
// which it told the robot to make: a robot cannot be asked which it has.

/** A UUID as short as a button can carry: how it begins. */
function short(uuid) {
  return `${uuid.slice(0, 8)}…`;
}

/**
 * Ask the robot, through the server, to keep a map as a floor plan or to drop
 * one it keeps. The view's `floors` holds whether an answer is waited for and
 * how the last request went, with the map it was pressed on, or null for one
 * pressed on a floor plan: that is where it is said. One is asked at a time.
 */
async function askFloor(mine, label, more, map = null) {
  const floors = mine.floors;
  if (floors.waiting) return;
  floors.waiting = true;
  floors.asking = null;
  floors.said = null;
  drawRobot(mine);
  const address = `api/floorplan?${new URLSearchParams({ ...mine.robot, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  floors.waiting = false;
  if (mine !== view) return;
  floors.said = { ...outcome(label, status, answer), map };
  drawRobot(mine);
  // The floor plans come with the robot, and so do the events of this.
  refresh(mine);
}

/**
 * The buttons for something that takes a floor plan from the robot, which is
 * asked twice. The second time Keep stands where the first button stood, with
 * the keyboard on it, and the button that does it beside that, so that
 * pressing the first one twice drops nothing. `key` names what is asked, and
 * the view's `floors.asking` holds the one that awaits its second press.
 */
function askTwice(mine, robot, key, label, again, press) {
  const floors = mine.floors;
  const set = (asking) => () => {
    floors.asking = asking;
    floors.said = null;
    drawRobot(mine);
  };
  return floors.asking === key
    ? [robotButton(floors, robot, 'Keep', key, set(null)), robotButton(floors, robot, again, `${key}-again`, press)]
    : [robotButton(floors, robot, label, key, set(key))];
}

/** How the last request about a floor plan went, where it was pressed: on the map of that `id`, or with null on a floor plan. */
function floorSaid(mine, map) {
  const said = mine.floors.said;
  return said !== null && said.map === map && h('p', { class: `command-said ${said.tone}`, role: 'status' }, said.text);
}

/**
 * What can be asked of the robot with a map: to keep it as a new floor plan, or
 * in place of one that it has. Those are the floor plans the server had it
 * make and the one this map says it was cleaned on.
 */
function mapTools(mine, robot, plans, id, map) {
  const has = [...new Set([...plans.map((plan) => plan.rank_uuid), map.persistent_rank_uuid])]
    .filter((uuid) => typeof uuid === 'string' && uuid !== '' && uuid !== map.rank_uuid);
  return h('div', { class: 'map-tools' },
    robotButton(mine.floors, robot, 'Promote to floor plan', `floor-new-${id}`,
      () => askFloor(mine, 'Promote', { action: 'promote', map: id }, id)),
    has.flatMap((old) => askTwice(mine, robot, `floor-swap-${id}-${old}`, `Replace floor plan ${short(old)}`, 'Replace it',
      () => askFloor(mine, 'Replace', { action: 'update', map: id, old_rank_uuid: old }, id))),
    floorSaid(mine, id));
}

/** A floor plan in a row: when the robot accepted it, what the robot knows it by, and the way to have the robot drop it. */
function floorRow(mine, robot, plan) {
  const uuid = String(plan.rank_uuid);
  return h('div', { class: 'floor' },
    moment(plan.at),
    h('span', { class: 'floor-id' }, uuid),
    h('div', { class: 'slot-tools' }, askTwice(mine, robot, `floor-drop-${uuid}`, 'Demote', 'Demote it',
      () => askFloor(mine, 'Demote', { action: 'demote', rank_uuid: uuid }))));
}

/** The floor plans the server had the robot make, the one it accepted last first. */
function floorPanel(mine, { robot, floorplans: plans }) {
  return panel('Floor plans', [
    plans.length === 0
      ? h('p', { class: 'plan-note' }, none('None.'))
      : h('div', { class: 'floors' }, plans.map((plan) => floorRow(mine, robot, plan))),
    floorSaid(mine, null),
  ], {
    hint: 'The maps this server had the robot keep as floor plans, to clean by. A robot cannot be asked which it has, '
      + 'so one it was given elsewhere is not listed. A map is made one from where it is opened below, '
      + 'and Demote has the robot delete one.',
    wide: true,
  });
}

// ---- The schedule of one robot ----

// What an event of a schedule may name, as the server checks it: the days of a
// week, each under the name a robot gives it and the one shown for it here,
// and the two settings of a run.
const DAYS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
];
const MODES = ['eco', 'turbo', 'auto', 'max'];
const NAVIGATION_MODES = ['normal', 'gentle'];
// A map, because a robot chooses the name that is looked up.
const DAY_LABELS = new Map(DAYS);

/** The runs of an event's command, each as an object, or none when the robot gave no list of them. */
function runsOf(event) {
  const runs = record(event.command).runs;
  return Array.isArray(runs) ? runs.map(record) : [];
}

/** What the runs of an event clean and how, in a line. */
function cleans(runs) {
  if (runs.length === 0) return 'no runs';
  const place = runs[0].map == null ? null : record(runs[0].map);
  const where = place === null ? 'no floor plan' : named('floor plan', place.rank_id) ?? 'a floor plan';
  if (runs.length > 1) return `${runs.length} runs · ${where}`;
  const settings = record(runs[0].settings);
  return [word(settings.mode), word(settings.navigation_mode), where, place && named('zone', place.track_id)]
    .filter(Boolean).join(' · ');
}

/** An event as the server takes one: the fields the spec gives one, and of its command the runs alone. */
function sent({ id, enabled, days, time, runs }) {
  return { ...(id != null && { id }), enabled, days, time, command: { ability: 'cleaning.start', runs } };
}

/**
 * Ask the robot, through the server, for its schedule or for a change to it.
 * The view's `schedule` keeps which of those is waited for and, when it failed,
 * how. One is asked at a time. A change the robot accepted is followed by
 * asking for the schedule, because its answer says nothing of that, not even
 * the id it gave a new event.
 */
async function askSchedule(mine, action, label, more = {}) {
  const plan = mine.schedule;
  if (plan.waiting) return;
  plan.waiting = action;
  plan.said = null;
  if (action === 'show') plan.asked = mine.body?.robot.session?.since ?? null;
  drawRobot(mine);
  const address = `api/schedule?${new URLSearchParams({ ...mine.robot, action, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  plan.waiting = null;
  if (mine !== view) return;
  const went = outcome(label, status, answer);
  if (went.tone !== 'good') {
    plan.said = went;
  } else if (action === 'show') {
    plan.shown = record(answer.body);
    plan.at = answer.sent;
  } else {
    plan.form = null;
    plan.dropping = null;
    askSchedule(mine, 'show', 'Schedule');
    return;
  }
  drawRobot(mine);
}

/** What the form starts from: the event it is to change, or one of a single run on no floor plan when it is to add one. */
function draftOf(event) {
  const runs = event ? runsOf(event) : [{ settings: {}, map: null }];
  const settings = record(runs[0]?.settings);
  const among = (values, value) => (values.includes(value) ? value : values[0]);
  return {
    id: event ? event.id : null,
    enabled: event ? event.enabled === true : true,
    days: event && Array.isArray(event.days) ? event.days.filter((day) => DAY_LABELS.has(day)) : [],
    time: event && typeof event.time === 'string' ? event.time : '',
    mode: among(MODES, settings.mode),
    navigation: among(NAVIGATION_MODES, settings.navigation_mode),
    runs,
  };
}

/** Open the form on `event`, or on a new one when there is none, and put the keyboard in it. */
function edit(mine, event) {
  const plan = mine.schedule;
  plan.form = draftOf(event);
  plan.dropping = null;
  plan.said = null;
  drawRobot(mine);
  app.querySelector('[data-focus="plan-time"]')?.focus();
}

/** Ask for the event in the form to be added, or to be put in place of the one the form was opened on. */
function save(mine) {
  const plan = mine.schedule;
  const { id, enabled, time, mode, navigation, runs } = plan.form;
  const days = DAYS.map(([name]) => name).filter((name) => plan.form.days.includes(name));
  if (days.length === 0) {
    plan.said = { tone: 'bad', text: 'Save: choose at least one day' };
    drawRobot(mine);
    return;
  }
  // The form has the settings of an event's only run. The runs of an event with more go back as the robot gave them.
  const changed = runs.length === 1 ? [{ ...runs[0], settings: { mode, navigation_mode: navigation } }] : runs;
  const event = sent({ id, enabled, days, time, runs: changed });
  askSchedule(mine, id === null ? 'add' : 'update', 'Save', { event: JSON.stringify(event) });
}

/**
 * A button that asks something of the robot, as those of the schedule and of
 * the floor plans do. It can be pressed while the robot is connected, unless
 * there is another reason `why` not, and does nothing while the robot has yet
 * to answer the last one pressed, which `job.waiting` says: `job` is the
 * view's `schedule` or its `floors`. `look` makes it something other than a
 * button with its label on it.
 */
function robotButton(job, robot, label, focus, press, why = null, look = null) {
  const reason = !robot.session ? 'the robot is not connected' : why;
  // Held back, not disabled: a disabled button could not keep the keyboard's focus.
  const held = reason === null && Boolean(job.waiting);
  return h('button', {
    class: 'button',
    type: 'button',
    ...look,
    disabled: reason !== null,
    'aria-disabled': held && 'true',
    'aria-label': look && label,
    title: held ? `${label}: waiting for the robot to answer` : reason && `${label}: ${reason}`,
    'data-focus': focus,
    onclick: () => {
      if (job.waiting) return;
      // A selection would hold the page as it is, and the press has to show.
      getSelection().removeAllRanges();
      press();
    },
  }, !look && label);
}

/** A button of the schedule. */
function planButton(mine, ...rest) {
  return robotButton(mine.schedule, ...rest);
}

/**
 * The form an event is added or changed through. What is entered goes to the
 * view's `schedule.form` as it is entered, and a new page draws the form from
 * that.
 */
function scheduleForm(mine, robot) {
  const plan = mine.schedule;
  const draft = plan.form;
  const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);
  const choice = (name, values) => h('select', {
    'data-focus': `plan-${name}`,
    onchange: (event) => { draft[name] = event.target.value; },
  }, values.map((value) => h('option', { value, selected: value === draft[name] }, value)));
  const pick = (label, focus, on, set) => h('label', { class: 'pick' },
    h('input', { type: 'checkbox', checked: on, 'data-focus': focus, onchange: (event) => set(event.target.checked) }),
    h('span', null, label));
  const waiting = plan.waiting !== null;
  const button = h('button', {
    class: 'command',
    type: 'submit',
    disabled: !robot.session,
    'aria-disabled': robot.session && waiting && 'true',
    title: !robot.session ? 'Save: the robot is not connected' : waiting && 'Save: waiting for the robot to answer',
    'data-focus': 'plan-save',
  }, 'Save');
  const kept = draft.runs.length > 1 ? `Its ${draft.runs.length} runs stay as they are.`
    : draft.runs[0]?.map != null ? 'The floor plan it cleans stays as it is.'
    : null;
  return h('form', {
    class: 'slot-form',
    onsubmit: (event) => {
      event.preventDefault();
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      if (!plan.waiting) save(mine);
    },
  },
  field('Time', h('input', {
    type: 'time',
    required: '',
    value: draft.time,
    'data-focus': 'plan-time',
    oninput: (event) => { draft.time = event.target.value; },
  })),
  h('fieldset', { class: 'field' },
    h('legend', null, 'Days'),
    h('div', { class: 'picks' }, DAYS.map(([name, label]) => pick(label, `plan-${name}`, draft.days.includes(name), (on) => {
      draft.days = on ? [...draft.days, name] : draft.days.filter((day) => day !== name);
    })))),
  // The settings of a run, where the event has one run to set them for.
  draft.runs.length === 1 && field('Mode', choice('mode', MODES)),
  draft.runs.length === 1 && field('Navigation', choice('navigation', NAVIGATION_MODES)),
  pick('Enabled', 'plan-enabled', draft.enabled, (on) => { draft.enabled = on; }),
  h('div', { class: 'slot-tools' },
    button,
    h('button', {
      class: 'button',
      type: 'button',
      'data-focus': 'plan-cancel',
      onclick: () => {
        getSelection().removeAllRanges();
        plan.form = null;
        plan.said = null;
        drawRobot(mine);
      },
    }, 'Cancel')),
  kept && h('p', { class: 'hint' }, kept));
}

/** An event of the schedule in a row: when it starts, what it cleans, whether it is on, and the ways to change it. */
function slot(mine, robot, event) {
  const plan = mine.schedule;
  // The robot knows an event by its id, so one it gave none can only be shown.
  const id = typeof event.id === 'string' && event.id !== '' ? event.id : null;
  const nameless = id === null ? 'the robot gave this event no id' : null;
  const on = event.enabled === true;
  const days = Array.isArray(event.days) ? event.days : [];
  const all = DAYS.every(([name]) => days.includes(name));
  const toggle = () => askSchedule(mine, 'update', on ? 'Turn off' : 'Turn on', {
    event: JSON.stringify(sent({ ...event, enabled: !on, runs: runsOf(event) })),
  });
  return h('div', { class: `slot${on ? '' : ' off'}` },
    h('strong', { class: 'slot-time' }, plain(event.time)),
    h('span', { class: 'days' },
      days.length === 0 ? none('No days')
        : all ? h('span', { class: 'day' }, 'Every day')
        : days.map((day) => h('span', { class: 'day' }, DAY_LABELS.get(day) ?? String(day)))),
    h('span', { class: 'event-what' }, cleans(runsOf(event))),
    h('div', { class: 'slot-tools' },
      planButton(mine, robot, 'Enabled', `slot-on-${id}`, toggle, nameless,
        { class: 'switch', role: 'switch', 'aria-checked': String(on) }),
      // Deleting is asked twice. The second button takes the place of the first, and the keyboard's focus with it.
      ...(id !== null && plan.dropping === id
        ? [
          planButton(mine, robot, 'Delete it', `slot-drop-${id}`, () => askSchedule(mine, 'delete', 'Delete', { id })),
          planButton(mine, robot, 'Keep', `slot-keep-${id}`, () => {
            plan.dropping = null;
            drawRobot(mine);
          }),
        ]
        : [
          planButton(mine, robot, 'Edit', `slot-edit-${id}`, () => edit(mine, event), nameless),
          planButton(mine, robot, 'Delete', `slot-drop-${id}`, () => {
            plan.dropping = id;
            drawRobot(mine);
          }, nameless),
        ])));
}

/**
 * The robot's schedule as it last gave it, with the ways to change it. The
 * robot keeps the schedule and the server none of it, so there is one to show
 * only once a connected robot has been asked.
 */
function schedulePanel(mine, robot) {
  const plan = mine.schedule;
  const shown = plan.shown;
  const events = shown !== null && Array.isArray(shown.events) ? shown.events.map(record) : [];
  const adding = plan.form !== null && plan.form.id === null;
  const changing = (event) => plan.form !== null && plan.form.id !== null && plan.form.id === event.id;
  const tools = h('div', { class: 'panel-tools' },
    planButton(mine, robot, 'Read again', 'plan-read', () => askSchedule(mine, 'show', 'Schedule')),
    planButton(mine, robot, 'Add', 'plan-add', () => edit(mine, null)));
  const hint = shown === null
    ? 'What the robot cleans by itself, and when. The robot keeps this, so it is read from the robot while it is connected.'
    : ['What the robot cleans by itself, and when, as the robot gave it ', when(plan.at), '. A time is one of the robot\'s own clock.'];
  return panel('Schedule', [
    shown === null && h('p', { class: 'plan-note' }, none(!robot.session ? 'The robot is not connected.'
      : plan.waiting === 'show' ? 'Asking the robot…'
      : 'Not read from the robot.')),
    // The spec gives a schedule this field and no command that sets it.
    shown !== null && shown.enabled === false
      && h('p', { class: 'plan-note warn' }, 'The robot says that its schedule as a whole is off, which nothing here can change.'),
    shown !== null && events.length === 0 && !adding && h('p', { class: 'plan-note' }, none('No events.')),
    events.length > 0 && h('div', { class: 'slots' },
      events.map((event) => (changing(event) ? scheduleForm(mine, robot) : slot(mine, robot, event)))),
    adding && scheduleForm(mine, robot),
    plan.said && h('p', { class: `command-said ${plan.said.tone}`, role: 'status' }, plan.said.text),
  ], { hint, wide: true, tools });
}

// ---- One robot ----

// The commands a robot takes, by the name the server knows each under: the
// label and the icon. The field that says whether the robot would accept one
// now is that name after `can_`.
const COMMANDS = [
  ['start', 'Start', 'play'],
  ['pause', 'Pause', 'pause'],
  ['resume', 'Resume', 'resume'],
  ['cancel', 'Cancel', 'cross'],
  ['return_to_base', 'Return to base', 'dock'],
];

// The steps of a run that a robot gives the time of, under the names it gives
// them, each with its field. The order is the one a run seems to take them
// in, going by those names: out, then back to charge and out again if the
// battery does not last, then back for good.
const AUTONOMY = [
  ['Cleaning start', 'autonomy_cleaning_start'],
  ['Undocking', 'autonomy_undocking'],
  ['Active cleaning session', 'autonomy_active_cleaning_session'],
  ['Docking for suspended', 'autonomy_docking_for_suspended'],
  ['Docking successful suspended', 'autonomy_docking_successful_suspended'],
  ['Suspended charging start', 'autonomy_suspended_charging_start'],
  ['Undocking after suspended', 'autonomy_undocking_after_suspended'],
  ['Active cleaning after suspended', 'autonomy_active_cleaning_after_suspended'],
  ['Docking', 'autonomy_docking'],
  ['Docking verify base', 'autonomy_docking_verify_base'],
  ['Docking successful', 'autonomy_docking_successful'],
];

function gauge(robot) {
  const level = chargeLevel(robot);
  const radius = 42;
  const around = 2 * Math.PI * radius;
  const ring = (name, more) => svg('circle', { class: name, cx: 50, cy: 50, r: radius, ...more });
  return h('div', { class: `gauge ${chargeTone(level)}` },
    svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
      ring('gauge-track'),
      level > 0 && ring('gauge-value', { 'stroke-dasharray': `${(around * level) / 100} ${around}` })),
    h('div', { class: 'gauge-label' }, h('strong', null, chargeText(robot)), h('span', null, 'Charge')));
}

/** How a command went, going by the server's answer to it: what the robot said, or why it said nothing. */
function outcome(label, status, answer) {
  if (status !== 200) return { tone: 'bad', text: `${label}: ${answer?.error ?? 'no answer from the server'}` };
  const { code, body } = answer;
  // The spec gives each of the commands one answer for success, and this is it.
  if (code === 200) return { tone: 'good', text: `${label}: the robot accepted it` };
  const said = isEmpty(body) ? '' : JSON.stringify(body);
  const shown = said.length > ANSWER_LIMIT ? `${said.slice(0, ANSWER_LIMIT)}…` : said;
  const coded = code == null ? 'without a code' : JSON.stringify(code);
  return { tone: 'bad', text: `${label}: the robot answered ${coded} ${shown}`.trimEnd() };
}

/**
 * Whether the robot has yet to send a status since it accepted a command from
 * this view. Until it does, its last one says what it would have accepted
 * before that command, not what it would accept now.
 */
function awaiting(mine) {
  return mine.accepted !== null && !(mine.body?.robot.state_at > mine.accepted.sent);
}

/** Send the robot a command and say under the buttons how it went. */
async function send(mine, name, label) {
  if (mine.command?.waiting || awaiting(mine)) return;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  mine.command = { name, waiting: true };
  drawRobot(mine);
  const address = `api/command?${new URLSearchParams({ ...mine.robot, command: name })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  const said = { name, ...outcome(label, status, answer) };
  mine.command = said;
  // Both times are the server's, as text that sorts by time. The browser's own is for how long to keep asking eagerly.
  if (said.tone === 'good') mine.accepted = { sent: answer.sent, at: Date.now() };
  if (mine !== view) return;
  drawRobot(mine);
  // The robot's new state and the events of this command are worth more now than at the next turn.
  refresh(mine);
  // A command that failed stays said until the next one, so that it can be read.
  if (said.tone === 'good') {
    setTimeout(() => {
      if (mine.command !== said) return;
      mine.command = null;
      drawRobot(mine);
    }, ACCEPTED_MS);
  }
}

/**
 * The commands as buttons, and under them how the last one sent went. One can
 * be pressed when the robot is connected and its last state said it would
 * accept that command. From when one is sent until the robot has answered and,
 * if it accepted, sent its next status, pressing any of them does nothing.
 */
function commands(mine, robot) {
  const sent = mine.command;
  const hold = sent?.waiting ? 'waiting for the robot to answer'
    : awaiting(mine) ? 'waiting for the robot\'s next status'
    : null;
  return [
    h('div', { class: 'commands' }, COMMANDS.map(([name, label, glyph]) => {
      const value = robot[`can_${name}`];
      const why = !robot.session ? 'the robot is not connected'
        : isOn(value) ? null
        : isOff(value) ? 'the robot would not accept it now'
        : 'the robot has not said whether it would accept it';
      // Held back, not disabled: a disabled button could not keep the keyboard's focus.
      const held = why === null && hold !== null;
      return h('button', {
        class: `command${sent?.waiting && sent.name === name ? ' busy' : ''}`,
        type: 'button',
        disabled: why !== null,
        'aria-disabled': held && 'true',
        title: held ? `${label}: ${hold}` : why && `${label}: ${why}`,
        'data-focus': `can_${name}`,
        onclick: () => send(mine, name, label),
      }, icon(glyph), label);
    })),
    sent && !sent.waiting && h('p', { class: `command-said ${sent.tone}`, role: 'status' }, sent.text),
  ];
}

/** Shut the field for the robot's name, and put the keyboard back on the button that opened it. */
function endNaming(mine) {
  mine.naming.draft = null;
  mine.naming.said = null;
  // A selection would hold the page as it is, and so would the field while the keyboard is in it.
  getSelection().removeAllRanges();
  if (entering()) document.activeElement.blur();
  drawRobot(mine);
  app.querySelector('[data-focus="rename"]')?.focus();
}

/** Ask the server to call the robot what the field holds, or by its serial again when it holds nothing. */
async function rename(mine) {
  const naming = mine.naming;
  naming.waiting = true;
  naming.said = null;
  drawRobot(mine);
  const address = `api/name?${new URLSearchParams({ ...mine.robot, name: naming.draft })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  naming.waiting = false;
  if (mine !== view) return;
  if (status !== 200) {
    naming.said = { tone: 'bad', text: `Rename: ${answer?.error ?? 'no answer from the server'}` };
    drawRobot(mine);
    return;
  }
  // The answer has the name as the server keeps it. It goes on the page now, and an
  // answer that was asked for before the change, which has the old one, is dropped.
  if (mine.body) mine.body.robot.name = answer.name;
  endNaming(mine);
  refresh(mine);
}

/** Ask the server to delete the robot, and go to the list of the others once it has. */
async function forget(mine) {
  const deleting = mine.deleting;
  deleting.waiting = true;
  deleting.said = null;
  drawRobot(mine);
  const address = `api/delete?${new URLSearchParams(mine.robot)}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  deleting.waiting = false;
  if (mine !== view) return;
  if (status !== 200) {
    deleting.said = { tone: 'bad', text: `Delete: ${answer?.error ?? 'no answer from the server'}` };
    drawRobot(mine);
    return;
  }
  // The robot has no page any more.
  location.hash = '#/';
}

/** A button of the robot's deleting, which does nothing while the server has yet to answer. */
function deleteButton(mine, label, focus, press, glyph) {
  const button = h('button', {
    class: 'button',
    type: 'button',
    // Held back, not disabled: a disabled button could not keep the keyboard's focus.
    'aria-disabled': mine.deleting.waiting && 'true',
    'data-focus': focus,
    onclick: () => {
      if (mine.deleting.waiting) return;
      // The field for the name would hold the page as it is while the keyboard is in it, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      press();
    },
  }, glyph && icon(glyph), label);
  return button;
}

/** Ask whether the robot is to be deleted, or take that back, and put the keyboard on Keep or back on Delete. */
function askDelete(mine, asked) {
  mine.deleting.asked = asked;
  mine.deleting.said = null;
  drawRobot(mine);
  app.querySelector(`[data-focus="${asked ? 'delete-keep' : 'delete'}"]`)?.focus();
}

/**
 * What deleting the robot would do, and the two answers to that. Deleting is
 * asked twice, and the second time here, under the name and not where the
 * button that asked first was, so that pressing that one twice deletes nothing.
 */
function deleteQuestion(mine) {
  const deleting = mine.deleting;
  return deleting.asked && h('div', { class: 'confirm' },
    h('p', null, 'Delete this robot? Its state, its events, its maps and its name are deleted from the database, '
      + 'and so is its key, if the server keeps one for it. If it is connected, its connection is ended. '
      + 'None of this can be undone. A robot that can still log in is listed again, as a new one, once it connects.'),
    h('div', { class: 'slot-tools' },
      deleteButton(mine, 'Delete it', 'delete-it', () => forget(mine)),
      deleteButton(mine, 'Keep', 'delete-keep', () => askDelete(mine, false))),
    deleting.said && h('p', { class: `command-said ${deleting.said.tone}`, role: 'status' }, deleting.said.text));
}

/**
 * What the robot is called, beside the button that opens a field to change it
 * and the one that asks whether to delete the robot, or else that field. What
 * is entered goes to the view's `naming.draft` as it is entered, and a new page
 * draws the field from that.
 */
function nameLine(mine, robot) {
  const naming = mine.naming;
  if (naming.draft === null) {
    return h('div', { class: 'hero-name' },
      called('h1', robot),
      h('button', {
        class: 'button',
        type: 'button',
        'data-focus': 'rename',
        onclick: () => {
          naming.draft = robot.name ?? '';
          // A selection would hold the page as it is, and the press has to show.
          getSelection().removeAllRanges();
          drawRobot(mine);
          const field = app.querySelector('[data-focus="name"]');
          field?.focus();
          field?.select();
        },
      }, icon('pencil'), 'Rename'),
      // Gone while the question it asks is under the name.
      !mine.deleting.asked && deleteButton(mine, 'Delete', 'delete', () => askDelete(mine, true), 'trash'));
  }
  const save = h('button', {
    class: 'command',
    type: 'submit',
    'aria-disabled': naming.waiting && 'true',
    'data-focus': 'name-save',
  }, 'Save');
  return h('form', {
    class: 'name-form',
    onsubmit: (event) => {
      event.preventDefault();
      // The field would hold the page as it is while the keyboard is in it, as a selection would, and the press has to show.
      save.focus();
      getSelection().removeAllRanges();
      if (!naming.waiting) rename(mine);
    },
  },
  h('input', {
    type: 'text',
    value: naming.draft,
    maxlength: NAME_MAX,
    placeholder: robot.serial,
    autocomplete: 'off',
    'aria-label': 'Name',
    'data-focus': 'name',
    oninput: (event) => { naming.draft = event.target.value; },
    // Not the Escape that ends the composing of a character.
    onkeydown: (event) => { if (event.key === 'Escape' && !event.isComposing) endNaming(mine); },
  }),
  save,
  h('button', { class: 'button', type: 'button', 'data-focus': 'name-cancel', onclick: () => endNaming(mine) }, 'Cancel'),
  h('p', { class: 'hint' }, 'Only this server knows the name. Left empty, the robot goes by its board serial.'),
  naming.said && h('p', { class: `command-said ${naming.said.tone}`, role: 'status' }, naming.said.text));
}

function hero(mine, robot) {
  return h('section', { class: 'card hero' },
    h('div', { class: 'avatar' }, icon('robot')),
    h('div', { class: 'hero-main' },
      nameLine(mine, robot),
      deleteQuestion(mine),
      h('div', { class: 'pills' },
        presence(robot),
        statePill(robot),
        actionPill(robot),
        isOn(robot.is_docked) && pill('quiet', 'Docked', 'dock'),
        isOn(robot.is_charging) && pill('quiet', 'Charging', 'bolt')),
      commands(mine, robot)),
    gauge(robot));
}

function panel(title, body, { hint, wide, tools } = {}) {
  return h('section', { class: `card panel${wide ? ' wide' : ''}` },
    h('div', { class: 'panel-head' }, h('h2', null, title), tools),
    hint && h('p', { class: 'hint' }, hint),
    body);
}

function rows(pairs) {
  return h('dl', { class: 'kv' }, pairs.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, value))));
}

function errors(robot) {
  const value = parsed(robot.errors);
  if (isEmpty(value)) return none('None');
  return h('span', { class: 'mono bad' }, typeof value === 'string' ? value : JSON.stringify(value));
}

function connection(robot) {
  const session = robot.session;
  return rows([
    ['Status', presence(robot)],
    ...(session ? [
      ['Address', h('span', { class: 'mono' }, session.address)],
      ['Connected', moment(session.since)],
    ] : []),
    ['Last heartbeat', moment(robot.heartbeat_at)],
    ['Last status', moment(robot.state_at)],
  ]);
}

/** The autonomy states that have a field each, or a word for the robot having sent none. */
function autonomy(robot) {
  const sent = parsed(robot.autonomy_states);
  if (sent == null) return none('Not reported');
  if (isEmpty(sent)) return none('Empty');
  return rows([
    ['Started on base', flag(robot.autonomy_started_on_base)],
    ...AUTONOMY.map(([label, field]) => [label, step(robot[field])]),
  ]);
}

/** The whole state as the robot last sent it. */
function rawState(robot) {
  const state = robot.state_json == null ? null : pretty(robot.state_json);
  return panel('Raw state', state == null ? none('The robot has not sent a state yet.') : code(state), {
    hint: 'Everything in the robot\'s last state, including what this page has no field for.',
    wide: true,
    tools: state != null && copyButton(state),
  });
}

/** What the robot's last state and its connection say, a panel to each subject. */
function statusPanels(robot) {
  return [
    panel('Status', rows([
      ['State', plain(robot.state)],
      ['Action', plain(robot.action)],
      ['Errors', errors(robot)],
    ])),
    panel('Connection', connection(robot)),
    panel('Battery', rows([
      ['Charge', chargeText(robot)],
      ['Charging', flag(robot.is_charging)],
    ])),
    panel('Robot', rows([
      ['Vendor', plain(vendorName(robot))],
      // What the robot logs in as, and what it goes by until it is given a name.
      ['Board serial', h('span', { class: 'mono' }, robot.serial)],
      // Known from the login, so only while the robot is connected.
      ['Firmware version', robot.session ? plain(robot.session.firmware) : none('Not connected')],
    ])),
    panel('Base', rows([
      ['Docked', flag(robot.is_docked)],
      ['Base type', plain(robot.base_type)],
      ['Quick boost', flag(robot.is_quickboost)],
      ['Quick boost estimate', plain(robot.quickboost_estimate)],
      ['Bag status', plain(robot.bag_status)],
      ['Base error', plain(robot.base_error)],
      ['Extracting', flag(robot.is_extracting)],
    ])),
    panel('Last run', autonomy(robot)),
  ];
}

// The tabs of a robot's page, in the order they stand in: the name the view
// keeps each under, its label, and what builds its panels from the view and
// the server's answer. Only the one that is shown is built.
const TABS = [
  ['status', 'Status', (mine, { robot }) => statusPanels(robot)],
  ['schedule', 'Schedule', (mine, { robot }) => schedulePanel(mine, robot)],
  ['maps', 'Maps', (mine, body) => [
    floorPanel(mine, body),
    panel('Maps', mapList(mine, body), {
      hint: 'What the robot mapped on a run, newest first. It uploads a map at each pause of a run and at its end.',
      wide: true,
    }),
  ]],
  ['events', 'Events', (mine, { events, more }) => panel('Events', eventLog(mine, events, more), {
    hint: 'Logins, disconnects, commands and what the robot sent, newest first. States and heartbeats are not logged.',
    wide: true,
  })],
  ['debug', 'Debug', (mine, { robot }) => rawState(robot)],
];

// The keys that move along the tabs, each with where it goes from the tab at `at` of `count`.
const TAB_KEYS = new Map([
  ['ArrowLeft', (at, count) => (at + count - 1) % count],
  ['ArrowRight', (at, count) => (at + 1) % count],
  ['Home', () => 0],
  ['End', (at, count) => count - 1],
]);

/** Show another tab of the robot's page, and put the keyboard on it. */
function choose(mine, name) {
  mine.tab = name;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  drawRobot(mine);
  app.querySelector(`[data-focus="tab-${name}"]`)?.focus();
}

/**
 * The tabs as buttons. The Tab key stops at the one that is shown, and the
 * arrow keys, Home and End move along them, showing the tab they move to.
 */
function tabList(mine) {
  const at = TABS.findIndex(([name]) => name === mine.tab);
  return h('div', {
    class: 'tabs',
    role: 'tablist',
    'aria-label': 'Robot',
    onkeydown: (event) => {
      const to = TAB_KEYS.get(event.key);
      // With a modifier, an arrow is the browser's own: back and forward, among others.
      if (!to || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      choose(mine, TABS[to(at, TABS.length)][0]);
    },
  }, TABS.map(([name, label]) => h('button', {
    class: 'tab',
    type: 'button',
    role: 'tab',
    id: `tab-${name}`,
    'aria-selected': String(name === mine.tab),
    'aria-controls': name === mine.tab && 'tabpanel',
    tabindex: name === mine.tab ? '0' : '-1',
    'data-focus': `tab-${name}`,
    onclick: () => choose(mine, name),
  }, label)));
}

/** A robot's page: what is said of the robot whichever tab is shown, then the tabs, then the panels of the one that is. */
function robotPage(mine, body) {
  const [, , build] = TABS.find(([name]) => name === mine.tab);
  return h('div', null,
    h('a', { class: 'back', href: '#/', 'data-focus': 'back' }, icon('back'), 'All robots'),
    hero(mine, body.robot),
    tabList(mine),
    // A stop for the Tab key, since the panels of some tabs hold nothing the keyboard can go to.
    h('div', {
      class: 'panels',
      role: 'tabpanel',
      id: 'tabpanel',
      'aria-labelledby': `tab-${mine.tab}`,
      tabindex: '0',
      'data-focus': 'tabpanel',
    }, build(mine, body)));
}

// ---- Fetching and drawing ----

function skeleton(robot) {
  const bone = (kind) => h('div', { class: `skeleton ${kind}` });
  return robot
    ? h('div', null, bone('banner'), bone('strip'), h('div', { class: 'panels' }, bone('block'), bone('block')))
    : h('div', null,
      h('div', { class: 'heading' }, bone('title'), bone('line')),
      h('div', { class: 'grid' }, bone('tile'), bone('tile'), bone('tile')));
}

/** The robot the address names, or null for the list. */
function robotInAddress() {
  const match = /^#\/robots\/([^/]+)\/([^/]+)$/.exec(location.hash);
  if (!match) return null;
  try {
    return { vendor: decodeURIComponent(match[1]), serial: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function endpoint({ robot, asked }) {
  return robot ? `api/robot?${new URLSearchParams({ ...robot, ...asked })}` : 'api/robots';
}

function setLive(state, text) {
  live.dataset.state = state;
  liveText.textContent = text;
}

/** Whether the reader has text on the page selected, which redrawing would undo. */
function selecting() {
  const selection = getSelection();
  return !selection.isCollapsed && app.contains(selection.anchorNode);
}

/** Whether the reader is at a field of a form, which a new page would take them out of. */
function entering() {
  const at = document.activeElement;
  return app.contains(at) && at.matches('input, select');
}

/** Put `build()` on screen unless `data`, which it is built from, is what is already there. */
function draw(mine, data, build) {
  const drawn = JSON.stringify(data);
  if (drawn === mine.drawn || selecting() || entering()) return;
  // Whatever had the keyboard's focus is replaced too, so hand it to its successor.
  // It is asked for first: building the page takes the pictures of the maps out of the old one.
  const focus = document.activeElement?.dataset?.focus;
  const page = build();
  if (mine.drawn === null) page.classList.add('enter');
  mine.drawn = drawn;
  app.replaceChildren(page);
  if (focus) app.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}

/** Draw the robot's page from the server's last answer and what its view holds, which a press on the page changes between answers. */
function drawRobot(mine) {
  const body = mine.body;
  if (mine !== view || !body) return;
  const data = [
    body.robot, body.events, body.more, body.maps, body.more_maps, body.floorplans, mine.tab, mine.naming, mine.command,
    mine.accepted, mine.schedule, mine.floors, mine.deleting,
  ];
  draw(mine, data, () => robotPage(mine, body));
}

function show(mine, status, body) {
  const missing = status === 404 && mine.robot && body?.error;
  if (status !== 200 && !missing) {
    // No answer at all, or one that says what went wrong. What is on screen stays.
    setLive('down', body?.error ? 'Server error' : 'Reconnecting');
    noticeText.textContent = body?.error
      ? `The server could not answer: ${body.error}`
      : 'Cannot reach the server. Trying again every few seconds.';
    notice.hidden = false;
    return;
  }
  setLive('ok', 'Live');
  notice.hidden = true;
  if (missing) {
    mine.body = null;
    const { vendor, serial } = mine.robot;
    draw(mine, null, () => message('Robot not found',
      `${vendor}/${serial} is not in the database. A robot appears once it has connected and sent a state or a heartbeat.`,
      true));
  } else {
    clockOffset = Date.parse(body.now) - Date.now();
    if (mine.robot) {
      mine.body = body;
      document.title = `${nameOf(body.robot)} · deorbit`;
      // The schedule is asked for once of each connection the page sees, not at every turn: asking is a call to the robot.
      const since = body.robot.session?.since;
      if (since && mine.schedule.asked !== since) askSchedule(mine, 'show', 'Schedule');
      drawRobot(mine);
    } else {
      mine.body = body;
      draw(mine, body.robots, () => listPage(mine, body.robots));
    }
  }
}

/** The status and the JSON the server answers with, or 0 and null when it is unreachable, too slow or answers with something else. */
async function ask(address, controller, patience, method = 'GET') {
  const timeout = setTimeout(() => controller.abort(), patience);
  try {
    const response = await fetch(address, { method, signal: controller.signal, cache: 'no-store' });
    return [response.status, await response.json()];
  } catch {
    return [0, null];
  } finally {
    clearTimeout(timeout);
  }
}

async function load(mine) {
  const controller = new AbortController();
  mine.controller = controller;
  const [status, body] = await ask(endpoint(mine), controller, FETCH_TIMEOUT_MS);
  // Dropped when the view was left, or when `refresh` has asked again since.
  if (mine !== view || mine.controller !== controller) return;
  show(mine, status, body);
  // The status that follows a command comes within a moment, and the commands are held back until it is here.
  const eager = awaiting(mine) && Date.now() - mine.accepted.at < EAGER_FOR_MS;
  mine.timer = setTimeout(() => {
    // Nobody is looking at a hidden tab; `visibilitychange` picks this up again.
    if (document.hidden) mine.paused = true;
    else load(mine);
  }, eager ? EAGER_POLL_MS : POLL_MS);
}

/** Fetch the view again now, not at its next turn. */
function refresh(mine) {
  clearTimeout(mine.timer);
  mine.controller?.abort();
  load(mine);
}

function navigate() {
  if (view) {
    clearTimeout(view.timer);
    view.controller?.abort();
    // The dialog is no part of the page, so it does not go with it.
    if (view.adding) closeAdd(view);
  }
  const mine = {
    robot: robotInAddress(),
    tab: TABS[0][0],
    asked: { events: EVENTS_STEP, maps: MAPS_STEP },
    open: new Set(),
    openMaps: new Set(),
    drawings: new Map(),
    // The name in the field, when the field is open; whether the server has yet to answer; and how the last one failed.
    naming: { draft: null, waiting: false, said: null },
    command: null,
    accepted: null,
    // The connection the schedule was last asked of, by when it began; what is waited for; what the robot gave
    // and when; how the last request failed; the form, when one is open; and the event about to be deleted.
    schedule: { asked: null, waiting: null, shown: null, at: null, said: null, form: null, dropping: null },
    // Whether the robot has yet to answer what was asked of it about a floor plan; what awaits its second press;
    // and how the last request went, with the map it was pressed on.
    floors: { waiting: false, asking: null, said: null },
    // Whether deleting the robot has been asked for and awaits its second press; whether the server has yet to answer; and how it failed.
    deleting: { asked: false, waiting: false, said: null },
    // The add-robot dialog, over the list: null while shut, else the log lines, whether it is running or done,
    // how it failed, whether the server has yet to say its address and certificate, and what it gave.
    adding: null,
    body: null,
    drawn: null,
    controller: null,
    timer: 0,
    paused: false,
  };
  view = mine;
  // By its serial until the server has said what the robot is called.
  document.title = `${mine.robot ? mine.robot.serial : 'Robots'} · deorbit`;
  app.replaceChildren();
  scrollTo(0, 0);
  setTimeout(() => {
    if (mine === view && mine.drawn === null) app.replaceChildren(skeleton(mine.robot));
  }, SKELETON_MS);
  load(mine);
}

addEventListener('hashchange', navigate);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && view?.paused) {
    view.paused = false;
    load(view);
  }
});
setInterval(tick, 1000);
navigate();
