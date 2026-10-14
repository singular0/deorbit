// The web UI: the robots in the server's database as a list, and a page for
// each with its name, its schedule, its maps and floor plans with their zones
// and no-go lines, its settings, its events, the commands it takes and the way
// to delete it.
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
const FIT_MOST = 8; // the most pixels of the page a cell of a small map is enlarged to, to be shown whole
const CELL_MOST = 32; // the most a cell of a map is enlarged to by zooming in
const ZOOM_STEP = 2; // how much a press of Zoom in enlarges a map, and one of Zoom out shrinks it
const PAN_STEP = 48; // how far an arrow key moves a map that is larger than its window, in pixels of the page
const NAME_MAX = 64; // the most characters the server takes for a robot's name
const ZONE_NAME_MAX = 32; // the same for the name of a zone of a floor plan
const LINES_MAX = 100; // and the most no-go lines a floor plan may have
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
// the robot's schedule and its settings and what is being done to them, what is
// being asked of the robot about a floor plan, what is being drawn of the zones
// and no-go lines of one, whether the robot is being deleted, the server's
// last answer, what was last drawn and the fetch under
// way. Navigating makes a new one, and a fetch that returns to find its view
// replaced drops the result.
let view = null;

// The canvas of a map that is being dragged about or drawn on, which a new page
// would take out of the document and so let go of.
let dragged = null;

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

function pill(tone, text, glyph, ...parts) {
  return h('span', { class: `pill ${tone}` }, glyph && icon(glyph), text, ...parts);
}

/** The second part of a pill, behind a line from its top to its bottom. */
function pillPart(glyph, text) {
  // A space that is not laid out, for whatever reads the two parts as one text.
  return [' ', h('span', { class: 'pill-part' }, icon(glyph), text)];
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

/** The tone a charge is shown in: green, yellow from 40% down and red from 15%, or none when the robot sent no number. */
function chargeTone(robot) {
  if (typeof robot.charge !== 'number') return 'quiet';
  return robot.charge <= 15 ? 'bad' : robot.charge <= 40 ? 'warn' : 'good';
}

function chargeText(robot) {
  return typeof robot.charge === 'number' ? `${robot.charge}%` : plain(robot.charge);
}

/** The estimate of a quick boost as the robot gave it, which is -1 when it has none. */
function boostEstimate(robot) {
  return robot.quickboost_estimate === -1 ? none() : plain(robot.quickboost_estimate);
}

/**
 * What a battery is doing besides holding its charge, or null for nothing: a
 * quick boost, which is a charging too, or else charging. The spec has the
 * estimate of a quick boost as the charge it is to reach, in percent.
 */
function charging(robot) {
  if (isOn(robot.is_quickboost)) {
    const target = robot.quickboost_estimate;
    return typeof target === 'number' && target !== -1 ? `Quick boost to ${target}%` : 'Quick boost';
  }
  return isOn(robot.is_charging) ? 'Charging' : null;
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

/** A time in full, with its day of the week: what a pointer that rests on a time is told. */
function fullTime(at) {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' });
}

/** A timestamp as "5 s ago", which `tick` keeps current, with the day, the date and the time it was in its tooltip. */
function when(stamp) {
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return plain(stamp);
  return h('time', { datetime: stamp, title: fullTime(at), 'data-at': at }, ago(at));
}

/** A time as "01.01.2000 12:30", by the browser's clock. */
function numeric(at) {
  const date = new Date(at);
  const two = (number) => String(number).padStart(2, '0');
  const day = `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()}`;
  return `${day} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** A timestamp as `numeric` gives it, with the day, the date and the time in full in its tooltip. */
function dated(stamp) {
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return plain(stamp);
  return h('time', { datetime: stamp, title: fullTime(at) }, numeric(at));
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

// The tone and the icon of each state the spec lists, and the icon of each
// action it lists but `invalid`, which is never shown. A state that is none of
// these is quiet, with the icon of `busy`, and such an action has `route`.
const STATES = new Map([
  ['idle', ['quiet', 'idle']],
  ['busy', ['accent', 'pulse']],
  ['paused', ['warn', 'pause']],
  ['error', ['bad', 'alert']],
]);
const ACTIONS = new Map([
  ['cleaning', 'sparkle'],
  ['cleaning_standby', 'hourglass'],
  ['docking', 'dock'],
  ['diagnostic_test', 'flask'],
  ['updating_software', 'download'],
]);

/** The action to show behind the state, as the robot sent it, or null for none: it sent none, or `invalid`. */
function actionShown(robot) {
  if (robot.action == null || robot.action === '' || robot.action === 'invalid') return null;
  return String(robot.action);
}

/** The state, in its tone and with its icon, and behind a line the action, with its own, where there is one to show. */
function statePill(robot) {
  const doing = actionShown(robot);
  const part = doing !== null && pillPart(ACTIONS.get(doing) ?? 'route', doing);
  if (robot.state == null) return pill('quiet', 'No state yet', 'pulse', part);
  const [tone, glyph] = STATES.get(String(robot.state)) ?? ['quiet', 'pulse'];
  return pill(tone, String(robot.state), glyph, part);
}

/**
 * The charge, in the tone of how much it is, and behind a line what the battery
 * is doing where it is charging. Nothing for a robot that gave neither.
 */
function batteryPill(robot) {
  const doing = charging(robot);
  if (robot.charge == null && doing === null) return false;
  return pill(chargeTone(robot), h('span', null, 'Battery: ', chargeText(robot)), 'battery',
    doing !== null && pillPart('bolt', doing));
}

// ---- The list ----

/** What else a card says of its robot, or nothing when there is nothing to say. */
function facts(robot) {
  return hasErrors(robot) && h('div', { class: 'facts' }, h('span', { class: 'fact bad' }, icon('alert'), 'Reports errors'));
}

function card(robot) {
  return h('a', { class: `card robot${robot.session ? ' online' : ''}`, href: hrefOf(robot), 'data-focus': hrefOf(robot) },
    called('strong', robot),
    facts(robot),
    h('div', { class: 'robot-foot' },
      h('div', { class: 'robot-pills' }, presence(robot), statePill(robot), batteryPill(robot)),
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

// ---- The tables of one robot ----
//
// The robot's events and its maps are each a table, and the two are of one
// design: the names of the columns, then a row to each, which opens on more.
// A column is its name, the kind of cell it holds, which is what the
// stylesheet goes by, and whether its name is set before the cell on a narrow
// screen, where the rows stand without the names over them.

/**
 * A row of a table, with what is under it. It gives a cell to each of the
 * table's `columns` as `cells`; `tools`, the buttons that stand at its end,
 * where the table is `tooled`, which is to say has a column for them; `note`,
 * a line of its own under it; and `detail`, which gives what it opens on. The
 * row itself is what opens it, at a press or from the keyboard, so it is a
 * stop for the Tab key, which `focus` names to the keyboard's focus. `open` is
 * the view's set of the rows that are open, by `id`. A row that is `dim` is
 * set quieter than the others, and one that is `pinned` is open and cannot be
 * shut, as a row is while the form it opens on is being filled in.
 */
function entry(columns, open, tooled, { id, focus, cells, tools, note, detail, dim, pinned }) {
  const width = columns.length + (tooled ? 1 : 0);
  const opened = pinned || open.has(id);
  // The detail is laid out when the row is first opened: most rows never are.
  const under = h('td', { colspan: width });
  const below = h('tr', { class: 'entry-detail', id: `${focus}-detail`, hidden: !opened }, under);
  const toggle = () => {
    if (pinned) return;
    const shown = !open.has(id);
    if (shown) open.add(id);
    else open.delete(id);
    if (shown && !under.hasChildNodes()) under.append(...detail());
    below.hidden = !shown;
    row.setAttribute('aria-expanded', String(shown));
  };
  const row = h('tr', {
    class: 'entry-row',
    tabindex: '0',
    'aria-expanded': String(opened),
    'aria-controls': below.id,
    'data-focus': focus,
    onclick: (event) => {
      // A press on a button of the row is that button's, and one that ends the selecting of text opens nothing.
      if (!event.target.closest('button') && getSelection().isCollapsed) toggle();
    },
    onkeydown: (event) => {
      // Enter and the space bar while the keyboard is on the row itself, not on a button of it.
      if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      toggle();
    },
  },
  cells.map((cell, n) => h('td', { class: `cell-${columns[n][1]}`, 'data-label': columns[n][2] && columns[n][0] }, cell)),
  tooled && h('td', { class: 'cell-tools' }, h('div', { class: 'entry-tools' }, tools)));
  // A row that was open stays open when the page is drawn again.
  if (opened) under.append(...detail());
  return h('tbody', { class: dim ? 'entry dim' : 'entry' },
    row,
    note && h('tr', { class: 'entry-note' }, h('td', { colspan: width }, note)),
    below);
}

/**
 * A table of rows that open: the names of its `columns`, then `rows`, each as
 * `entry` takes one. `label` names it to a screen reader. It has a column for
 * the buttons of its rows where any row has some.
 */
function table(label, columns, open, rows) {
  const tooled = rows.some((row) => row.tools);
  return h('table', { class: 'table', 'aria-label': label },
    h('thead', null, h('tr', null,
      columns.map(([title, kind]) => h('th', { class: `cell-${kind}`, scope: 'col' }, title)),
      // Over the buttons of a row, which need no name to the eye.
      tooled && h('th', { class: 'cell-tools', scope: 'col', 'aria-label': 'Actions' }))),
    rows.map((row) => entry(columns, open, tooled, row)));
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

// The columns of the events: when one happened, what it was, and what its body says in a line.
const EVENT_COLUMNS = [['Time', 'time'], ['Event', 'kind'], ['Details', 'what']];

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

/** An event as a row of the table. */
function eventRow(event) {
  const known = event.service == null ? CONNECTION.get(event.kind) : SERVICES.get(event.service);
  const [label, glyph, tone, says] = known ?? [String(event.service ?? event.kind), 'message', 'quiet', () => []];
  const said = says(record(parsed(event.body_json))).filter(Boolean).join(' · ');
  return {
    id: event.id,
    focus: `event-${event.id}`,
    cells: [dated(event.at), pill(tone, label, glyph), said || null],
    detail: () => eventDetail(event),
  };
}

/** The robot's events, newest first. */
function eventLog(mine, events, more) {
  if (events.length === 0) return none('Nothing yet.');
  return [table('Events', EVENT_COLUMNS, mine.open, events.map(eventRow)), older(mine, 'events', more)];
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

/** What these runs were set to under `name`: one value where they agree, as the one run of most maps does with itself. */
function setting(runs, name) {
  const values = [...new Set(runs.map((run) => word(record(run.settings)[name])).filter(Boolean))];
  return values.length > 0 ? values.join(', ') : none();
}

/** What a map says of its run that its row does not, beside the picture. */
function mapFacts(map, runs) {
  const timing = record(map.timing);
  return rows([
    // As the start is in the row: the date and the time, and the rest to a pointer that rests on it.
    ['End time', dated(timing.end)],
    ['Paused for', typeof timing.pause === 'number' ? lasting(timing.pause) : plain(timing.pause)],
    ['Started by', plain(map.started_by)],
    ['Cleaning complete', flag(map.cleaning_complete)],
    ['Mode', setting(runs, 'mode')],
    ['Navigation', setting(runs, 'navigation_mode')],
    // The row of a map of more runs than one has only how many they were and what they cleaned between them.
    ...(runs.length > 1 ? runs.map((run, n) => {
      const said = [word(run.state), areaOf([run])].filter(Boolean);
      return [`Run ${n + 1}`, said.length > 0 ? said.join(' · ') : none()];
    }) : []),
  ]);
}

/** The colours of the pictures of maps for the page's scheme as it is now. */
function schemePalette() {
  return PALETTES[matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'];
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

/** Hold a button back, or let it be pressed again. Held back, not disabled, it keeps the keyboard's focus. */
function hold(button, held) {
  if (held) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
}

// The arrow keys, and which way each moves what the window of a map shows.
const PAN_KEYS = new Map([['ArrowLeft', [-1, 0]], ['ArrowRight', [1, 0]], ['ArrowUp', [0, -1]], ['ArrowDown', [0, 1]]]);

/**
 * The window a map is shown in, of one size and shape whatever the map's.
 * `source` is the map at a pixel to a cell, and `marks` are the places on it,
 * in cells. The map is shown whole at first. Zoom in and Zoom out enlarge and
 * shrink it about the middle of the window, a step at a time, and while it is
 * larger than the window it is dragged about, or moved with the arrow keys
 * where the keyboard is on it. The canvas is as large as the window, in the
 * screen's pixels, and is drawn anew at each change, so that the marks keep
 * their size. `which` tells the buttons of one window from those of another.
 *
 * `layer`, where there is one, is what is drawn over the map, between it and
 * the marks: the zones and the no-go lines of a floor plan (`trackLayer`).
 * While it is being drawn on, a drag draws rather than moves the map, until
 * the button beside the zoom buttons is pressed. What is returned is the
 * window and what draws it anew, for when what the layer draws has changed.
 */
function viewer(source, marks, palette, which, layer = null) {
  const [across, down] = [source.width, source.height];
  let [wide, high, ratio] = [0, 0, 1]; // the window in pixels of the page, once it is laid out, and the screen's to one of those
  let scale = 0; // the pixels of the page to a cell
  let fitted = true; // whether the map is shown whole, as it stays when the window changes size
  let [middleX, middleY] = [across / 2, down / 2]; // the point of the map in the middle of the window, in cells
  let drag = null; // the pointer that drags the map or draws on it, and where it was last
  let shown = { left: 0, top: 0, cell: 1 }; // where the map was last drawn on the canvas, in the screen's pixels

  // A whole number of the screen's pixels to a cell keeps the cells alike, where a cell is a pixel or more.
  // The map shown whole is not held to that, which would leave much of the window empty around a large one.
  const even = (cell) => (cell * ratio >= 1 ? Math.round(cell * ratio) / ratio : cell);
  const whole = () => Math.min(wide / across, high / down, FIT_MOST);
  const larger = () => across * scale > wide + 0.5 || down * scale > high + 0.5;
  // Along a side the map is larger than, the window stays on the map; along one it is not, the map is in its middle.
  const keep = (middle, cells, room) => {
    const half = room / 2 / scale;
    return cells * scale <= room + 0.5 ? cells / 2 : Math.min(cells - half, Math.max(half, middle));
  };
  const show = () => {
    if (wide === 0) return;
    const fit = whole();
    // A step out that ends barely short of showing the map whole shows it whole.
    fitted ||= scale < fit * 1.25;
    scale = fitted ? fit : Math.min(CELL_MOST, scale);
    middleX = keep(middleX, across, wide);
    middleY = keep(middleY, down, high);
    // Set only when it changes, which clears the canvas and makes it anew.
    const [width, height] = [Math.round(wide * ratio), Math.round(high * ratio)];
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const pen = canvas.getContext('2d');
    pen.fillStyle = `rgb(${palette.unseen})`;
    pen.fillRect(0, 0, canvas.width, canvas.height);
    const cell = scale * ratio;
    // The corner of the map on a whole pixel of the screen, so that its cells are alike there too.
    const left = Math.round(canvas.width / 2 - middleX * cell);
    const top = Math.round(canvas.height / 2 - middleY * cell);
    // Shrunk, or barely enlarged, the map is smoothed, which keeps a wall of one cell from going missing
    // or coming out twice as thick in places; enlarged further, its cells stay sharp.
    pen.imageSmoothingEnabled = cell < 2;
    pen.imageSmoothingQuality = 'high';
    pen.drawImage(source, left, top, across * cell, down * cell);
    layer?.paint(pen, (x, y) => [left + x * cell, top + y * cell], cell, ratio);
    for (const mark of marks) stamp(pen, { ...mark, x: left + mark.x * cell, y: top + mark.y * cell }, palette, ratio);
    shown = { left, top, cell };
    const drawing = layer !== null && layer.draws();
    frame.classList.toggle('drawing', drawing);
    frame.classList.toggle('pannable', larger() && !drawing);
    // The Tab key stops at the map only where the arrow keys move it.
    if (larger()) canvas.tabIndex = 0;
    else canvas.removeAttribute('tabindex');
    hold(zoomIn, scale >= CELL_MOST);
    hold(zoomOut, fitted);
    if (moveButton) {
      moveButton.hidden = !layer.editing();
      moveButton.setAttribute('aria-pressed', String(layer.editing() && !drawing));
    }
  };
  const zoom = (by) => {
    scale = Math.min(CELL_MOST, even(scale * by));
    fitted = false;
    show();
  };
  // By so many pixels of the page.
  const move = (x, y) => {
    middleX += x / scale;
    middleY += y / scale;
    show();
  };
  // Where a pointer is on the map, in its cells from the left and from the top, which need not be whole.
  const cellAt = (event) => {
    const box = canvas.getBoundingClientRect();
    return [
      ((event.clientX - box.left) * ratio - shown.left) / shown.cell,
      ((event.clientY - box.top) * ratio - shown.top) / shown.cell,
    ];
  };
  const letGo = (event) => {
    if (drag?.pointer !== event.pointerId) return;
    const drew = drag.drawing;
    drag = null;
    if (dragged === canvas) dragged = null;
    frame.classList.remove('dragging');
    // What was drawn is kept where the pointer was let go, and not where the drag was cut short.
    if (drew) layer.end(event.type === 'pointerup');
  };
  const canvas = h('canvas', {
    class: 'map-canvas',
    role: 'img',
    'aria-label': 'The map',
    'data-focus': `map-view ${which}`,
    onpointerdown: (event) => {
      const drawing = layer !== null && layer.draws();
      if (event.button !== 0 || (!drawing && !larger())) return;
      // Nor does the drag select text, or move the keyboard's focus.
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, drawing };
      dragged = canvas;
      if (drawing) {
        layer.begin(...cellAt(event));
        show();
      } else {
        frame.classList.add('dragging');
      }
    },
    onpointermove: (event) => {
      if (drag?.pointer !== event.pointerId) return;
      if (drag.drawing) {
        layer.extend(...cellAt(event));
        show();
        return;
      }
      const [x, y] = [drag.x - event.clientX, drag.y - event.clientY];
      [drag.x, drag.y] = [event.clientX, event.clientY];
      move(x, y);
    },
    onpointerup: letGo,
    onpointercancel: letGo,
    onlostpointercapture: letGo,
    onkeydown: (event) => {
      const way = PAN_KEYS.get(event.key);
      // With a modifier, a key is left to the browser.
      if (!way || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !larger()) return;
      event.preventDefault();
      move(way[0] * PAN_STEP, way[1] * PAN_STEP);
    },
  });
  const zoomButton = (label, glyph, focus, press) => h('button', {
    class: 'button tool',
    // Not to send the form of an event of the schedule, which shows the map of its floor plan.
    type: 'button',
    'aria-label': label,
    title: label,
    'data-focus': `${focus} ${which}`,
    onclick: press,
  }, icon(glyph));
  const zoomIn = zoomButton('Zoom in', 'plus', 'zoom-in', () => zoom(ZOOM_STEP));
  const zoomOut = zoomButton('Zoom out', 'minus', 'zoom-out', () => zoom(1 / ZOOM_STEP));
  // While the layer is drawn on: pressed, a drag moves the map, as it does otherwise; let go, a drag draws.
  const moveButton = layer && zoomButton('Move the map', 'move', 'map-move', () => {
    layer.move();
    show();
  });
  if (moveButton) moveButton.hidden = true;
  const frame = h('div', { class: 'map-view' }, canvas, h('div', { class: 'map-zoom' }, zoomIn, zoomOut, moveButton));
  // Drawn once the window is laid out, and again when its size changes. In a row that is shut it has none.
  new ResizeObserver(([seen]) => {
    const { width, height } = seen.contentRect;
    if (width === 0 || height === 0) return;
    [wide, high, ratio] = [width, height, devicePixelRatio || 1];
    show();
  }).observe(canvas);
  return [frame, show];
}

/**
 * A map as a picture with its legend: what its two binaries hold, and where
 * the robot and its base were. `layer`, where there is one, makes what is drawn
 * over the picture of the cells of `rank_binary` that it is told of: where the
 * picture starts among them, how many there are and the colours. What is
 * returned is the nodes of the picture and what draws it anew.
 */
async function picture(map, which, layer = null) {
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
  const palette = schemePalette();
  // The robot last, so that it is drawn over the base it stands on.
  const made = paint(rank, real, { base: places.base, robot: places.pos }, palette);
  const source = h('canvas', { width: made.width, height: made.height });
  source.getContext('2d').putImageData(new ImageData(made.rgba, made.width, made.height), 0, 0);

  const key = (name, label) => {
    // Not a class of that name: `robot` is a card in the list.
    const swatch = h('span', { class: name === 'robot' ? 'swatch round' : 'swatch' });
    swatch.style.background = `rgb(${palette[name]})`;
    return h('li', null, swatch, label);
  };
  const marked = new Set(made.marks.map((mark) => mark.name));
  if (real !== null && made.cleaned === null) {
    notes.push('The cleaned cells are not shown: real_binary is not laid out as rank_binary is.');
  }
  if (made.odd.length > 0) {
    const held = made.odd.map(([value, count]) => `${value} in ${count} cells`).join(', ');
    notes.push(`real_binary also holds ${held}, which this page has no meaning for.`);
  }
  const over = layer && layer({ left: made.left, top: made.top, width: rank.width, height: rank.height, palette });
  const [frame, redraw] = viewer(source, made.marks, palette, which, over);
  const nodes = [
    frame,
    h('ul', { class: 'map-legend' },
      key('floor', 'Floor'),
      key('wall', 'Wall'),
      made.cleaned !== null && key('cleaned', 'Cleaned'),
      marked.has('robot') && key('robot', 'Robot'),
      marked.has('base') && key('base', 'Base')),
    ...notes.map((note) => h('p', { class: 'hint' }, note)),
  ].filter(Boolean);
  return { nodes, repaint: redraw };
}

/** Fetch a map with its binaries and put its picture in the node of `pictured`, or why there is none and a way to try again. */
async function loadMap(mine, id, pictured, which, editable) {
  const node = pictured.node;
  node.replaceChildren(h('p', { class: 'hint' }, 'Reading the map…'));
  const address = `api/map?${new URLSearchParams({ ...mine.robot, id })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS);
  try {
    if (status !== 200) throw new Error(answer?.error ?? 'no answer from the server');
    const layer = (grid) => trackLayer(mine, id, pictured, editable, grid);
    const { nodes, repaint: redraw } = await picture(record(parsed(record(answer.map).map_json)), which, layer);
    node.replaceChildren(...nodes);
    pictured.repaint = redraw;
  } catch (error) {
    node.replaceChildren(
      h('p', { class: 'map-failed' }, `Cannot show this map: ${error.message}.`),
      h('button', {
        class: 'button',
        type: 'button',
        'data-focus': `map-again-${id}`,
        onclick: () => loadMap(mine, id, pictured, which, editable),
      }, 'Try again'));
  }
}

/**
 * The picture of a map. The view keeps the node, so a map is fetched and read
 * once, when it is first opened, however often the page is drawn again. A node
 * is in one place of a page, so a picture that is shown elsewhere than in the
 * row of its map, as that of a floor plan is in the schedule, is kept by that
 * `place` as well, and is fetched once for it. The zones and the no-go lines of
 * a floor plan are drawn over its picture, and are drawn on only in the row of
 * its map. Elsewhere `chosen` is the zone that is shown as chosen.
 */
function drawing(mine, id, place = null, chosen = null) {
  const key = place === null ? id : `${place} ${id}`;
  let pictured = mine.drawings.get(key);
  if (!pictured) {
    // With what draws the picture anew once there is one, and the zone it shows as chosen.
    pictured = { node: h('div', { class: 'map-drawing' }), repaint: null, chosen };
    mine.drawings.set(key, pictured);
    loadMap(mine, id, pictured, key, place === null);
  }
  if (pictured.chosen !== chosen) {
    pictured.chosen = chosen;
    pictured.repaint?.();
  }
  return pictured.node;
}

/** Draw the pictures of the view's maps anew, for what is drawn over them. */
function repaint(mine) {
  for (const pictured of mine.drawings.values()) pictured.repaint?.();
}

// The columns of the maps: when the run of one started, how it went, what it cleaned
// and how long it took, and whether the robot keeps the map as a floor plan.
const MAP_COLUMNS = [
  ['Start time', 'time'],
  ['Status', 'kind'],
  ['Area', 'amount', true],
  ['Duration', 'amount', true],
  ['Floor plan', 'kept', true],
];

/**
 * Whether a map is kept as a floor plan: a box that is ticked when `plan` is
 * the floor plan the server had the robot make of it. What the robot knows
 * that by is told to a pointer that rests on the box, and shown nowhere. The
 * box only says so: the buttons of the row are what changes it.
 */
function kept(plan) {
  const text = plan ? `Kept as floor plan ${plan.rank_uuid}` : 'Not kept as a floor plan';
  return h('span', { class: plan ? 'tick on' : 'tick', role: 'img', 'aria-label': text, title: text }, plan && icon('check'));
}

/**
 * A map as a row of the table. Opened, it has what the map says of its run
 * and its picture; and, for a map that is a floor plan, its zones and no-go
 * lines under the first, which are drawn on the second. It stays open while
 * one of those is being drawn.
 */
function mapRow(row, mine, robot, plans) {
  const map = record(parsed(row.map_json));
  const runs = (Array.isArray(map.runs) ? map.runs : []).map(record);
  // A map of one run, as the rule is, has the state of that run for its status.
  const state = runs.length === 1 ? word(runs[0].state) : null;
  const status = state ?? (runs.length > 1 ? `${runs.length} runs` : null);
  // The floor plan the server had the robot make of this map, if it did.
  const plan = plans.find((known) => known.map_id === row.id) ?? null;
  return {
    id: row.id,
    focus: `map-${row.id}`,
    pinned: plan !== null && mine.tracks.edit?.map === row.id,
    cells: [
      // When the robot says the run began, which every map of one run says alike.
      dated(record(map.timing).start),
      status === null ? none() : pill(RUN_TONES.get(state) ?? 'quiet', status, 'map'),
      areaOf(runs) ?? none(),
      took(record(map.timing)) ?? none(),
      kept(plan),
    ],
    tools: mapTools(mine, robot, plans, row.id, map, plan),
    note: floorQuestion(mine, robot, plans, row.id, map, plan) || floorSaid(mine, row.id),
    detail: () => [h('div', { class: 'map-detail' },
      h('div', { class: 'map-facts' }, mapFacts(map, runs), plan && trackPanel(mine, robot, row.id, plan)),
      drawing(mine, row.id))],
  };
}

/**
 * The maps the robot uploaded: at the top those it keeps as floor plans, however
 * old they are, the one it accepted last first, and then the others, newest first.
 */
function mapList(mine, body) {
  const { robot, maps, more_maps: more, floorplan_maps: old } = body;
  const plans = plansOf(body);
  const all = [...maps, ...old];
  if (all.length === 0) return none('Nothing yet.');
  const made = plans.map((plan) => plan.map_id);
  const rows = [
    ...all.filter((row) => made.includes(row.id)).sort((a, b) => made.indexOf(a.id) - made.indexOf(b.id)),
    ...all.filter((row) => !made.includes(row.id)),
  ];
  const said = mine.floors.said;
  return [
    table('Maps', MAP_COLUMNS, mine.openMaps, rows.map((row) => mapRow(row, mine, robot, plans))),
    // How it went with a map that is listed no more, as an old one is once it is no floor plan.
    said !== null && !rows.some((row) => row.id === said.map) && floorSaid(mine, said.map),
    older(mine, 'maps', more),
  ];
}

// ---- The floor plans of one robot ----
//
// A floor plan is a map that the robot keeps, to clean by. The robot makes one
// of a map it uploaded when the server tells it to, and the server remembers
// which it told the robot to make: a robot cannot be asked which it has. So a
// floor plan has no list of its own: it is the map it was made of, ticked, at
// the top of the table of the maps, and the buttons of that row are what is
// asked of the robot with it.

/** A UUID as short as a button can carry: how it begins. */
function short(uuid) {
  return `${uuid.slice(0, 8)}…`;
}

/**
 * Ask the robot, through the server, to keep a map as a floor plan or to drop
 * one it keeps. The view's `floors` holds whether an answer is waited for and
 * how the last request went, with the map it was pressed on, under whose row
 * that is said. One is asked at a time. `focus` names the button the keyboard
 * goes to when the one that was pressed leaves the page with its question.
 */
async function askFloor(mine, label, more, map, focus = null) {
  const floors = mine.floors;
  if (floors.waiting) return;
  floors.waiting = true;
  floors.asking = null;
  floors.said = null;
  drawRobot(mine);
  if (focus) app.querySelector(`[data-focus="${focus}"]`)?.focus();
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
 * Ask whether a floor plan is to go from the robot, or take that back.
 * `asking` is the map whose button was pressed and what that would do, which
 * the view's `floors.asking` holds until the second press, or null for none,
 * and `focus` names the button the keyboard goes to.
 */
function askAgain(mine, asking, focus) {
  mine.floors.asking = asking;
  mine.floors.said = null;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  drawRobot(mine);
  app.querySelector(`[data-focus="${focus}"]`)?.focus();
}

/**
 * The floor plans a map can be kept in place of: those the server had the
 * robot make and the one the map says it was cleaned on, but not its own.
 */
function replaceable(plans, map) {
  return [...new Set([...plans.map((plan) => plan.rank_uuid), map.persistent_rank_uuid])]
    .filter((uuid) => typeof uuid === 'string' && uuid !== '' && uuid !== map.rank_uuid);
}

/**
 * The buttons of a map's row: to have the robot keep the map as a new floor
 * plan, to have it drop the floor plan made of the map, and to have it keep
 * the map in place of another floor plan. A map that is a floor plan can be
 * demoted and one that is none can be promoted or put in the place of another.
 * The last two take a floor plan from the robot, so they only ask what
 * `floorQuestion` puts under the row.
 */
function mapTools(mine, robot, plans, id, map, plan) {
  const floors = mine.floors;
  const made = plan ? 'this map is a floor plan already' : null;
  const lone = replaceable(plans, map).length === 0 ? 'the robot is not known to have a floor plan to replace' : null;
  const asks = (action) => () => askAgain(mine, { map: id, action }, 'floor-keep');
  return [
    robotButton(floors, robot, 'Promote to floor plan', `floor-new-${id}`,
      () => askFloor(mine, 'Promote', { action: 'promote', map: id }, id), { why: made, glyph: 'promote', alone: true }),
    robotButton(floors, robot, 'Demote from floor plan', `floor-drop-${id}`, asks('demote'),
      { why: plan ? null : 'this map is not a floor plan', glyph: 'demote', alone: true }),
    robotButton(floors, robot, 'Replace a floor plan with this map', `floor-swap-${id}`, asks('replace'),
      { why: made ?? lone, glyph: 'replace', alone: true }),
  ];
}

/**
 * What a press on Demote or on Replace asks, under the row of its map, and the
 * answers to that. Taking a floor plan from the robot is asked twice, and the
 * second time here and not where the button that asked first is, so that
 * pressing that one twice takes nothing, and the keyboard is put on Keep.
 * Where the robot has more floor plans than one to replace, the second press
 * is also what chooses among them.
 */
function floorQuestion(mine, robot, plans, id, map, plan) {
  const floors = mine.floors;
  const asking = floors.asking;
  if (asking === null || asking.map !== id) return null;
  const demoting = asking.action === 'demote';
  const others = demoting ? [] : replaceable(plans, map);
  // Nothing is asked of a map that the buttons would no longer ask it of.
  if (demoting ? plan === null : plan !== null || others.length === 0) return null;
  const back = demoting ? `floor-drop-${id}` : `floor-swap-${id}`;
  // The spec does not say whether a floor plan that takes the place of another keeps what was drawn on that one.
  const drawn = others.some((old) => {
    const known = plans.find((each) => each.rank_uuid === old);
    return known && (known.zones.length > 0 || known.nogo !== null);
  });
  const forgotten = drawn ? ' What it does with the zones and no-go lines drawn here is not known, and this page forgets them.' : '';
  const question = demoting ? `Demote floor plan ${plan.rank_uuid}? The robot deletes it, with its zones and no-go lines.`
    : others.length === 1 ? `Replace floor plan ${others[0]} with this map? The robot keeps the map in its place.${forgotten}`
    : `Replace which floor plan with this map? The robot keeps the map in its place.${forgotten}`;
  const again = demoting
    ? [robotButton(floors, robot, 'Demote it', 'floor-again',
      () => askFloor(mine, 'Demote', { action: 'demote', rank_uuid: plan.rank_uuid }, id, back))]
    : others.map((old) => robotButton(floors, robot, others.length === 1 ? 'Replace it' : `Replace ${short(old)}`,
      `floor-again-${old}`, () => askFloor(mine, 'Replace', { action: 'update', map: id, old_rank_uuid: old }, id, back)));
  return h('div', { class: 'entry-ask' },
    h('p', null, question),
    h('div', { class: 'slot-tools' },
      h('button', { class: 'button', type: 'button', 'data-focus': 'floor-keep', onclick: () => askAgain(mine, null, back) }, 'Keep'),
      again));
}

/** How the last request about a floor plan went, for the map of that `id`, which it was pressed on. */
function floorSaid(mine, map) {
  const said = mine.floors.said;
  return said !== null && said.map === map && h('p', { class: `command-said ${said.tone}`, role: 'status' }, said.text);
}

// ---- The zones and no-go lines of a floor plan ----
//
// A zone is a part of a floor plan that the robot can be told to clean alone,
// and the no-go lines are where it is not to go. The spec calls both tracks.
// The robot keeps them with the floor plan and cannot be asked which it has, so
// they are those the server had it keep, each with what was drawn for it. They
// are drawn on the picture of the map the floor plan was made of, in that map's
// row: a zone as a rectangle, and the lines one at a time, all of them one
// track. What is drawn is in cells of the map's rank_binary, from its left and
// from its top, which is what the server draws a track's binary on.

const isCells = (value) => Array.isArray(value) && value.length === 4 && value.every(Number.isInteger);

/** The rectangle of a zone, as its top left cell and its bottom right one, or null where the server has none. */
function rectOf(zone) {
  const rect = parsed(zone.shape_json);
  return isCells(rect) ? rect : null;
}

/** The no-go lines of a floor plan, each from one cell to another, or none for a floor plan that has no track of them. */
function linesOf(track) {
  const lines = track ? parsed(track.shape_json) : [];
  return Array.isArray(lines) ? lines.filter(isCells) : [];
}

/** The rectangle between two cells, as its top left cell and its bottom right one. */
function corners([x0, y0, x1, y1]) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Draw a zone on a map's picture: the rectangle `rect`, with its name in its top left corner, dashed while it is drawn. */
function paintZone(pen, at, rect, name, colour, palette, ratio, dashed = false) {
  const [x0, y0] = at(rect[0], rect[1]);
  const [x1, y1] = at(rect[2] + 1, rect[3] + 1);
  pen.save();
  pen.fillStyle = `rgba(${colour}, 0.22)`;
  pen.fillRect(x0, y0, x1 - x0, y1 - y0);
  pen.strokeStyle = `rgb(${colour})`;
  pen.lineWidth = 1.5 * ratio;
  pen.setLineDash(dashed ? [5 * ratio, 4 * ratio] : []);
  pen.strokeRect(x0, y0, x1 - x0, y1 - y0);
  if (name) {
    // Within the zone, and readable over whatever is under it.
    pen.beginPath();
    pen.rect(x0, y0, x1 - x0, y1 - y0);
    pen.clip();
    pen.setLineDash([]);
    pen.font = `600 ${12 * ratio}px ui-sans-serif, system-ui, sans-serif`;
    pen.textBaseline = 'top';
    pen.lineJoin = 'round';
    pen.lineWidth = 3 * ratio;
    pen.strokeStyle = `rgb(${palette.unseen})`;
    pen.strokeText(name, x0 + 5 * ratio, y0 + 4 * ratio);
    pen.fillStyle = `rgb(${colour})`;
    pen.fillText(name, x0 + 5 * ratio, y0 + 4 * ratio);
  }
  pen.restore();
}

/** Draw a no-go line on a map's picture, from the middle of one cell to the middle of the other, no thinner than a cell. */
function paintLine(pen, at, [x0, y0, x1, y1], colour, size, ratio) {
  pen.save();
  pen.strokeStyle = `rgb(${colour})`;
  pen.lineWidth = Math.max(3 * ratio, size);
  pen.lineCap = 'round';
  pen.beginPath();
  pen.moveTo(...at(x0 + 0.5, y0 + 0.5));
  pen.lineTo(...at(x1 + 0.5, y1 + 0.5));
  pen.stroke();
  pen.restore();
}

/**
 * What is drawn over the picture of the map of that `id` while it is a floor
 * plan: its zones and its no-go lines. `grid` says where the picture starts
 * among the cells of the map and how many cells there are, and has the
 * colours. In the row of the map, where it is `editable`, it is drawn on while
 * the view's `tracks.edit` is about that map: a drag draws the zone in place of
 * what it was, or one more line. Elsewhere the zone `pictured.chosen` is shown as
 * chosen. All of it is read from the view as it is drawn, since the picture
 * outlives every page it is put on.
 */
function trackLayer(mine, id, pictured, editable, { left, top, width, height, palette }) {
  let stroke = null; // what is being drawn: the cell the pointer went down on, and the one it is on
  const clamp = (value, most) => Math.min(most - 1, Math.max(0, value));
  const cellAt = (x, y) => [clamp(Math.floor(x) + left, width), clamp(Math.floor(y) + top, height)];
  const editing = () => {
    const edit = mine.tracks.edit;
    return editable && edit !== null && edit.map === id ? edit : null;
  };
  return {
    editing: () => editing() !== null,
    draws: () => editing() !== null && !editing().moving,
    move: () => {
      const edit = editing();
      if (edit) edit.moving = !edit.moving;
    },
    begin: (x, y) => {
      const at = cellAt(x, y);
      stroke = [...at, ...at];
    },
    extend: (x, y) => {
      if (stroke) stroke = [stroke[0], stroke[1], ...cellAt(x, y)];
    },
    end: (keep) => {
      const [edit, drawn] = [editing(), stroke];
      stroke = null;
      pictured.repaint?.();
      // A press that does not leave its cell draws nothing.
      if (!keep || edit === null || drawn === null || (drawn[0] === drawn[2] && drawn[1] === drawn[3])) return;
      if (edit.kind === 'zone') edit.rect = corners(drawn);
      else if (edit.lines.length < LINES_MAX) edit.lines.push(drawn);
      // The form says what has been drawn.
      drawRobot(mine);
    },
    paint: (pen, plot, size, ratio) => {
      const plan = mine.body && plansOf(mine.body).find((known) => known.map_id === id);
      if (!plan) return;
      const edit = editing();
      const at = (x, y) => plot(x - left, y - top);
      for (const zone of plan.zones) {
        const rect = rectOf(zone);
        // The zone that is being drawn is where it is drawn now.
        if (!rect || (edit?.kind === 'zone' && zone.track_uuid === edit.track)) continue;
        const colour = zone.track_uuid === pictured.chosen ? palette.chosen : palette.zone;
        paintZone(pen, at, rect, zone.name, colour, palette, ratio);
      }
      const lines = edit?.kind === 'nogo' ? [...edit.lines, ...(stroke ? [stroke] : [])] : linesOf(plan.nogo);
      for (const line of lines) paintLine(pen, at, line, palette.nogo, size, ratio);
      const rect = edit?.kind === 'zone' && (stroke ? corners(stroke) : edit.rect);
      if (rect) paintZone(pen, at, rect, edit.name.trim(), palette.chosen, palette, ratio, true);
    },
  };
}

/** A zone, or the no-go lines, as the colour they are drawn in on a map. */
function trackSwatch(colour) {
  const swatch = h('span', { class: 'swatch' });
  swatch.style.background = `rgb(${colour})`;
  return swatch;
}

/**
 * Open the form that draws a zone of the floor plan `plan`, which is made of
 * the map of that `id`: the zone `zone`, or a new one where there is none. Of
 * the `kind` nogo, the form draws the floor plan's no-go lines. The row of the
 * map stays open while the form is.
 */
function drawTracks(mine, id, plan, kind, zone = null) {
  const job = mine.tracks;
  const where = { map: id, rank: plan.rank_uuid, kind, moving: false };
  job.edit = kind === 'zone'
    ? { ...where, track: zone?.track_uuid ?? null, name: zone?.name ?? '', mode: MODES.includes(zone?.mode) ? zone.mode : MODES[0],
      rect: zone ? rectOf(zone) : null }
    : { ...where, track: plan.nogo?.track_uuid ?? null, lines: linesOf(plan.nogo) };
  job.dropping = null;
  job.said = null;
  drawRobot(mine);
  app.querySelector(`[data-focus="${kind === 'zone' ? 'zone-name' : 'track-save'}"]`)?.focus();
}

/** Shut the form, and put the keyboard back on the button that opened it, which `back` names. */
function endTracks(mine, back) {
  mine.tracks.edit = null;
  mine.tracks.said = null;
  // A selection would hold the page as it is, and so would the field for the name while the keyboard is in it.
  getSelection().removeAllRanges();
  if (entering()) document.activeElement.blur();
  drawRobot(mine);
  app.querySelector(`[data-focus="${back}"]`)?.focus();
}

/**
 * Ask the robot, through the server, to keep a zone or the no-go lines of a
 * floor plan, or to drop a track, as `more` says. The view's `tracks` holds
 * whether an answer is waited for, and how the last request went, with the map
 * it was about. One is asked at a time. Once the robot accepts, the form is
 * shut and the keyboard goes to the button `back` names.
 */
async function askTracks(mine, label, more, map, back) {
  const job = mine.tracks;
  if (job.waiting) return;
  job.waiting = true;
  job.said = null;
  drawRobot(mine);
  const address = `api/track?${new URLSearchParams({ ...mine.robot, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  job.waiting = false;
  if (mine !== view) return;
  const went = outcome(label, status, answer);
  job.said = { ...went, map };
  if (went.tone !== 'good') {
    drawRobot(mine);
    return;
  }
  job.edit = null;
  job.dropping = null;
  drawRobot(mine);
  app.querySelector(`[data-focus="${back}"]`)?.focus();
  // The zones and the no-go lines come with the robot, and so do the events of this.
  refresh(mine);
}

/** Ask for what the form has drawn to be kept, or say what it lacks. */
function saveTracks(mine, back) {
  const job = mine.tracks;
  const edit = job.edit;
  const lacks = (text) => {
    job.said = { tone: 'bad', text: `Save: ${text}`, map: edit.map };
    drawRobot(mine);
  };
  if (edit.kind === 'zone') {
    // As the server keeps it: one line, its words a space apart.
    const name = edit.name.split(/\s+/).filter(Boolean).join(' ');
    if (name === '') return lacks('give the zone a name');
    if (edit.rect === null) return lacks('draw the zone on the map');
    const zone = JSON.stringify({ name, cleaning_mode: edit.mode, rect: edit.rect });
    return askTracks(mine, 'Save', { action: 'zone', rank_uuid: edit.rank, zone, ...(edit.track && { track_uuid: edit.track }) },
      edit.map, back);
  }
  if (edit.lines.length > 0) {
    return askTracks(mine, 'Save', { action: 'nogo', rank_uuid: edit.rank, lines: JSON.stringify(edit.lines) }, edit.map, back);
  }
  // With no line left, the floor plan's are dropped, where it has any.
  if (edit.track) return askTracks(mine, 'Save', { action: 'delete', track_uuid: edit.track }, edit.map, back);
  return endTracks(mine, back);
}

/**
 * The form that draws a zone, or the no-go lines: for a zone its name and its
 * mode, and what is to be drawn on the map beside it, then Save and Cancel; for
 * the lines how many there are, and the buttons that take back the last and
 * all of them. `back` names the button that opened it.
 */
function trackForm(mine, robot, edit, back) {
  const job = mine.tracks;
  const zone = edit.kind === 'zone';
  const button = h('button', {
    class: 'command',
    type: 'submit',
    disabled: !robot.session,
    'aria-disabled': robot.session && job.waiting && 'true',
    title: !robot.session ? 'Save: the robot is not connected' : job.waiting && 'Save: waiting for the robot to answer',
    'data-focus': 'track-save',
  }, 'Save');
  const count = zone ? 0 : edit.lines.length;
  // Held back, not disabled, so that the keyboard stays on one that takes back the last line.
  const takeBack = (label, focus, press) => h('button', {
    class: 'button',
    type: 'button',
    'aria-disabled': count === 0 && 'true',
    title: count === 0 ? `${label}: there is no line` : null,
    'data-focus': focus,
    onclick: () => {
      if (edit.lines.length === 0) return;
      getSelection().removeAllRanges();
      press();
      drawRobot(mine);
    },
  }, label);
  const said = zone ? (edit.rect ? 'Drag on the map to draw the zone again.' : 'Drag on the map to draw the zone.')
    : count === 0 ? (edit.track ? 'No lines: saving deletes them from the robot.' : 'Drag on the map to draw a line.')
    : count < LINES_MAX ? `${count} ${count === 1 ? 'line' : 'lines'}. Drag on the map to draw another.`
    : `${count} lines, the most there may be.`;
  return h('form', {
    class: 'track-form',
    onsubmit: (submit) => {
      submit.preventDefault();
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      if (!job.waiting) saveTracks(mine, back);
    },
  },
  zone && rows([
    ['Name', h('input', {
      type: 'text',
      value: edit.name,
      maxlength: ZONE_NAME_MAX,
      autocomplete: 'off',
      'aria-label': 'Name',
      'data-focus': 'zone-name',
      oninput: ({ target }) => { edit.name = target.value; },
    })],
    ['Mode', h('select', {
      'aria-label': 'Mode',
      'data-focus': 'zone-mode',
      onchange: ({ target }) => { edit.mode = target.value; },
    }, MODES.map((mode) => h('option', { value: mode, selected: mode === edit.mode }, mode)))],
  ]),
  h('p', { class: 'hint' }, said, ' To move an enlarged map instead, press the button with the arrows beside it.'),
  h('div', { class: 'slot-tools' },
    button,
    !zone && takeBack('Undo', 'track-undo', () => edit.lines.pop()),
    !zone && takeBack('Clear', 'track-clear', () => { edit.lines = []; }),
    h('button', { class: 'button', type: 'button', 'data-focus': 'track-cancel', onclick: () => endTracks(mine, back) }, 'Cancel')));
}

/** Ask whether the zone `uuid` is to go from the robot, or with null take that back, and put the keyboard on the button `focus` names. */
function askDropZone(mine, uuid, focus) {
  mine.tracks.dropping = uuid;
  mine.tracks.said = null;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  drawRobot(mine);
  app.querySelector(`[data-focus="${focus}"]`)?.focus();
}

/**
 * The zones and the no-go lines of the floor plan `plan`, which is made of the
 * map of that `id`, under what the map says of its run: a line to each zone,
 * with the buttons that draw it again and that ask whether to delete it, and
 * how many no-go lines there are, with the button that draws them; and under
 * either the form that draws them while it is open. Deleting a zone is asked
 * twice, the second time under it and with the keyboard put on Keep, as a
 * map's Demote is. One thing is drawn at a time, in the whole page.
 */
function trackPanel(mine, robot, id, plan) {
  const job = mine.tracks;
  const edit = job.edit !== null && job.edit.map === id ? job.edit : null;
  const colours = schemePalette();
  const why = job.edit !== null ? 'a zone or no-go lines are being drawn' : null;
  const lines = linesOf(plan.nogo);
  const zoneLine = (zone) => {
    const focus = `zone-${zone.track_uuid}`;
    const name = word(zone.name) ?? 'Unnamed';
    return [
      h('li', { class: 'track' },
        trackSwatch(colours.zone),
        h('span', { class: 'track-name' }, name),
        h('span', { class: 'track-mode' }, plain(zone.mode)),
        h('div', { class: 'entry-tools' },
          robotButton(job, robot, 'Edit', `${focus}-edit`, () => drawTracks(mine, id, plan, 'zone', zone),
            { why: why ?? (rectOf(zone) ? null : 'the server has no rectangle of it'), glyph: 'pencil', alone: true }),
          robotButton(job, robot, 'Delete', `${focus}-drop`, () => askDropZone(mine, zone.track_uuid, 'zone-keep'),
            { why, glyph: 'trash', alone: true }))),
      job.dropping === zone.track_uuid && h('li', { class: 'entry-ask track-ask' },
        h('p', null, `Delete the zone ${name}? The robot deletes it.`),
        h('div', { class: 'slot-tools' },
          // No button of the robot's, so it also takes the question back while the robot is away.
          h('button', { class: 'button', type: 'button', 'data-focus': 'zone-keep', onclick: () => askDropZone(mine, null, `${focus}-drop`) },
            'Keep'),
          robotButton(job, robot, 'Delete it', 'zone-again',
            () => askTracks(mine, 'Delete', { action: 'delete', track_uuid: zone.track_uuid }, id, `zone-add-${id}`)))),
    ];
  };
  return h('section', { class: 'tracks' },
    h('div', { class: 'tracks-head' },
      h('h3', null, 'Zones'),
      robotButton(job, robot, 'Add zone', `zone-add-${id}`, () => drawTracks(mine, id, plan, 'zone'), { why, glyph: 'plus' })),
    plan.zones.length > 0 ? h('ul', { class: 'track-list' }, plan.zones.flatMap(zoneLine)) : h('p', { class: 'track-none' }, none('No zones.')),
    edit?.kind === 'zone' && trackForm(mine, robot, edit, edit.track ? `zone-${edit.track}-edit` : `zone-add-${id}`),
    h('div', { class: 'tracks-head' },
      h('h3', null, 'No-go lines'),
      robotButton(job, robot, 'Edit', `nogo-edit-${id}`, () => drawTracks(mine, id, plan, 'nogo'), { why, glyph: 'pencil' })),
    edit?.kind === 'nogo' ? trackForm(mine, robot, edit, `nogo-edit-${id}`)
      : lines.length > 0 ? h('p', { class: 'track' }, trackSwatch(colours.nogo), `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`)
      : h('p', { class: 'track-none' }, none('None.')),
    job.said?.map === id && h('p', { class: `command-said ${job.said.tone}`, role: 'status' }, job.said.text));
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

/** What the robot knows the floor plan of a run by, or null for a run on none, or on one it names by no text. */
function floorOf(run) {
  const uuid = record(run.map).rank_id;
  return typeof uuid === 'string' && uuid !== '' ? uuid : null;
}

/** What the robot knows the zone a run cleans by, or null for a run of a whole floor plan, or of none. */
function zoneOf(run) {
  return word(record(run.map).track_id);
}

/**
 * The zone of a run, as a few words for a line: its name where the server had
 * the robot keep it, which is among the `zones` of one of `plans`, or else how
 * what the robot knows it by begins, the rest of which is told to a pointer
 * that rests on it, or the whole of it where it is `whole`.
 */
function zoneShown(run, plans, whole = false) {
  const track = zoneOf(run);
  if (track === null) return null;
  const zone = plans.find((plan) => plan.rank_uuid === floorOf(run))?.zones.find((known) => known.track_uuid === track);
  if (zone && word(zone.name)) return zone.name;
  return whole ? `zone ${track}` : h('span', { title: track }, `zone ${short(track)}`);
}

/**
 * Those of the floor plans `uuids` that are not among `plans`, the ones the
 * server had the robot keep. A robot cannot be asked which it has, so one of
 * these may be a floor plan it was given elsewhere, or one it has no more.
 */
function strays(uuids, plans) {
  const kept = new Set(plans.map((plan) => plan.rank_uuid));
  return [...new Set(uuids)].filter((uuid) => uuid && !kept.has(uuid));
}

/** What is said of floor plans that an event names and the robot is not known to have. */
function strayed(uuids) {
  return `Not a floor plan this server had the robot keep, so the robot may not have it: ${uuids.join(', ')}`;
}

/**
 * A warning sign to set in a line, before what it warns of. With `text` it
 * says that to a pointer that rests on it and to a screen reader; without, the
 * line it is in says it.
 */
function sign(text = null) {
  return h('span', { class: 'sign warn', role: text && 'img', 'aria-label': text, title: text }, icon('alert'));
}

/**
 * The floor plans the server had the robot keep, each with the `start` of the
 * map it was made of: when the robot says that map's run began, which is what
 * the table of the maps shows of it, or null where the server has the map no
 * more. Each has as well the `zones` the server had the robot keep of it, by
 * name, and as `nogo` the track of its no-go lines, or null.
 */
function plansOf({ maps, floorplans, floorplan_maps: old, tracks }) {
  const all = [...maps, ...old];
  return floorplans.map((plan) => {
    const row = all.find((map) => map.id === plan.map_id);
    const own = tracks.filter((track) => track.rank_uuid === plan.rank_uuid);
    return {
      ...plan,
      start: row ? record(record(parsed(row.map_json)).timing).start ?? null : null,
      zones: own.filter((track) => track.type === 'cleaning'),
      nogo: own.find((track) => track.type === 'no-go') ?? null,
    };
  });
}

/** The floor plan of `plans` that the robot knows as `uuid`, where its map has a start that is a time, or else null. */
function startOf(uuid, plans) {
  const plan = plans.find((known) => known.rank_uuid === uuid);
  return plan && !Number.isNaN(Date.parse(plan.start)) ? plan.start : null;
}

/**
 * The floor plan the runs of an event are on, with a warning sign before one
 * the robot is not known to have. It is shown as the map it was made of is in
 * the table of the maps, by when that map's run began. One whose map the server
 * does not know is shown by what the robot knows it by: for the row of the
 * event how that begins, the rest of which is told to a pointer that rests on
 * it, and for the event's form `whole`. The row has after it the zone of it
 * that is cleaned, or how many runs there are where there are more than one.
 */
function floorShown(runs, plans, whole = false) {
  if (runs.length === 0) return none('No runs');
  const place = runs[0].map == null ? null : record(runs[0].map);
  const uuid = place && word(place.rank_id);
  const start = uuid && startOf(uuid, plans);
  const lost = strays(runs.map(floorOf), plans);
  const zone = !whole && runs.length === 1 && zoneShown(runs[0], plans);
  return [
    lost.length > 0 && sign(strayed(lost)),
    place === null ? none() : uuid === null ? none('Unnamed') : start ? dated(start)
      : whole ? uuid : h('span', { title: uuid }, short(uuid)),
    !whole && runs.length > 1 && ` · ${runs.length} runs`,
    ...(zone ? [' · ', zone] : []),
  ];
}

/** The days of an event, a chip to each, or one chip for all seven. */
function daysOf(event) {
  const days = Array.isArray(event.days) ? event.days : [];
  return h('span', { class: 'days' },
    days.length === 0 ? none('No days')
      : DAYS.every(([name]) => days.includes(name)) ? h('span', { class: 'day' }, 'Every day')
      : days.map((day) => h('span', { class: 'day' }, DAY_LABELS.get(day) ?? String(day))));
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
    // The floor plan of the event's only run, by what the robot knows it by, or nothing for none; the zone of it
    // that the run cleans, or nothing for the whole of it; and whether the run minds the floor plan's no-go lines.
    floor: (runs.length === 1 && floorOf(runs[0])) || '',
    zone: (runs.length === 1 && floorOf(runs[0]) && zoneOf(runs[0])) || '',
    nogo: runs.length === 1 && record(runs[0].map).nogo_enabled === true,
    runs,
  };
}

/**
 * The map of a run that is to be on the floor plan `floor`, or on none where
 * that is empty: of the whole of it, or of its zone `zone` where that is not
 * empty, and minding its no-go lines or not as `nogo` says.
 */
function placed(floor, zone, nogo) {
  return floor === '' ? null : { rank_id: floor, track_id: zone === '' ? null : zone, nogo_enabled: nogo };
}

/**
 * Open the form on `event`, or on a new one when there is none, and put the
 * keyboard in it. The form of an event is what its row opens on, so that row
 * is opened, and is still open when the form is done with.
 */
function edit(mine, event) {
  const plan = mine.schedule;
  if (event) mine.openSlots.add(event.id);
  plan.form = draftOf(event);
  plan.dropping = null;
  plan.said = null;
  drawRobot(mine);
  app.querySelector('[data-focus="plan-time"]')?.focus();
}

/** Ask for the event in the form to be added, or to be put in place of the one the form was opened on. */
function save(mine) {
  const plan = mine.schedule;
  const { id, enabled, time, mode, navigation, floor, zone, nogo, runs } = plan.form;
  const days = DAYS.map(([name]) => name).filter((name) => plan.form.days.includes(name));
  if (days.length === 0) {
    plan.said = { tone: 'bad', text: 'Save: choose at least one day' };
    drawRobot(mine);
    return;
  }
  // The form has the settings, the floor plan and the zone of an event's only run. The runs of an event with more go back as the robot gave them.
  const changed = runs.length === 1
    ? [{ ...runs[0], settings: { mode, navigation_mode: navigation }, map: placed(floor, zone, nogo) }]
    : runs;
  const event = sent({ id, enabled, days, time, runs: changed });
  askSchedule(mine, id === null ? 'add' : 'update', 'Save', { event: JSON.stringify(event) });
}

/**
 * A button that asks something of the robot, as those of the schedule, of the
 * settings and of the floor plans do. It can be pressed while the robot is
 * connected, unless there is another reason `why` not, and does nothing while
 * the robot has yet to answer the last one pressed, which `job.waiting` says:
 * `job` is the view's `schedule`, its `settings`, its `floors` or its `tracks`. `glyph` is an icon that stands before its
 * label, or `alone` on it, as on a button of a row, which then says what it
 * does to a pointer that rests on it. One that is `lit` shows that what it
 * turns off is on.
 */
function robotButton(job, robot, label, focus, press, { why = null, glyph = null, alone = false, lit = false } = {}) {
  const reason = !robot.session ? 'the robot is not connected' : why;
  // Held back, not disabled: a disabled button could not keep the keyboard's focus.
  const held = reason === null && Boolean(job.waiting);
  return h('button', {
    class: ['button', alone && 'tool', lit && 'lit'].filter(Boolean).join(' '),
    type: 'button',
    disabled: reason !== null,
    'aria-disabled': held && 'true',
    'aria-label': alone && label,
    title: held ? `${label}: waiting for the robot to answer` : reason ? `${label}: ${reason}` : alone && label,
    'data-focus': focus,
    onclick: () => {
      if (job.waiting) return;
      // A selection would hold the page as it is, and the press has to show.
      getSelection().removeAllRanges();
      press();
    },
  }, glyph && icon(glyph), !alone && label);
}

/** A button of the schedule. */
function planButton(mine, ...rest) {
  return robotButton(mine.schedule, ...rest);
}

/** A field of a form that is a choice of Yes and No, which `set` is told of as true or false. `label` names it to a screen reader. */
function yesNo(label, focus, on, set) {
  return h('select', {
    'aria-label': label,
    'data-focus': focus,
    onchange: ({ target }) => set(target.value === 'yes'),
  }, h('option', { value: 'yes', selected: on }, 'Yes'), h('option', { value: 'no', selected: !on }, 'No'));
}

/**
 * A floor plan as a line to choose it by: when the run of the map it was made
 * of began, as the table of the maps has it, or how what the robot knows it by
 * begins where the server does not know that map.
 */
function floorLabel(plan) {
  const uuid = String(plan.rank_uuid);
  const start = startOf(uuid, [plan]);
  return start ? numeric(Date.parse(start)) : short(uuid);
}

/**
 * The form of an event of the schedule: a line to each thing the event has, as
 * a map has its facts, which is what a row of the schedule opens on. An event
 * is changed and added through the same form: with a `draft`, which is the
 * view's `schedule.form`, a line holds the field that changes what it says.
 * What is entered goes to the draft as it is entered, and a new page draws the
 * form from that. `event` is the event as the robot gave it, which a form that
 * adds one has none of. `plans` are the floor plans the server had the robot
 * keep, which an event of one run can be put on, and `back` names the button
 * that opens the form on its draft, which Cancel returns the keyboard to.
 * Beside the lines is the picture of the floor plan the event is on, where the
 * server had the robot keep that one and so knows the map it was made of, with
 * the zone the event cleans shown as chosen.
 */
function scheduleForm(mine, robot, plans, event, draft = null, back = null) {
  const plan = mine.schedule;
  const runs = draft ? draft.runs : runsOf(event);
  const single = runs.length === 1;
  const own = single ? floorOf(runs[0]) : null;
  // The zone of that floor plan the run cleans, and whether it minds the floor plan's no-go lines, as the robot gave them.
  const ownZone = own === null ? null : zoneOf(runs[0]);
  const ownNogo = own !== null && record(runs[0].map).nogo_enabled === true;
  // The settings, the floor plan and the zone of a run have a field where the event has one run to set them for.
  const set = draft !== null && single;
  // The floor plans the robot is not known to have: of an event of one run the one it is on and the one last chosen here.
  const lost = draft === null ? [] : strays(single ? [own, draft.floor] : runs.map(floorOf), plans);
  // What there is to choose from: no floor plan, then those, then the ones the server had the robot keep.
  // A map, because a robot chooses the names that are looked up.
  const offered = new Map([
    ['', 'None'],
    ...lost.map((uuid) => [uuid, `⚠ ${short(uuid)} · not listed`]),
    ...plans.map((known) => [known.rank_uuid, floorLabel(known)]),
  ]);
  // The picture follows the floor plan and the zone that are chosen as they are chosen, since no field draws the page again.
  // Each form keeps a picture of its own, which is what `back` tells one form from another by.
  const picture = h('div', { class: 'slot-picture' });
  const depict = () => {
    const uuid = set ? draft.floor : runs.length > 0 ? floorOf(runs[0]) : null;
    const chosen = set ? draft.zone || null : single ? zoneOf(runs[0]) : null;
    const made = plans.find((known) => known.rank_uuid === uuid);
    picture.replaceChildren(...(made ? [drawing(mine, made.map_id, back, chosen)] : []));
  };
  depict();
  // The zones to choose from are those of the floor plan that is chosen, so they change with it, in place.
  const zoneField = set && h('select', {
    'aria-label': 'Zone',
    'data-focus': 'plan-zone',
    onchange: ({ target }) => {
      draft.zone = target.value;
      depict();
    },
  });
  const nogoField = set && yesNo('No-go lines', 'plan-nogo', draft.nogo, (on) => { draft.nogo = on; });
  const zoning = () => {
    const zones = plans.find((known) => known.rank_uuid === draft.floor)?.zones ?? [];
    // The one the run cleans stays to choose while its floor plan is chosen, though the server did not have the robot
    // keep it, and so does the one last chosen once it is gone: a select whose value is none of its options shows another.
    const unlisted = [...new Set([draft.floor === own ? ownZone : null, draft.zone])]
      .filter((track) => track && !zones.some((known) => known.track_uuid === track));
    const choices = [
      ['', 'Whole floor plan'],
      ...unlisted.map((track) => [track, `⚠ ${short(track)} · not listed`]),
      ...zones.map((known) => [known.track_uuid, word(known.name) ?? short(known.track_uuid)]),
    ];
    zoneField.replaceChildren(...choices.map(([value, label]) => h('option', { value, selected: value === draft.zone }, label)));
    // On no floor plan, a run has neither.
    zoneField.disabled = draft.floor === '';
    nogoField.disabled = draft.floor === '';
    nogoField.value = draft.nogo ? 'yes' : 'no';
  };
  // On the floor plan the run is on, its zone and its no-go lines are as the robot gave them; on another, the whole
  // of it is cleaned, minding its no-go lines where the server had the robot keep some.
  const chooseFloor = () => {
    const same = draft.floor === own;
    draft.zone = same ? ownZone ?? '' : '';
    draft.nogo = same ? ownNogo : Boolean(plans.find((known) => known.rank_uuid === draft.floor)?.nogo);
    zoning();
    depict();
  };
  if (set) zoning();
  // A line names its field to the eye, and this to a screen reader.
  const choice = (name, label, values, said = (value) => value, then = () => {}) => h('select', {
    'aria-label': label,
    'data-focus': `plan-${name}`,
    onchange: ({ target }) => {
      draft[name] = target.value;
      then();
    },
  }, values.map((value) => h('option', { value, selected: value === draft[name] }, said(value))));
  const pick = (label, focus, on, flip) => h('label', { class: 'pick' },
    h('input', { type: 'checkbox', checked: on, 'data-focus': focus, onchange: ({ target }) => flip(target.checked) }),
    h('span', null, label));
  const lines = rows([
    ['Time', draft === null ? plain(event.time) : h('input', {
      type: 'time',
      required: '',
      value: draft.time,
      'aria-label': 'Time',
      'data-focus': 'plan-time',
      oninput: ({ target }) => { draft.time = target.value; },
    })],
    ['Days', draft === null ? daysOf(event) : h('div', { class: 'picks', role: 'group', 'aria-label': 'Days' },
      DAYS.map(([name, label]) => pick(label, `plan-${name}`, draft.days.includes(name), (on) => {
        draft.days = on ? [...draft.days, name] : draft.days.filter((day) => day !== name);
      })))],
    ['Mode', set ? choice('mode', 'Mode', MODES) : setting(runs, 'mode')],
    ['Navigation', set ? choice('navigation', 'Navigation', NAVIGATION_MODES) : setting(runs, 'navigation_mode')],
    ['Floor plan', set
      ? choice('floor', 'Floor plan', [...offered.keys()], (uuid) => offered.get(uuid), chooseFloor)
      : floorShown(runs, plans, true)],
    ...(set ? [['Zone', zoneField], ['No-go lines', nogoField]] : [
      ...(ownZone !== null ? [['Zone', zoneShown(runs[0], plans, true)]] : []),
      ...(own !== null ? [['No-go lines', flag(record(runs[0].map).nogo_enabled)]] : []),
    ]),
    // The columns of an event of more runs than one have what its runs are set to between them.
    ...(runs.length > 1 ? runs.map((run, n) => {
      const settings = record(run.settings);
      const said = [
        word(settings.mode),
        word(settings.navigation_mode),
        zoneShown(run, plans, true),
        record(run.map).nogo_enabled === true && 'minding no-go lines',
      ].filter(Boolean);
      return [`Run ${n + 1}`, said.length > 0 ? said.join(' · ') : none()];
    }) : []),
    ['Enabled', draft === null ? flag(event.enabled)
      : yesNo('Enabled', 'plan-enabled', draft.enabled, (on) => { draft.enabled = on; })],
  ]);
  if (draft === null) return h('div', { class: 'slot-form' }, h('div', { class: 'slot-lines' }, lines), picture);
  const waiting = plan.waiting !== null;
  const button = h('button', {
    class: 'command',
    type: 'submit',
    disabled: !robot.session,
    'aria-disabled': robot.session && waiting && 'true',
    title: !robot.session ? 'Save: the robot is not connected' : waiting && 'Save: waiting for the robot to answer',
    'data-focus': 'plan-save',
  }, 'Save');
  const kept = !single && `Its ${runs.length} runs stay as they are.`;
  return h('form', {
    class: 'slot-form',
    onsubmit: (submit) => {
      submit.preventDefault();
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      if (!plan.waiting) save(mine);
    },
  },
  h('div', { class: 'slot-lines' },
    lines,
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
          app.querySelector(`[data-focus="${back}"]`)?.focus();
        },
      }, 'Cancel')),
    lost.length > 0 && h('p', { class: 'plan-note warn' }, sign(), strayed(lost)),
    kept && h('p', { class: 'hint' }, kept)),
  picture);
}

// The columns of the schedule: when an event starts and on which days, what
// its runs are set to, and the floor plan they are on.
const SCHEDULE_COLUMNS = [
  ['Time', 'clock'],
  ['Days', 'days'],
  ['Mode', 'setting', true],
  ['Navigation', 'setting', true],
  ['Floor plan', 'floor', true],
];

/**
 * Ask whether an event is to go from the robot's schedule, or take that back.
 * `id` is that event's, which the view's `schedule.dropping` holds until the
 * second press, or null for none, and `focus` names the button the keyboard
 * goes to.
 */
function askDrop(mine, id, focus) {
  mine.schedule.dropping = id;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  drawRobot(mine);
  app.querySelector(`[data-focus="${focus}"]`)?.focus();
}

/**
 * An event of the schedule as a row of the table: when it starts and on which
 * days, what its runs are set to and the floor plan they are on, and at its
 * end the buttons that turn it on or off, open the form on it and ask whether
 * to delete it. `n` is where it stands among the events. The row opens on the
 * form of the event, which says what the event has, and Edit opens it with the
 * fields that change that; it is not shut while they are there. Under the row
 * is what a press on Delete asks. Deleting is asked twice, and the second time
 * there and not where the button that asked first is, so that pressing that
 * one twice deletes nothing, and the keyboard is put on Keep.
 */
function slot(mine, robot, event, n, plans) {
  const plan = mine.schedule;
  // The robot knows an event by its id, so one it gave none can only be shown.
  const id = typeof event.id === 'string' && event.id !== '' ? event.id : null;
  const changing = id !== null && plan.form !== null && plan.form.id === id;
  // While the form is open on an event to change it, the form is where it is changed.
  const why = id === null ? 'the robot gave this event no id' : changing ? 'this event is being changed in the form under it' : null;
  const on = event.enabled === true;
  const runs = runsOf(event);
  const toggle = () => askSchedule(mine, 'update', on ? 'Turn off' : 'Turn on', {
    event: JSON.stringify(sent({ ...event, enabled: !on, runs })),
  });
  const question = () => h('div', { class: 'entry-ask' },
    h('p', null, 'Delete this event? The robot takes it out of its schedule.'),
    h('div', { class: 'slot-tools' },
      // No button of the robot's, so it also takes the question back while the robot is away.
      h('button', { class: 'button', type: 'button', 'data-focus': 'slot-keep', onclick: () => askDrop(mine, null, `slot-drop-${n}`) }, 'Keep'),
      planButton(mine, robot, 'Delete it', 'slot-again', () => askSchedule(mine, 'delete', 'Delete', { id }))));
  return {
    // The place of an event that has no id stands for one: a number, which no id is.
    id: id ?? n,
    focus: `slot-${n}`,
    // An event that is off is still there to read, only quieter.
    dim: !on,
    pinned: changing,
    cells: [
      plain(event.time),
      daysOf(event),
      setting(runs, 'mode'),
      setting(runs, 'navigation_mode'),
      floorShown(runs, plans),
    ],
    tools: [
      planButton(mine, robot, on ? 'Turn off' : 'Turn on', `slot-on-${n}`, toggle, { why, glyph: 'power', alone: true, lit: on }),
      planButton(mine, robot, 'Edit', `slot-edit-${n}`, () => edit(mine, event), { why, glyph: 'pencil', alone: true }),
      planButton(mine, robot, 'Delete', `slot-drop-${n}`, () => askDrop(mine, id, 'slot-keep'), { why, glyph: 'trash', alone: true }),
    ],
    note: plan.dropping !== null && plan.dropping === id && question(),
    detail: () => [scheduleForm(mine, robot, plans, event, changing ? plan.form : null, `slot-edit-${n}`)],
  };
}

/**
 * The robot's schedule as it last gave it, with the ways to change it. The
 * robot keeps the schedule and the server none of it, so there is one to show
 * only once a connected robot has been asked.
 */
function schedulePanel(mine, body) {
  const { robot } = body;
  const plans = plansOf(body);
  const plan = mine.schedule;
  const shown = plan.shown;
  const events = shown !== null && Array.isArray(shown.events) ? shown.events.map(record) : [];
  const adding = plan.form !== null && plan.form.id === null;
  const tools = h('div', { class: 'panel-tools' },
    planButton(mine, robot, 'Add', 'plan-add', () => edit(mine, null), { glyph: 'plus' }),
    planButton(mine, robot, 'Refresh', 'plan-read', () => askSchedule(mine, 'show', 'Schedule'), { glyph: 'refresh' }));
  return panel('Schedule', [
    shown === null && h('p', { class: 'plan-note' }, none(!robot.session ? 'The robot is not connected.'
      : plan.waiting === 'show' ? 'Asking the robot…'
      : 'Not read from the robot.')),
    // The spec gives a schedule this field and no command that sets it.
    shown !== null && shown.enabled === false
      && h('p', { class: 'plan-note warn' }, 'The robot says that its schedule as a whole is off, which nothing here can change.'),
    shown !== null && events.length === 0 && !adding && h('p', { class: 'plan-note' }, none('No events.')),
    events.length > 0
      && table('Schedule', SCHEDULE_COLUMNS, mine.openSlots, events.map((event, n) => slot(mine, robot, event, n, plans))),
    adding && scheduleForm(mine, robot, plans, null, plan.form, 'plan-add'),
    plan.said && h('p', { class: `command-said ${plan.said.tone}`, role: 'status' }, plan.said.text),
  ], { wide: true, tools });
}

// ---- The settings of one robot ----
//
// The robot keeps its settings and the server none of them, so they are read
// from a connected robot, as its schedule is: each with the action of its name,
// and changed with that name after `set_`. The answer to a change says nothing
// of the setting, so it is read again after one. Reading them all is four calls
// to the robot, and eight events, so they are asked for only once the Settings
// tab is shown, and then once for each connection.

// The settings, under the names the server knows them by, in the order of their
// panels, and what the server takes for the sounds.
const SETTINGS = ['robot_language', 'sounds', 'cleaning_options', 'ota_updates'];
const VOICES = ['on', 'off'];
const VOLUME_MAX = 100; // the loudest; the quietest is 0

/** The languages a robot lists to choose from, those of them that are text. */
function languages(given) {
  const listed = given.available_languages;
  return Array.isArray(listed) ? listed.filter((language) => typeof language === 'string' && language !== '') : [];
}

// The names of languages in the browser's own, where it has them.
const LANGUAGE_NAMES = Intl.DisplayNames ? new Intl.DisplayNames(undefined, { type: 'language' }) : null;

/** A language as a robot gives it, such as `fr-ca`, after its name, such as "Canadian French", where the browser knows it by that. */
function languageName(language) {
  let name = null;
  try {
    name = LANGUAGE_NAMES?.of(language);
  } catch {
    // Not a language tag.
  }
  return name && name.toLowerCase() !== language.toLowerCase() ? `${name} (${language})` : language;
}

/** How a setting that is one field of true or false is shown and changed, as `SETTING_WAYS` has each: `field` is that field, and `label` its line. */
function switchWays(title, field, label) {
  return {
    title,
    lines: (given) => [[label, flag(given[field])]],
    draft: (given) => ({ [field]: given[field] === true }),
    fields: (draft) => [[label, yesNo(label, `setting-${field}`, draft[field], (on) => { draft[field] = on; })]],
    value: (draft) => ({ [field]: draft[field] }),
  };
}

// How each setting is shown and changed: the heading of its panel; the lines
// that say what the robot gave for it; the draft its form starts from, or null
// where the robot gave nothing to choose from; the lines of that form, each
// with its field, which writes to the draft; and what the server is sent, made
// of the draft.
const SETTING_WAYS = new Map([
  ['robot_language', {
    title: 'Language',
    lines: (given) => [
      ['Language', typeof given.language === 'string' && given.language !== '' ? languageName(given.language) : plain(given.language)],
      // Which only some robots give.
      ...(Object.hasOwn(given, 'gender') ? [['Gender', plain(given.gender)]] : []),
    ],
    draft: (given) => {
      const offered = languages(given);
      // The robot matches a language in whatever case, and may give its own in another than its list's.
      const own = typeof given.language === 'string' ? given.language.toLowerCase() : null;
      return offered.length === 0 ? null : { language: offered.find((one) => one.toLowerCase() === own) ?? offered[0], offered };
    },
    fields: (draft) => [['Language', h('select', {
      'aria-label': 'Language',
      'data-focus': 'setting-language',
      onchange: ({ target }) => { draft.language = target.value; },
    }, draft.offered.map((language) => h('option', { value: language, selected: language === draft.language }, languageName(language))))]],
    value: ({ language }) => ({ language }),
  }],
  ['sounds', {
    title: 'Sounds',
    lines: (given) => [
      ['Sounds', flag(given.enabled)],
      ['Voice', flag(given.voice === 'on' ? true : given.voice === 'off' ? false : given.voice)],
      ['Volume', plain(given.volume)],
    ],
    // A volume the server would not take starts at the loudest, which is what the robot sets where it is told none.
    draft: (given) => ({
      enabled: given.enabled === true,
      voice: VOICES.includes(given.voice) ? given.voice : 'on',
      volume: Number.isInteger(given.volume) && given.volume >= 0 && given.volume <= VOLUME_MAX ? given.volume : VOLUME_MAX,
    }),
    fields: (draft) => [
      ['Sounds', yesNo('Sounds', 'setting-enabled', draft.enabled, (on) => { draft.enabled = on; })],
      ['Voice', yesNo('Voice', 'setting-voice', draft.voice === 'on', (on) => { draft.voice = on ? 'on' : 'off'; })],
      ['Volume', volumeField(draft)],
    ],
    value: ({ enabled, voice, volume }) => ({ enabled, voice, volume }),
  }],
  ['cleaning_options', switchWays('Cleaning options', 'force_floorplan', 'Force floor plan')],
  ['ota_updates', switchWays('Software updates', 'auto', 'Automatic updates')],
]);

/** The volume as a slider, with the number it is at beside it. */
function volumeField(draft) {
  const said = h('output', null, String(draft.volume));
  return h('span', { class: 'volume' },
    h('input', {
      type: 'range',
      min: 0,
      max: VOLUME_MAX,
      step: 1,
      value: draft.volume,
      'aria-label': 'Volume',
      'data-focus': 'setting-volume',
      oninput: ({ target }) => {
        draft.volume = Number(target.value);
        said.textContent = target.value;
      },
    }),
    said);
}

/** Ask the robot, through the server, for one of its settings, or to change one: the status and the answer. */
function askSetting(mine, action, more = {}) {
  const address = `api/settings?${new URLSearchParams({ ...mine.robot, action, ...more })}`;
  return ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
}

/**
 * Read the settings `names` from the robot, one after the other. The view's
 * `settings` keeps what the robot gave for each and, for one it did not give,
 * why, and holds the buttons back until the last has been read.
 */
async function readSettings(mine, names) {
  const job = mine.settings;
  job.waiting = names;
  for (const name of names) job.said[name] = null;
  drawRobot(mine);
  for (const [n, name] of names.entries()) {
    const [status, answer] = await askSetting(mine, name);
    if (mine !== view) return;
    const went = outcome(SETTING_WAYS.get(name).title, status, answer);
    if (went.tone === 'good') job.shown[name] = record(answer.body);
    else job.said[name] = went;
    // What is still to be read, or nothing once all of it has been.
    job.waiting = n + 1 < names.length ? names.slice(n + 1) : null;
    drawRobot(mine);
  }
}

/** Read the robot's settings when the Settings tab is shown, and has not been for this connection of the robot's. */
function settingsDue(mine) {
  const job = mine.settings;
  const since = mine.body?.robot.session?.since;
  // While something else is asked of the robot, they are asked for at the next turn.
  if (mine.tab !== 'settings' || !since || job.asked === since || job.waiting) return;
  job.asked = since;
  readSettings(mine, SETTINGS);
}

/** Open the form on a setting, starting from what the robot last gave for it, and put the keyboard in it. */
function editSetting(mine, name) {
  const job = mine.settings;
  job.form = { name, draft: SETTING_WAYS.get(name).draft(job.shown[name]) };
  job.said[name] = null;
  drawRobot(mine);
  app.querySelector('.setting-form :is(input, select)')?.focus();
}

/** Shut the form on a setting, and put the keyboard back on the button that opened it. */
function endSetting(mine, name) {
  mine.settings.form = null;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  drawRobot(mine);
  app.querySelector(`[data-focus="setting-edit-${name}"]`)?.focus();
}

/** Ask the robot to take what the form on a setting holds, and once it has, read the setting again. */
async function saveSetting(mine, name) {
  const job = mine.settings;
  const value = SETTING_WAYS.get(name).value(job.form.draft);
  job.waiting = [name];
  job.said[name] = null;
  drawRobot(mine);
  const [status, answer] = await askSetting(mine, `set_${name}`, { value: JSON.stringify(value) });
  job.waiting = null;
  if (mine !== view) return;
  const went = outcome('Save', status, answer);
  if (went.tone !== 'good') {
    job.said[name] = went;
    drawRobot(mine);
    return;
  }
  endSetting(mine, name);
  readSettings(mine, [name]);
}

/** The form that changes a setting: a line to each of its fields, as the panel has a line to each value, and Save and Cancel under them. */
function settingForm(mine, robot, name, draft) {
  const job = mine.settings;
  const waiting = job.waiting !== null;
  const button = h('button', {
    class: 'command',
    type: 'submit',
    disabled: !robot.session,
    'aria-disabled': robot.session && waiting && 'true',
    title: !robot.session ? 'Save: the robot is not connected' : waiting && 'Save: waiting for the robot to answer',
    'data-focus': 'setting-save',
  }, 'Save');
  return h('form', {
    class: 'setting-form',
    onsubmit: (submit) => {
      submit.preventDefault();
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      if (!job.waiting) saveSetting(mine, name);
    },
  },
  rows(SETTING_WAYS.get(name).fields(draft)),
  h('div', { class: 'slot-tools' },
    button,
    h('button', { class: 'button', type: 'button', 'data-focus': 'setting-cancel', onclick: () => endSetting(mine, name) }, 'Cancel')));
}

/**
 * A setting as a panel of its own: what the robot last gave for it, or the
 * form that changes it while that is open, and beside the heading the buttons
 * that open the form and that read the setting again. One form is open at a time.
 */
function settingPanel(mine, robot, name) {
  const job = mine.settings;
  const ways = SETTING_WAYS.get(name);
  const given = job.shown[name] ?? null;
  const form = job.form !== null && job.form.name === name ? job.form : null;
  const said = job.said[name];
  const why = given === null ? 'the robot has not given this setting'
    : form !== null ? 'it is being changed below'
    : ways.draft(given) === null ? 'the robot gave nothing to choose from'
    : null;
  const tools = h('div', { class: 'panel-tools' },
    robotButton(job, robot, 'Edit', `setting-edit-${name}`, () => editSetting(mine, name), { why, glyph: 'pencil' }),
    robotButton(job, robot, 'Refresh', `setting-read-${name}`, () => readSettings(mine, [name]), { glyph: 'refresh' }));
  return panel(ways.title, [
    form !== null ? settingForm(mine, robot, name, form.draft)
      : given !== null ? rows(ways.lines(given))
      : h('p', { class: 'plan-note' }, none(!robot.session ? 'The robot is not connected.'
        : job.waiting?.includes(name) ? 'Asking the robot…'
        : 'Not read from the robot.')),
    said && h('p', { class: `command-said ${said.tone}`, role: 'status' }, said.text),
  ], { tools });
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
        isOn(robot.is_docked) && pill('quiet', 'Docked', 'dock'),
        batteryPill(robot)),
      commands(mine, robot)));
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
  return panel('Last state received', state == null ? none('The robot has not sent a state yet.') : code(state), {
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
      ['Quick boost', flag(robot.is_quickboost)],
      ['Quick boost estimate', boostEstimate(robot)],
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
      // A robot sends these whatever its base is, and only a cleaning center has a bag to speak of.
      ...(robot.base_type === 'cleaning_center' ? [
        ['Bag status', plain(robot.bag_status)],
        ['Base error', plain(robot.base_error)],
        ['Extracting', flag(robot.is_extracting)],
      ] : []),
    ])),
    panel('Last run', autonomy(robot)),
  ];
}

// The tabs of a robot's page, in the order they stand in: the name the view
// keeps each under, its label, and what builds its panels from the view and
// the server's answer. Only the one that is shown is built.
const TABS = [
  ['status', 'Status', (mine, { robot }) => statusPanels(robot)],
  ['schedule', 'Schedule', (mine, body) => schedulePanel(mine, body)],
  ['maps', 'Maps', (mine, body) => panel('Maps', mapList(mine, body), { wide: true })],
  ['settings', 'Settings', (mine, { robot }) => SETTINGS.map((name) => settingPanel(mine, robot, name))],
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
  settingsDue(mine);
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

/** Whether the reader is dragging a map about, which a new page would let go of. */
function dragging() {
  return app.contains(dragged);
}

/** Put `build()` on screen unless `data`, which it is built from, is what is already there. */
function draw(mine, data, build) {
  const drawn = JSON.stringify(data);
  if (drawn === mine.drawn || selecting() || entering() || dragging()) return;
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
    body.robot, body.events, body.more, body.maps, body.more_maps, body.floorplans, body.floorplan_maps, body.tracks,
    mine.tab, mine.naming, mine.command, mine.accepted, mine.schedule, mine.settings, mine.floors, mine.tracks, mine.deleting,
  ];
  draw(mine, data, () => robotPage(mine, body));
  // The pictures of the maps are no part of what is drawn, and what is drawn over them may have changed.
  repaint(mine);
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
      // What was being drawn on a floor plan that is one no more, of that map, has nothing to be drawn on.
      const edit = mine.tracks.edit;
      if (edit && !body.floorplans.some((plan) => plan.rank_uuid === edit.rank && plan.map_id === edit.map)) mine.tracks.edit = null;
      // The schedule is asked for once of each connection the page sees, not at every turn: asking is a call to the robot.
      const since = body.robot.session?.since;
      if (since && mine.schedule.asked !== since) askSchedule(mine, 'show', 'Schedule');
      settingsDue(mine);
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
    openSlots: new Set(),
    drawings: new Map(),
    // The name in the field, when the field is open; whether the server has yet to answer; and how the last one failed.
    naming: { draft: null, waiting: false, said: null },
    command: null,
    accepted: null,
    // The connection the schedule was last asked of, by when it began; what is waited for; what the robot gave;
    // how the last request failed; the form, when one is open; and the event about to be deleted.
    schedule: { asked: null, waiting: null, shown: null, said: null, form: null, dropping: null },
    // The connection the settings were last asked of; those that are being read or saved, while any is; what
    // the robot gave for each and how the last request about each failed, by name; and the form, when one is open.
    settings: { asked: null, waiting: null, shown: {}, said: {}, form: null },
    // Whether the robot has yet to answer what was asked of it about a floor plan; the map whose button awaits
    // its second press, with what that would do; and how the last request went, with the map it was pressed on.
    floors: { waiting: false, asking: null, said: null },
    // The same for the zones and no-go lines of a floor plan: whether an answer is waited for; what the form
    // that draws them has, while it is open; the zone whose Delete awaits its second press; and how the last
    // request went, with the map it was about.
    tracks: { waiting: false, edit: null, dropping: null, said: null },
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
