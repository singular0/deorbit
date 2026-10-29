// The web UI: the robots in the server's database as a list, and a page for
// each with its name, its schedule, its maps, which can be named, and floor
// plans with their zones and no-go lines, its settings, its events, the
// commands it takes and the way to delete it.
// Whatever a robot sent reaches the page as text nodes, never as markup.

import { PALETTES, paint, readBinary } from './map.js';

const POLL_MS = 3000; // how often the view on screen is fetched again
const FETCH_TIMEOUT_MS = 8000;
const EAGER_POLL_MS = 500; // how often instead, while the status that follows a command the robot accepted is due
const EAGER_FOR_MS = 10000; // how long after that command the page keeps asking that often
const COMMAND_TIMEOUT_MS = 15000; // longer than the server gives a robot to answer a command
const TOAST_MS = 5000; // how long a toast that says something went well stays on screen
const TOASTS_MAX = 5; // the most toasts on screen at once; the oldest goes for a new one
const START_WATCH_MS = 30000; // how long after a start the robot accepted the page looks for its failing to load what to clean on
const ANSWER_LIMIT = 160; // how much of a robot's answer to a command is said in a toast; the events hold all of it
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
const NAME_MAX = 64; // the most characters the server takes for the name of a robot or a map
const ZONE_NAME_MAX = 32; // the same for the name of a zone of a floor plan
const ZONES_MAX = 6; // the most zones a floor plan may have, each in a colour of its own of the `zones` of PALETTES
const CORNERS_MAX = 100; // the most corners a zone may have
const LINES_MAX = 100; // and the most no-go lines a floor plan may have
const GRAB = 10; // how near a corner of a zone, or the middle of a side, a press on a map has to be to take hold of it, in pixels of the page
const STILL = 4; // how far a press on a map may move and still be a click, in pixels of the page
const SVG = 'http://www.w3.org/2000/svg';

const app = document.getElementById('app');
const toasts = document.getElementById('toasts'); // where what is said of how something went is put
const live = document.getElementById('live');
const liveText = document.getElementById('live-text');
const homeAssistant = document.getElementById('home-assistant');
const allRobots = document.getElementById('all-robots'); // the link back to the list, in the bar

// The server's clock minus this browser's, so that "5 s ago" is right even
// when the two disagree.
let clockOffset = 0;

// The view on screen: its robot (null for the list), which tab of the robot's
// page is shown, how many of the robot's events and maps it asks for and which
// of them are open, the pictures of the maps that have been, the name being
// entered for it, whether the name of a map is being saved, the command last
// sent from it and when the robot last accepted one, the robot's schedule and
// its settings and what is being done to them, what is being asked of the
// robot about a floor plan, what is being drawn of the zones and no-go lines
// of one, whether the robot is being deleted, on the page that binds a robot
// the run it shows, the server's last answer, what was last drawn and the
// fetch under way. Navigating makes a new one, and a
// fetch that returns to find its view replaced drops the result.
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
  // The page's, and the toasts', which are no part of it.
  for (const node of document.querySelectorAll('time[data-at]')) node.textContent = ago(Number(node.dataset.at));
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

// ---- Toasts ----
//
// What is said of how something went is a toast, at the foot of the screen
// over the page: who or what it is from and when, then what it says. One that
// says something went well goes by itself, though not while a pointer rests on
// it or the keyboard is in it; one that says something went wrong stays until
// it is closed, so that it can be read, and so does one with a button for what
// there is to do, as the one that offers to reload a page that is out of date.
// Each is of a key, and a new one takes the place of the one of its key that is
// still there, as how the last command went does of how the one before it went.
// A toast is no part of the page, so a redraw leaves it be and leaving the page
// does not take it away.

const onScreen = new Map(); // the toasts by key, the oldest first

/** Take the toast of `key` off the screen, if it is there. */
function hush(key) {
  const node = onScreen.get(key);
  if (!node) return;
  onScreen.delete(key);
  node.classList.add('leaving');
  // Asked for after the class, so that the animation it starts is among them; without motion there is none.
  const gone = () => node.remove();
  Promise.all(node.getAnimations().map((animation) => animation.finished)).then(gone, gone);
}

/**
 * Say `text` in a toast of the `tone` good or bad, as `outcome` gives the two,
 * in place of the toast of `key`. It is `from` a robot, which is called what
 * the page calls it, or from what a word names, such as the server. A toast of
 * another tone, which stays until it is closed as a bad one does, says what
 * there is to do: it has the icon `glyph`, and the button of its `action`, a
 * label, an icon and what a press does.
 */
function toast(key, { tone, text, glyph = null, action = null }, from) {
  hush(key);
  const node = h('div', { class: `toast ${tone}`, role: tone === 'bad' && 'alert' },
    h('div', { class: 'toast-head' },
      icon(glyph ?? (tone === 'good' ? 'check' : 'alert')),
      typeof from === 'string' ? h('strong', null, from) : called('strong', from),
      when(new Date(Date.now() + clockOffset).toISOString()),
      h('button', {
        class: 'button tool toast-close',
        type: 'button',
        'aria-label': 'Close',
        title: 'Close',
        onclick: () => { if (onScreen.get(key) === node) hush(key); },
      }, icon('cross'))),
    h('p', { class: 'toast-body' }, text),
    action && h('div', { class: 'toast-actions' },
      h('button', { class: 'command', type: 'button', onclick: action[2] }, icon(action[1]), action[0])));
  if (tone === 'good') {
    let timer = 0;
    // Started again whenever the pointer or the keyboard leaves it, and not ended while either is on it.
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (onScreen.get(key) === node && !node.matches(':hover, :focus-within')) hush(key);
      }, TOAST_MS);
    };
    node.addEventListener('pointerleave', later);
    node.addEventListener('focusout', later);
    later();
  }
  toasts.append(node);
  onScreen.set(key, node);
  while (onScreen.size > TOASTS_MAX) hush(onScreen.keys().next().value);
}

/** Say how something asked of the robot of the view `mine` went, in place of the toast of that robot's of the same `kind`. */
function report(mine, kind, said) {
  const robot = mine.body?.robot ?? { serial: mine.robot.serial };
  toast(`${kind} ${mine.robot.vendor}/${mine.robot.serial}`, said, robot);
}

// ---- Popovers ----
//
// What cannot be undone is asked first, in a popover by the button that was
// pressed: a box over the page with an arrow to that button, what is asked as
// its heading, what doing it means under that, then Keep, which the keyboard
// is put on, and the answer or answers that do it. The answers are not where
// the button is, so a double click does nothing but open and shut it. Like a
// toast it is no part of the page, and a redraw leaves it be; it follows its
// button, which a redraw builds anew, by the button's `data-focus`, and goes
// when the button goes, when the button can no longer be pressed or when what
// it asks no longer stands. One is open at a time. An answer, Keep, Escape, the
// button again, and a press or the keyboard anywhere else shut it. The name of
// a robot or a map is entered in one too, in a field above Cancel and Save, and
// so are the name and the mode of a zone of a floor plan, which is drawn on the
// picture of the map meanwhile, as the no-go lines are from another: those two
// stay open wherever else a press or the keyboard goes, so that what they hold
// is not lost.

const POPOVER_MARGIN = 16; // how close a popover comes to the edge of the screen
const POPOVER_GAP = 10; // how far it stands from its button, with its arrow between them
const ARROW_INSET = 20; // how close its arrow comes to a corner of it, which is rounded

// The popover that is open, or null: its node, the view it is of, its button by `data-focus`, whether it opened
// under the button or over it, what says whether what it asks still stands, whether it stays open when a press or
// the keyboard goes elsewhere, and what is done when it shuts.
let popped = null;

/**
 * Open a popover by the button of the view `mine` that `anchor` names by its
 * `data-focus`, or shut the one that button opened. `title` heads it, and
 * `build` makes what stands under the heading, with an element of the id
 * `popover-text` that says what the popover is about, and gives the field or
 * the button the keyboard is put on. `stands` says, each time the page is
 * drawn, whether what the popover is about still stands; where it `stays`, a
 * press or the keyboard outside it leaves it open, the Tab key past its ends
 * included; and `shut` is done when it shuts, however it does. It opens
 * `under` its button whatever the room there, where that is given, and where
 * it is `wide`, it is as wide as its buttons are in one line.
 */
function openPopover(mine, anchor, title, build, { stands = () => true, stays = false, shut = null, under = false, wide = false } = {}) {
  const again = popped !== null && popped.mine === mine && popped.anchor === anchor;
  closePopover(false);
  if (again) return;
  const [content, first] = build();
  const node = h('div', {
    class: wide ? 'popover wide' : 'popover',
    role: 'dialog',
    'aria-labelledby': 'popover-title',
    'aria-describedby': 'popover-text',
    onkeydown: (event) => {
      // The Tab key past its last field or button goes on from the button that opened it, and past its first goes back
      // to that button, as if the popover stood after it in the page. That shuts it, unless it stays.
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const stops = node.querySelectorAll('input, select, button');
      if (document.activeElement !== (event.shiftKey ? stops[0] : stops[stops.length - 1])) return;
      if (event.shiftKey) event.preventDefault();
      if (stays) app.querySelector(`[data-focus="${CSS.escape(anchor)}"]`)?.focus();
      else closePopover();
    },
  },
  h('h2', { class: 'popover-head', id: 'popover-title' }, title),
  h('div', { class: 'popover-body' }, content));
  document.body.append(node);
  popped = { node, mine, anchor, under: under || null, stands, stays, shut };
  placePopover();
  if (popped?.node !== node) return;
  first.focus();
  // What a field holds is there to be typed over.
  if (first instanceof HTMLInputElement) first.select();
}

/**
 * Ask whether to do what cannot be undone, in a popover by the button that
 * `anchor` names, as `openPopover` has it. `title` names what is asked, and
 * `text` asks it and says what it does. `answers` are each a label and what a
 * press does: one does it, or where there is a choice to make each does it one
 * way. A `field`, a label and its control, stands over the question where the
 * choice is made in it instead, and the keyboard is put on it. `stands` says
 * whether what is asked still stands.
 */
function popover(mine, anchor, { title, text, answers, stands, field = null }) {
  openPopover(mine, anchor, title, () => {
    const keep = h('button', { class: 'button', type: 'button', onclick: () => closePopover() }, 'Keep');
    const tools = h('div', { class: 'popover-tools' },
      keep,
      answers.map(([label, press]) => {
        const answer = h('button', {
          class: 'button danger',
          type: 'button',
          'data-answer': label,
          onclick: () => {
            if (answer.hasAttribute('aria-disabled')) return;
            // A selection would hold the page as it is, and what the answer does has to show.
            getSelection().removeAllRanges();
            closePopover();
            press();
          },
        }, label);
        return answer;
      }));
    const asked = h('p', { id: 'popover-text' }, text);
    if (!field) return [[asked, tools], keep];
    const [label, control] = field;
    return [[h('label', { class: 'popover-field' }, h('span', null, label), control), asked, tools], control];
  }, { stands });
}

/**
 * Ask in a popover what something is to be called: a field on the `name` it
 * has, empty for one that goes by something else, which is the `placeholder`;
 * `text`, which says what the name is; then Cancel and Save. Enter and Save
 * hand `save` what the field holds. Save is held back while the button that
 * opened the popover is, which is while the server has yet to answer.
 */
function askName(mine, anchor, title, { name, placeholder, text, save }) {
  openPopover(mine, anchor, title, () => {
    const field = h('input', {
      type: 'text',
      value: name ?? '',
      maxlength: NAME_MAX,
      placeholder,
      autocomplete: 'off',
      'aria-label': 'Name',
    });
    const button = h('button', { class: 'command', type: 'submit', 'data-answer': 'Save' }, 'Save');
    const form = h('form', {
      class: 'popover-form',
      onsubmit: (event) => {
        event.preventDefault();
        if (!button.hasAttribute('aria-disabled')) save(field.value);
      },
    },
    field,
    h('p', { id: 'popover-text' }, text),
    h('div', { class: 'popover-tools' },
      h('button', { class: 'button', type: 'button', onclick: () => closePopover() }, 'Cancel'),
      button));
    return [form, field];
  });
}

/** Shut the popover, if one is open, and put the keyboard back on the button that opened it unless `back` is false. */
function closePopover(back = true) {
  if (!popped) return;
  const { node, anchor, shut } = popped;
  popped = null;
  node.remove();
  shut?.();
  if (back) app.querySelector(`[data-focus="${CSS.escape(anchor)}"]`)?.focus();
}

/**
 * Put the popover by its button, or shut it where there is nothing to ask
 * about any more. It opens under the button where it has the room, and over
 * it where it has more there, and stays on that side; its arrow points at the
 * middle of the button. It is placed against the page and not the screen, so
 * that it scrolls with the button. An answer is held back while the button is.
 */
function placePopover() {
  if (!popped) return;
  const { node, mine, anchor } = popped;
  const button = mine === view ? app.querySelector(`[data-focus="${CSS.escape(anchor)}"]`) : null;
  if (!button || button.disabled || !popped.stands()) {
    // The keyboard, if it was in it, goes to the button in its place where there is one that can take it.
    closePopover(node.contains(document.activeElement));
    return;
  }
  const held = button.getAttribute('aria-disabled') === 'true';
  for (const answer of node.querySelectorAll('[data-answer]')) {
    if (held) {
      answer.setAttribute('aria-disabled', 'true');
      answer.title = `${answer.dataset.answer}: waiting for an answer to what was asked before`;
    } else {
      answer.removeAttribute('aria-disabled');
      answer.removeAttribute('title');
    }
  }
  const at = button.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  if (popped.under === null) {
    // The bar at the top of the screen stays over the page.
    const roof = document.querySelector('.bar')?.getBoundingClientRect().bottom ?? 0;
    const below = innerHeight - POPOVER_MARGIN - at.bottom - POPOVER_GAP;
    const above = at.top - POPOVER_GAP - roof - POPOVER_MARGIN;
    popped.under = below >= height || below >= above;
  }
  node.dataset.side = popped.under ? 'under' : 'over';
  const middle = at.left + at.width / 2;
  const room = document.documentElement.clientWidth;
  const left = Math.max(POPOVER_MARGIN, Math.min(middle - width / 2, room - POPOVER_MARGIN - width));
  const top = popped.under ? at.bottom + POPOVER_GAP : at.top - POPOVER_GAP - height;
  node.style.left = `${left + scrollX}px`;
  node.style.top = `${top + scrollY}px`;
  node.style.setProperty('--arrow', `${Math.max(ARROW_INSET, Math.min(middle - left, width - ARROW_INSET))}px`);
}

/** Whether `target`, which an event was at, is neither in the popover nor the button that opened it, of one that does not stay. */
function elsewhere(target) {
  if (!popped || popped.stays || popped.node.contains(target)) return false;
  // A press that drew the page anew has a target that is no longer in it, but still has the ancestors it had.
  return !target.closest?.(`[data-focus="${CSS.escape(popped.anchor)}"]`);
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

function message(title, text) {
  return h('div', { class: 'card empty' },
    h('div', { class: 'avatar' }, icon('robot')),
    h('h1', null, title),
    h('p', { class: 'lead' }, text));
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
      bindButton()),
    robots.length > 0 && h('div', { class: 'grid' }, robots.map(card)));
}

// ---- Binding a robot over USB ----
//
// Pointing a robot at this server is done entirely in the browser, on a page
// of its own: it connects to the plugged-in robot over WebUSB and rewrites the
// robot's hosts file, its vendor settings and the certificate it trusts, which
// are the three steps the page shows. The helpers that do it live beside this
// file; they are imported only when the page is opened, so the rest of the UI
// does not depend on them being served, and so the device prompt in `runBind`
// stays the first await of the press that starts it (WebUSB needs a gesture).
//
// A run outlives its page, which can be left while a robot is written to: the
// page opened again meanwhile shows that run, and starts no other.

// The steps of a run, in the order they are done: each is one of the helpers' writes.
const STEPS = ['Update server name resolution', 'Update Tron server configuration', 'Install server certificate'];

let helpers = null; // the helper modules, once loaded
let helpersError = null; // why they could not be loaded, if so
let binding = null; // the run under way, if one is, as the page holds it

// Leaving the page, as a reload does, would cut a robot off in the middle of being written to, so the browser asks first.
addEventListener('beforeunload', (event) => {
  if (binding) event.preventDefault();
});

// Whether this browser has WebUSB. Chrome and Edge do, and only on a page from
// https or localhost. Without it the list's button is disabled, and the page,
// which an address can still open, holds Configure robot back.
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

/** What opens the page, beside the list's heading: disabled, with why, in a browser without WebUSB. */
function bindButton() {
  if (!WEBUSB) {
    return h('button', { class: 'button bind-robot', type: 'button', disabled: true, title: `Bind a robot: ${NO_WEBUSB}` },
      icon('link'), 'Bind a robot');
  }
  return h('a', { class: 'button bind-robot', href: '#/bind', 'data-focus': 'bind-robot' }, icon('link'), 'Bind a robot');
}

/** Each step as it is before a run: waiting, with nothing to say. */
function waitingSteps() {
  return STEPS.map(() => ({ state: 'waiting', note: null }));
}

/**
 * What the page holds of a run that has not started: the field's address,
 * which the server has yet to give; whether it has yet to say that and its
 * certificate, and what it said, which is null for no answer; whether a robot
 * is being written to; how far each step got; the log, and whether it is open.
 */
function freshBind() {
  return { address: '', asking: true, setup: null, busy: false, steps: waitingSteps(), log: [], logOpen: false };
}

/** Show the page on `mine`, and ask for what it needs that it does not have. */
function openBind(mine) {
  const bind = mine.bind;
  drawBind(mine);
  if (!WEBUSB) toast('bind-webusb', { tone: 'bad', text: `Configure robot: ${NO_WEBUSB}.` }, 'Bind a robot');
  // Loaded now, so the gesture in `runBind` is spent on the device prompt, not on an import.
  loadHelpers().then(() => {
    if (mine !== view) return;
    drawBind(mine);
    if (helpersError) {
      toast('bind-helpers', {
        tone: 'bad',
        text: `The USB helpers could not be loaded: ${errText(helpersError)}. This server may not provide mtp-fs.js.`,
      }, 'Bind a robot');
    }
  });
  // The run under way that the page shows has had its answer.
  if (!bind.asking) return;
  // The address to point a robot at and the certificate it is to trust are the server's to say.
  fetchSetup().then((setup) => {
    if (mine !== view) return;
    bind.asking = false;
    bind.setup = setup;
    // The field starts from the address the server has, as it is set or as it was found, which may be none.
    bind.address = setup?.address ?? '';
    if (!setup) {
      toast('bind-setup', {
        tone: 'bad',
        text: 'The server did not say its address and the certificate to install. Reload the page to ask again.',
      }, 'Bind a robot');
    }
    drawBind(mine);
  });
}

/** What the toasts that say why the page cannot configure a robot are kept by: they go with the page. */
const BIND_HELD = ['bind-webusb', 'bind-helpers', 'bind-setup', 'bind-address'];

// The four numbers of an IPv4 address. Not one with a 0 before a digit, which a resolver may read as octal.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The IP address `text` holds, as it is to be written into the robot's hosts file, or null where it holds none. */
function ipAddress(text) {
  const given = text.trim();
  if (IPV4.test(given)) return given;
  if (!given.includes(':') || !/^[0-9a-f:.]+$/i.test(given)) return null;
  try {
    // The URL parser knows an IPv6 address, and writes it the short way.
    return new URL(`http://[${given}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** Why Configure robot cannot be pressed now, or null when it can. An address that is none is said when it is pressed. */
function bindHeld(bind) {
  return !WEBUSB ? NO_WEBUSB
    : bind.busy ? 'the robot is being configured'
    : helpersError ? 'the USB helpers could not be loaded'
    : !helpers ? 'the USB helpers are still being loaded'
    : bind.asking ? 'waiting for the server to say its address'
    : !bind.setup ? 'the server did not say its address and the certificate to install'
    : null;
}

/** Connect to the plugged-in robot over USB and point it at this server, a step at a time. Started by a press, so nothing is awaited before the device prompt. */
async function runBind(mine) {
  const bind = mine.bind;
  if (binding || bindHeld(bind)) return; // the button is held back, and says why
  const ip = ipAddress(bind.address);
  if (!ip) {
    const given = bind.address.trim();
    toast('bind-address', {
      tone: 'bad',
      text: given === '' ? 'Configure robot: enter the address of this server' : `Configure robot: ${given} is not an IP address`,
    }, 'Bind a robot');
    app.querySelector('[data-focus="bind-address"]')?.focus();
    return;
  }

  // The field is disabled during the run, which would drop the keyboard's focus that Enter in it left there.
  app.querySelector('[data-focus="bind-configure"]')?.focus();
  binding = bind;
  bind.busy = true;
  bind.address = ip;
  bind.steps = waitingSteps();
  bind.log = [];
  hush('bind-address');
  const steps = bind.steps;
  let at = 0; // the step under way, which a failure is of
  // The page this run is on, if it is on screen: one left and opened again shows the run as well.
  const redraw = () => {
    if (view?.bind === bind) drawBind(view);
  };
  const log = (...parts) => {
    bind.log.push(parts.join(' '));
    redraw();
  };
  const begin = (step, note = null) => {
    at = step;
    steps[step] = { state: 'active', note };
    redraw();
  };
  let transport = null;
  try {
    // The server's certificate goes onto every robot. A server that has none to give, with no ca.crt beside its own, installs none.
    const certBytes = bind.setup.ca ? new TextEncoder().encode(bind.setup.ca) : null;
    // Connecting is the start of the first step, which it fails if it fails.
    begin(0, 'Choose the robot in the browser’s device prompt');
    log('Choose the robot in the browser’s device prompt...');
    transport = new helpers.WebUSBTransport({ log });
    await transport.open(); // the device prompt: the first await, so the press still counts as a user gesture
    begin(0, 'Connecting to the robot…');
    log('Connected over USB. Opening a session...');
    const client = new helpers.MtpClient(transport, { log });
    await client.openSession();
    // NOTE: mtp-fs.js was not read (see CLAUDE.md). This builds its file system
    // from the contract neato-config.js documents: an MtpFileSystem over an
    // already-open MTP session, with a `log` it calls as it works. Correct this
    // one line if the file's exports differ.
    const fs = new helpers.MtpFileSystem(client, { log });
    // The write contract requires an onConfirm answer for every change;
    // without one each write aborts unanswered. The user already consented by
    // pressing Configure robot, so every change is approved without asking
    // again. Backups of replaced files are kept in memory only (for
    // verify/restore), not downloaded.
    const options = { onConfirm: async () => true };
    // Each step is one write, which says how it went as `reconfigureNeato` takes it.
    const write = async (step, run) => {
      begin(step);
      log(`${STEPS[step]}...`);
      const result = await run();
      if (!result?.ok) throw new Error(result?.aborted ? 'aborted - no changes made' : result?.error || 'the robot refused a write');
      steps[step] = { state: 'done', note: null };
      redraw();
    };
    await write(0, () => helpers.setOrbitalHosts(fs, ip, options));
    await write(1, () => helpers.setVendorHost(fs, options));
    if (certBytes) await write(2, () => helpers.uploadCert(fs, certBytes, options));
    else {
      steps[2] = { state: 'skipped', note: 'The server has no certificate to install' };
      log('No certificate from the server, so none is installed on the robot.');
    }
    log('Done. Unplug the robot; it connects to this server when it next comes online.');
    toast('bind', { tone: 'good', text: 'The robot is now set up for this server.' }, 'Bind a robot');
  } catch (err) {
    if (err?.name === 'NotFoundError' && !transport?.device) {
      // The device prompt was dismissed: nothing was tried, so nothing failed.
      steps[0] = { state: 'waiting', note: null };
      log('No robot was chosen.');
    } else {
      steps[at] = { state: 'failed', note: errText(err) };
      // What led up to it is in the log, which opens for it.
      bind.logOpen = true;
      log(`Failed: ${errText(err)}`);
      toast('bind', { tone: 'bad', text: `${STEPS[at]}: ${errText(err)}` }, 'Bind a robot');
    }
  } finally {
    if (transport) {
      try { await transport.close(); } catch { /* best effort */ }
    }
    binding = null;
    bind.busy = false;
    redraw();
  }
}

/** The address to point the robot at, which starts as the one the server gave, and Configure robot beside it. */
function bindSettings(mine) {
  const bind = mine.bind;
  const why = bindHeld(bind);
  const button = h('button', {
    class: bind.busy ? 'command busy' : 'command',
    type: 'submit',
    // Held back, not disabled: the keyboard is on it while the robot is configured.
    'aria-disabled': why && 'true',
    title: why && `Configure robot: ${why}`,
    'data-focus': 'bind-configure',
  }, icon('link'), 'Configure robot');
  return panel('Configuration', h('form', {
    class: 'bind-form',
    onsubmit: (event) => {
      event.preventDefault();
      runBind(mine);
    },
  },
  h('label', { class: 'bind-label', for: 'bind-address' }, 'Server address'),
  h('div', { class: 'bind-row' },
    h('input', {
      id: 'bind-address',
      type: 'text',
      value: bind.address,
      placeholder: bind.asking ? '…' : 'IP address',
      autocomplete: 'off',
      spellcheck: 'false',
      // Nothing to change until the server has given what it has, and nothing while a robot is written to.
      disabled: bind.asking || bind.busy,
      'data-focus': 'bind-address',
      // Kept as it is typed, which draws nothing anew.
      oninput: (event) => { bind.address = event.target.value; },
    }),
    button)), { wide: true });
}

// What each state of a step has in its circle in place of its number, and what it says under its name where the run said nothing.
const STEP_GLYPHS = new Map([['done', 'check'], ['failed', 'cross'], ['skipped', 'minus']]);
const STEP_NOTES = new Map([['active', 'In progress…'], ['done', 'Done']]);

/** The steps one under another, each with its circle, joined by a line, which is lit from a step that is done. */
function stepper(bind) {
  return h('ol', { class: 'stepper' }, STEPS.map((title, at) => {
    const { state, note } = bind.steps[at];
    const glyph = STEP_GLYPHS.get(state);
    const said = note ?? STEP_NOTES.get(state);
    return h('li', { class: 'step', 'data-state': state, 'aria-current': state === 'active' && 'step' },
      h('span', { class: 'step-marker' }, glyph ? icon(glyph) : String(at + 1)),
      h('div', { class: 'step-text' },
        h('span', { class: 'step-title' }, title),
        said && h('span', { class: 'step-note' }, said)));
  }));
}

/** The log of the run, under a heading that opens and shuts it, with Copy beside it once there is something to copy. */
function bindLog(mine) {
  const bind = mine.bind;
  const text = bind.log.join('\n');
  const toggle = h('button', {
    class: 'disclosure',
    type: 'button',
    'aria-expanded': String(bind.logOpen),
    'aria-controls': 'bind-log',
    'data-focus': 'bind-log',
    onclick: () => {
      bind.logOpen = !bind.logOpen;
      drawBind(mine);
    },
  }, icon('chevron'), 'Debug log');
  return h('section', { class: `card panel wide bind-log-panel${bind.logOpen ? '' : ' shut'}` },
    h('div', { class: 'panel-head' }, h('h2', null, toggle), text !== '' && copyButton(text)),
    h('div', { id: 'bind-log', hidden: !bind.logOpen },
      text === '' ? h('p', { class: 'plan-note' }, none('Nothing logged yet.'))
        : h('pre', { class: 'code bind-log', tabindex: '0' }, text)));
}

function bindPage(mine) {
  return h('div', null,
    h('div', { class: 'heading bind-heading' },
      h('h1', null, 'Bind a robot'),
      h('p', { class: 'lead' }, 'Plug the robot into this computer over USB and click Configure robot button '
        + 'to bind it to this Deorbit server.')),
    h('div', { class: 'panels' },
      bindSettings(mine),
      panel('Progress', stepper(mine.bind), { wide: true }),
      bindLog(mine)));
}

/**
 * Draw the page from what it holds. Nothing but a press on it, or the run that
 * one starts, draws it, so it is drawn whatever the reader is at, and the field
 * keeps its caret.
 */
function drawBind(mine) {
  if (mine !== view) return;
  if (!draw(mine, [mine.bind, helpers !== null, helpersError !== null], () => bindPage(mine), false)) return;
  // The last line of the log is the one that says where things are.
  const log = app.querySelector('.bind-log');
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
 * where the table is `tooled`, which is to say has a column for them; and
 * `detail`, which gives what it opens on. The
 * row itself is what opens it, at a press or from the keyboard, so it is a
 * stop for the Tab key, which `focus` names to the keyboard's focus. `open` is
 * the view's set of the rows that are open, by `id`. A row that is `dim` is
 * set quieter than the others, and one that is `pinned` is open and cannot be
 * shut, as a row is while the form it opens on is being filled in.
 */
function entry(columns, open, tooled, { id, focus, cells, tools, detail, dim, pinned }) {
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
  return h('tbody', { class: dim ? 'entry dim' : 'entry' }, row, below);
}

/**
 * A table of rows that open: the names of its `columns`, then `rows`, each as
 * `entry` takes one. `label` names it to a screen reader. It has a column for
 * the buttons of its rows where any row has some.
 */
function table(label, columns, open, rows) {
  const tooled = rows.some((row) => row.tools);
  // Over the buttons of a row, which need no name to the eye, and as wide as the most a row has.
  const tools = tooled && h('th', { class: 'cell-tools', scope: 'col', 'aria-label': 'Actions' });
  if (tools) tools.style.setProperty('--tools', Math.max(...rows.map((row) => (row.tools ?? []).filter(Boolean).length)));
  return h('table', { class: 'table', 'aria-label': label },
    h('thead', null, h('tr', null,
      columns.map(([title, kind]) => h('th', { class: `cell-${kind}`, scope: 'col' }, title)),
      tools)),
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
// line, which an upload says with what its map is called, as the maps the
// robot gave names to by their rank_uuid have it. A label or a tone that
// depends on the body is a function of it. A login and a disconnect are the
// server's own, and so are a call, which is what a command is sent as, and the
// robot's response to one; the others are named by the service a robot sent a
// message to, and a service not listed here goes under its own name. These are
// maps because a robot chooses that name, and "constructor" must not find
// anything.
const isWarning = (body) => body.severity === 'warning';
const succeeded = (body) => Number.isInteger(body.code) && body.code >= 200 && body.code < 300;
const CONNECTION = new Map([
  ['login', ['Login', 'login', 'good', (body) => [
    named('from', body.address),
    named('firmware', body.firmware),
    body.verified === false && 'signature not verified',
  ]]],
  ['disconnect', ['Disconnect', 'logout', 'quiet', (body) => [word(body.reason)]]],
  ['call', ['Command', 'forward', 'accent', (body) => [word(body.ability)]]],
  ['response', ['Answer', 'back', (body) => (succeeded(body) ? 'good' : 'bad'), (body) => [
    word(body.ability),
    named('code', body.code),
  ]]],
]);
const SERVICES = new Map([
  ['robots.notify', ['Notification', 'bell', 'accent', (body) => [word(body.message_code)]]],
  ['robots.error_codes', [
    (body) => (isWarning(body) ? 'Warning' : 'Error'),
    'alert',
    (body) => (isWarning(body) ? 'warn' : 'bad'),
    (body) => [word(body.code), word(body.severity)],
  ]],
  ['robots.link', ['Link', 'link', 'accent', (body) => [named('user', body.user_id), word(body.timezone)]]],
  ['firmware.check', ['Firmware check', 'download', 'quiet', (body) => [
    named('version', body.version),
    body.only_mandatory === true && 'mandatory only',
  ]]],
  // What a map goes by without a name, when its run began, is in the upload as well.
  ['maps.create', ['Map', 'map', 'quiet', (body, names) => [
    mapText(names.get(body.rank_uuid) ?? null, record(body.timing).start) ?? word(body.rank_uuid),
  ]]],
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

/** An event as a row of the table. `names` are what the maps that were given names are called, by their rank_uuid. */
function eventRow(event, names) {
  const known = event.service == null ? CONNECTION.get(event.kind) : SERVICES.get(event.service);
  const [label, glyph, tone, says] = known ?? [String(event.service ?? event.kind), 'message', 'quiet', () => []];
  const body = record(parsed(event.body_json));
  const of = (value) => (typeof value === 'function' ? value(body) : value);
  const said = says(body, names).filter(Boolean).join(' · ');
  return {
    id: event.id,
    focus: `event-${event.id}`,
    cells: [dated(event.at), pill(of(tone), of(label), glyph), said || null],
    detail: () => eventDetail(event),
  };
}

/** The robot's events, newest first, as the server's answer `body` has them. */
function eventLog(mine, { events, more, map_names: given }) {
  if (events.length === 0) return none('Nothing yet.');
  // A map, because a robot chooses the rank_uuid that is looked up.
  const names = new Map(given.map((row) => [row.rank_uuid, row.name]));
  return [table('Events', EVENT_COLUMNS, mine.open, events.map((event) => eventRow(event, names))), older(mine, 'events', more)];
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

/** The runs of a map, each as an object. */
function runsIn(map) {
  return (Array.isArray(map.runs) ? map.runs : []).map(record);
}

/** How the run of a map went, as the robot gave it: of a map with more runs than one how many, and of one with none a dash. */
function runStatus(runs) {
  // A map of one run, as the rule is, has the state of that run for its status.
  const state = runs.length === 1 ? word(runs[0].state) : null;
  const status = state ?? (runs.length > 1 ? `${runs.length} runs` : null);
  return status === null ? none() : pill(RUN_TONES.get(state) ?? 'quiet', status, 'map');
}

/**
 * What a map is called, as text: the `name` it was given here, or else when
 * its run began, the `start` the robot gave, as `numeric` gives a time, which
 * is what a map goes by until it is given a name. Null for a map that has
 * neither.
 */
function mapText(name, start) {
  if (name != null) return name;
  const at = Date.parse(start);
  return Number.isNaN(at) ? null : numeric(at);
}

/** The same in a line, where a start is the time `dated` gives, with the rest of it to a pointer that rests on it. */
function mapShown(name, start) {
  return name ?? dated(start);
}

/** What a map says of its run that its row does not, beside the picture. `map` is what the robot sent of it. */
function mapFacts(map, runs) {
  const timing = record(map.timing);
  return rows([
    // When the robot says the run began, which every map of one run says alike, and when it ended: the date and the
    // time, and the rest to a pointer that rests on it.
    ['Start time', dated(timing.start)],
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

/** The colours of the pictures of maps for the page's scheme as it is now, which theme.js sets. */
function schemePalette() {
  return PALETTES[scheme() === 'light' ? 'light' : 'dark'];
}

function scheme() {
  return document.documentElement.dataset.scheme;
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
 * A drag moves the map while the button beside the zoom buttons, Move the
 * map, is pressed, which it is at first, and does nothing while it is not.
 * `layer`, where there is one, is what is drawn over the map, between it and
 * the marks: the zones and the no-go lines of a floor plan (`trackLayer`).
 * When it begins to be drawn on, the button is let go, so that a drag draws on
 * it, and when that ends, the button is pressed again. What is returned is the
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
  let panning = true; // whether Move the map is pressed
  let editing = false; // whether the layer was drawn on, when that was last asked

  // A whole number of the screen's pixels to a cell keeps the cells alike, where a cell is a pixel or more.
  // The map shown whole is not held to that, which would leave much of the window empty around a large one.
  const even = (cell) => (cell * ratio >= 1 ? Math.round(cell * ratio) / ratio : cell);
  const whole = () => Math.min(wide / across, high / down, FIT_MOST);
  const larger = () => across * scale > wide + 0.5 || down * scale > high + 0.5;
  // The layer drawn on from now on lets Move the map go, and no longer drawn on, presses it again.
  const sync = () => {
    const now = layer !== null && layer.editing();
    if (now !== editing) [editing, panning] = [now, !now];
  };
  // Whether a drag draws on the layer.
  const drawing = () => {
    sync();
    return editing && !panning;
  };
  // Along a side the map is larger than, the window stays on the map; along one it is not, the map is in its middle.
  const keep = (middle, cells, room) => {
    const half = room / 2 / scale;
    return cells * scale <= room + 0.5 ? cells / 2 : Math.min(cells - half, Math.max(half, middle));
  };
  const show = () => {
    sync();
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
    frame.classList.toggle('drawing', drawing());
    frame.classList.toggle('pannable', larger() && panning);
    // The Tab key stops at the map only where the arrow keys move it.
    if (larger()) canvas.tabIndex = 0;
    else canvas.removeAttribute('tabindex');
    hold(zoomIn, scale >= CELL_MOST);
    hold(zoomOut, fitted);
    moveButton.setAttribute('aria-pressed', String(panning));
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
      const draws = drawing();
      if (event.button !== 0 || (!draws && !(panning && larger()))) return;
      // Nor does the drag select text, or move the keyboard's focus.
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, drawing: draws };
      dragged = canvas;
      if (draws) {
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
  // Pressed, a drag moves the map; let go, a drag draws on the layer while that is drawn on, and else does nothing.
  const moveButton = zoomButton('Move the map', 'move', 'map-move', () => {
    panning = !panning;
    show();
  });
  moveButton.setAttribute('aria-pressed', String(panning));
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
  // One object for as long as the picture lasts, which takes the colours of another scheme when the page does
  // (`recolour`), so that whatever draws with it draws in those from then on.
  const palette = { ...schemePalette() };
  // The robot last, so that it is drawn over the base it stands on.
  const spots = { base: places.base, robot: places.pos };
  let made = paint(rank, real, spots, palette);
  const source = h('canvas', { width: made.width, height: made.height });
  const put = () => source.getContext('2d').putImageData(new ImageData(made.rgba, made.width, made.height), 0, 0);
  put();

  const swatches = [];
  const key = (name, label) => {
    // Not a class of that name: `robot` is a card in the list.
    const swatch = h('span', { class: name === 'robot' ? 'swatch round' : 'swatch' });
    swatch.style.background = `rgb(${palette[name]})`;
    swatches.push([swatch, name]);
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
  // The cells are painted anew in the colours of the scheme the page now has, and the legend and the window take them,
  // where that is another than they are in.
  let painted = scheme();
  const recolour = () => {
    if (scheme() === painted) return;
    painted = scheme();
    Object.assign(palette, schemePalette());
    made = paint(rank, real, spots, palette);
    put();
    for (const [swatch, name] of swatches) swatch.style.background = `rgb(${palette[name]})`;
    redraw();
  };
  return { nodes, repaint: redraw, recolour };
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
    const { nodes, repaint: redraw, recolour } = await picture(record(parsed(record(answer.map).map_json)), which, layer);
    node.replaceChildren(...nodes);
    pictured.repaint = redraw;
    pictured.recolour = recolour;
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
 * once, when it is first shown, however often the page is drawn again. A node
 * is in one place of a page, so a picture that is shown elsewhere than on the
 * Maps tab, in the row of its map or the block of its floor plan, as that of a
 * floor plan is in the schedule, is kept by that `place` as well, and is
 * fetched once for it. The zones and the no-go lines of a floor plan are drawn
 * over its picture, and are drawn on only in its block. Elsewhere `chosen` is
 * the zone that is shown as chosen.
 */
function drawing(mine, id, place = null, chosen = null) {
  const key = place === null ? id : `${place} ${id}`;
  let pictured = mine.drawings.get(key);
  if (!pictured) {
    // With what draws the picture anew once there is one, what does so in the colours of another scheme, and the zone
    // it shows as chosen.
    pictured = { id, node: h('div', { class: 'map-drawing' }), repaint: null, recolour: null, chosen };
    mine.drawings.set(key, pictured);
    loadMap(mine, id, pictured, key, place === null);
  }
  if (pictured.chosen !== chosen) {
    pictured.chosen = chosen;
    pictured.repaint?.();
  }
  return pictured.node;
}

/**
 * Let go of the pictures of maps the server no longer lists, as one deleted
 * on this page or another, since it may give the id of one to a later map.
 */
function forgetMaps(mine) {
  const listed = new Set([...mine.body.maps, ...mine.body.floorplan_maps].map((row) => row.id));
  for (const [key, pictured] of mine.drawings) if (!listed.has(pictured.id)) mine.drawings.delete(key);
}

/** Draw the pictures of the view's maps anew, for what is drawn over them. */
function repaint(mine) {
  for (const pictured of mine.drawings.values()) pictured.repaint?.();
}

// The columns of the maps that are no floor plan: what one is called, how its
// run went, what it cleaned and how long it took.
const MAP_COLUMNS = [
  ['Name', 'name'],
  ['Status', 'kind'],
  ['Area', 'amount', true],
  ['Duration', 'amount', true],
];

/** A map that is no floor plan as a row of the table. Opened, it has what the map says of its run and its picture. */
function mapRow(row, mine, robot, plans) {
  const map = record(parsed(row.map_json));
  const runs = runsIn(map);
  return {
    id: row.id,
    focus: `map-${row.id}`,
    cells: [
      mapShown(row.name, record(map.timing).start),
      runStatus(runs),
      areaOf(runs) ?? none(),
      took(record(map.timing)) ?? none(),
    ],
    tools: mapTools(mine, robot, plans, row, map),
    detail:() => [h('div', { class: 'map-detail' }, h('div', { class: 'map-facts' }, mapFacts(map, runs)), drawing(mine, row.id))],
  };
}

/**
 * A floor plan as a block of its own, open on all of it: headed with what its
 * map is called, the picture of that map, with its zones and no-go lines to
 * the right, which are drawn on the picture, and under both what its run
 * cleaned and how long it took. Rename and Demote stand beside its heading.
 */
function floorPanel(mine, robot, plan, row) {
  const map = record(parsed(row.map_json));
  const timing = record(map.timing);
  const runs = runsIn(map);
  const demote = robotButton(mine.floors, robot, 'Demote', `floor-${row.id}`, () => askDemote(mine, plan, row.id), { glyph: 'demote' });
  // A map called nothing, with neither a name nor a start that is a time, leaves the heading as it is.
  const called = mapText(row.name, timing.start) !== null
    && h('span', { class: 'heading-name' }, mapShown(row.name, timing.start));
  return panel(called ? ['Floor plan · ', called] : 'Floor plan', [
    h('div', { class: 'floor-plan' }, drawing(mine, row.id), trackPanel(mine, robot, row.id, plan)),
    h('div', { class: 'floor-facts' }, rows([
      ['Area', areaOf(runs) ?? none()],
      ['Duration', took(timing) ?? none()],
    ])),
  ], { wide: true, tools: h('div', { class: 'panel-tools' }, renameButton(mine, row), demote) });
}

/**
 * Ask the server to call the map of `row` what `draft` holds, or by when its
 * run began again where that holds nothing, and say in a toast how that went.
 * The view's `mapNaming` holds whether the server has yet to answer. Once the
 * name is saved, the popover it was entered in is shut.
 */
async function nameMap(mine, row, draft) {
  const naming = mine.mapNaming;
  if (naming.waiting) return;
  const before = mapText(row.name, record(record(parsed(row.map_json)).timing).start) ?? 'the map';
  naming.waiting = true;
  drawRobot(mine);
  const address = `api/map_name?${new URLSearchParams({ ...mine.robot, id: row.id, name: draft })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  naming.waiting = false;
  report(mine, 'map-name', status !== 200 ? { tone: 'bad', text: `Rename map: ${answer?.error ?? 'no answer from the server'}` }
    : answer.name === null ? { tone: 'good', text: `Rename map: ${before} goes by its start time again` }
    : { tone: 'good', text: `Rename map: ${before} is now called ${answer.name}` });
  if (mine !== view) return;
  if (status === 200) {
    // As with the robot's name: the answer has the name as the server keeps it, which goes on the page now, and an
    // answer that was asked for before the change, which has the old one, is dropped.
    for (const listed of [...mine.body.maps, ...mine.body.floorplan_maps]) if (listed.id === row.id) listed.name = answer.name;
    if (popped?.mine === mine && popped.anchor === `map-name-${row.id}`) closePopover();
    refresh(mine);
  }
  drawRobot(mine);
}

/**
 * Ask in a popover what the map of `row` is to be called: a field on the name
 * it has, which is empty for one that goes by when its run began, as the field
 * for a robot's name is for one that goes by its serial.
 */
function askMapName(mine, row) {
  askName(mine, `map-name-${row.id}`, 'Rename map', {
    name: row.name,
    placeholder: mapText(null, record(record(parsed(row.map_json)).timing).start),
    text: 'Only this server knows the name. Left empty, the map goes by its start time.',
    save: (draft) => nameMap(mine, row, draft),
  });
}

/**
 * The button that opens the popover that renames the map of `row`: with its
 * label beside the heading of a floor plan's block, and `alone` on it in the
 * row of a map. It has one name to the keyboard in both, as Promote and Demote
 * have, so the keyboard goes with the map from the one to the other. The robot
 * is sent nothing, so it need not be connected.
 */
function renameButton(mine, row, alone = false) {
  const waiting = mine.mapNaming.waiting;
  return h('button', {
    class: alone ? 'button tool' : 'button',
    type: 'button',
    // Held back, not disabled: a disabled button could not keep the keyboard's focus.
    'aria-disabled': waiting && 'true',
    'aria-label': alone && 'Rename',
    title: waiting ? 'Rename: waiting for the server to answer' : alone && 'Rename',
    'data-focus': `map-name-${row.id}`,
    onclick: () => {
      if (mine.mapNaming.waiting) return;
      // A selection would hold the page as it is, and the press has to show.
      getSelection().removeAllRanges();
      askMapName(mine, row);
    },
  }, icon('pencil'), !alone && 'Rename');
}

/**
 * Ask the server to delete the map of `row`, and say in a toast how that went.
 * The view's `mapDeleting` holds whether the server has yet to answer. Once
 * the map is gone, the keyboard goes from its Delete to the row after it in
 * the table, or else to the one before.
 */
async function dropMap(mine, row) {
  const deleting = mine.mapDeleting;
  if (deleting.waiting) return;
  const called = mapText(row.name, record(record(parsed(row.map_json)).timing).start) ?? 'the map';
  deleting.waiting = true;
  drawRobot(mine);
  const address = `api/map_delete?${new URLSearchParams({ ...mine.robot, id: row.id })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  deleting.waiting = false;
  report(mine, 'map-delete', status !== 200 ? { tone: 'bad', text: `Delete map: ${answer?.error ?? 'no answer from the server'}` }
    : { tone: 'good', text: `Delete map: ${called} is gone from this server` });
  if (mine !== view) return;
  if (status !== 200) {
    drawRobot(mine);
    return;
  }
  const body = mine.body;
  const others = body.maps.filter((listed) => !body.floorplans.some((plan) => plan.map_id === listed.id));
  const at = others.findIndex((listed) => listed.id === row.id);
  const next = at < 0 ? null : others[at + 1] ?? others[at - 1];
  const held = document.activeElement?.dataset?.focus === `map-drop-${row.id}`;
  // The map goes from the page now, and an answer that was asked for before, which still has it, is dropped.
  body.maps = body.maps.filter((listed) => listed.id !== row.id);
  mine.openMaps.delete(row.id);
  forgetMaps(mine);
  drawRobot(mine);
  if (held && next) app.querySelector(`[data-focus="map-${next.id}"]`)?.focus();
  refresh(mine);
}

/** Ask in a popover whether the map of `row` is to be deleted from the server. */
function askDropMap(mine, row) {
  const called = mapText(row.name, record(record(parsed(row.map_json)).timing).start);
  popover(mine, `map-drop-${row.id}`, {
    title: 'Delete map',
    text: `Delete ${called === null ? 'this map' : `the map ${called}`}? This server deletes it and its name for good. `
      + 'The robot is sent nothing.',
    answers: [['Delete it', () => dropMap(mine, row)]],
  });
}

/**
 * The button of the row of a map that asks, in a popover, whether to delete
 * the map. The robot is sent nothing, so it need not be connected. It does
 * nothing while the server has yet to answer it, nor while the robot has yet
 * to answer what was asked of it about a floor plan, which may be to keep
 * this map as one.
 */
function dropMapButton(mine, row) {
  const why = () => (mine.mapDeleting.waiting ? 'waiting for the server to answer'
    : mine.floors.waiting ? 'waiting for the robot to answer' : null);
  const held = why();
  return h('button', {
    class: 'button tool',
    type: 'button',
    // Held back, not disabled: a disabled button could not keep the keyboard's focus.
    'aria-disabled': held !== null && 'true',
    'aria-label': 'Delete',
    title: held === null ? 'Delete' : `Delete: ${held}`,
    'data-focus': `map-drop-${row.id}`,
    onclick: () => {
      if (why() !== null) return;
      // A selection would hold the page as it is, and the press has to show.
      getSelection().removeAllRanges();
      askDropMap(mine, row);
    },
  }, icon('trash'));
}

/**
 * The maps the robot uploaded: a block to each that it keeps as a floor plan,
 * however old, the one it accepted last first, and then a table of the
 * others, newest first. A floor plan whose map the server has no more, which
 * only a hand in the database brings about, has nothing to show.
 */
function mapPanels(mine, body) {
  const { robot, maps, more_maps: more, floorplan_maps: old } = body;
  const plans = plansOf(body);
  const all = [...maps, ...old];
  const kept = plans.map((plan) => [plan, all.find((row) => row.id === plan.map_id)]).filter(([, row]) => row);
  // The older maps that come with the robot are all of floor plans.
  const others = maps.filter((row) => !plans.some((plan) => plan.map_id === row.id));
  return [
    ...kept.map(([plan, row]) => floorPanel(mine, robot, plan, row)),
    panel('Other maps', [
      others.length > 0
        ? table('Other maps', MAP_COLUMNS, mine.openMaps, others.map((row) => mapRow(row, mine, robot, plans)))
        : none(maps.length === 0 ? 'Nothing yet.' : more ? 'None among the latest.' : 'None.'),
      older(mine, 'maps', more),
    ], { wide: true }),
  ];
}

// ---- The floor plans of one robot ----
//
// A floor plan is a map that the robot keeps, to clean by. The robot makes one
// of a map it uploaded when the server tells it to, and the server remembers
// which it told the robot to make: a robot cannot be asked which it has. So a
// floor plan is the map it was made of, in a block of its own above the table
// of the other maps, whose rows have the buttons that make one of theirs.

/** A UUID as short as a button can carry: how it begins. */
function short(uuid) {
  return `${uuid.slice(0, 8)}…`;
}

/**
 * Ask the robot, through the server, to keep a map as a floor plan or to drop
 * one it keeps, and say in a toast how that went. The view's `floors` holds
 * whether an answer is waited for, and one is asked at a time. `focus` names
 * the button the keyboard goes to while the robot answers.
 */
async function askFloor(mine, label, more, focus = null) {
  const floors = mine.floors;
  if (floors.waiting) return;
  floors.waiting = true;
  drawRobot(mine);
  if (focus) app.querySelector(`[data-focus="${focus}"]`)?.focus();
  const address = `api/floorplan?${new URLSearchParams({ ...mine.robot, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  floors.waiting = false;
  report(mine, 'floor', outcome(label, status, answer));
  if (mine !== view) return;
  drawRobot(mine);
  // The floor plans come with the robot, and so do the events of this.
  refresh(mine);
}

/**
 * Ask in a popover whether the floor plan `plan`, made of the map of that
 * `id`, is to go from the robot. It asks while the robot keeps it, since
 * Promote has the name of its button in the table once it is gone.
 */
function askDemote(mine, plan, id) {
  popover(mine, `floor-${id}`, {
    title: 'Demote floor plan',
    text: `Demote floor plan ${floorText(plan.rank_uuid, [plan], true)}? The robot deletes it, with its zones and no-go lines.`,
    answers: [['Demote it', () => askFloor(mine, 'Demote floor plan', { action: 'demote', rank_uuid: plan.rank_uuid })]],
    stands: () => mine.body.floorplans.some((each) => each.rank_uuid === plan.rank_uuid),
  });
}

/**
 * Ask in a popover whether the map of `row` is to take the place of a floor
 * plan on the robot. Where the robot has more floor plans than one to
 * replace, a list over the question chooses among them, at first the one the
 * map's run was on where that is one of them, and the question follows the
 * choice. While the robot answers, the keyboard is on Promote, which goes with
 * the map from the table to a block of its own.
 */
function askReplace(mine, plans, row, map) {
  const { id } = row;
  const others = replaceable(plans, map);
  const called = mapText(row.name, record(map.timing).start);
  const what = called === null ? 'this map' : `the map ${called}`;
  const question = (old) => {
    // The robot keeps the zones and no-go lines of the floor plan the map takes the place of (section 6.3).
    const known = plans.find((each) => each.rank_uuid === old);
    const drawn = known && (known.zones.length > 0 || known.nogo !== null);
    return `Replace floor plan ${floorText(old, plans, true)} with ${what}? The robot keeps the map in its place`
      + (drawn ? ', with the zones and no-go lines of the floor plan.' : '.');
  };
  let chosen = others.includes(map.persistent_rank_uuid) ? map.persistent_rank_uuid : others[0];
  const text = h('span', null, question(chosen));
  // An option's value is its place in the list, since the robot chose the floor plan its run was on.
  const list = others.length > 1 && h('select', {
    onchange: ({ target }) => {
      chosen = others[Number(target.value)];
      text.textContent = question(chosen);
      // One over its button has its foot there, whatever the question takes.
      placePopover();
    },
  }, others.map((old, n) => h('option', { value: n, selected: old === chosen }, floorText(old, plans))));
  popover(mine, `floor-swap-${id}`, {
    title: 'Replace floor plan',
    text,
    field: list && ['Floor plan', list],
    answers: [['Replace it',
      () => askFloor(mine, 'Replace floor plan', { action: 'update', map: id, old_rank_uuid: chosen }, `floor-${id}`)]],
  });
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
 * The buttons of the row of a map that is no floor plan, `row`: to rename the
 * map, to have the robot keep it as a new floor plan, to have it keep the map
 * in place of another, and to delete it from the server. Replace takes a floor
 * plan from the robot and Delete cannot be undone, so they only ask, in a
 * popover. Promote has the name to the keyboard that Demote has
 * in the block of a floor plan: a map goes from the one to the other as it is
 * promoted or demoted, and the keyboard goes with it.
 */
function mapTools(mine, robot, plans, row, map) {
  const { id } = row;
  const lone = replaceable(plans, map).length === 0 ? 'the robot is not known to have a floor plan to replace' : null;
  return [
    renameButton(mine, row, true),
    robotButton(mine.floors, robot, 'Promote to floor plan', `floor-${id}`,
      () => askFloor(mine, 'Promote to floor plan', { action: 'promote', map: id }), { glyph: 'promote', alone: true }),
    robotButton(mine.floors, robot, 'Replace a floor plan with this map', `floor-swap-${id}`,
      () => askReplace(mine, plans, row, map), { why: lone, glyph: 'replace', alone: true }),
    dropMapButton(mine, row),
  ];
}

// ---- The zones and no-go lines of a floor plan ----
//
// A zone is a part of a floor plan that the robot can be told to clean alone,
// and the no-go lines are where it is not to go. The spec calls both tracks.
// The robot keeps them with the floor plan and cannot be asked which it has, so
// they are those the server had it keep, each with what was drawn for it. They
// are drawn on the picture of the map the floor plan was made of, in the block
// of the floor plan: a zone as a polygon, corner by corner or as a rectangle,
// and the lines one at a time, all of them one track. What is drawn is in
// cells of the map's rank_binary, from its left and from its top, which is
// what the server draws a track's binary on: a corner of a zone is where cells
// meet, and the zone is every cell it covers any part of, while a line goes
// from the middle of one cell to the middle of another.

const isCells = (value) => Array.isArray(value) && value.length === 4 && value.every(Number.isInteger);
const isCorner = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);

/**
 * The corners of a zone, or null where the server has none. A zone kept before
 * a zone could be any polygon is a rectangle, as its top left cell and its
 * bottom right one.
 */
function polygonOf(zone) {
  const shape = parsed(zone.shape_json);
  if (isCells(shape)) return boxed(shape);
  return Array.isArray(shape) && shape.length >= 3 && shape.every(isCorner) ? shape : null;
}

/**
 * Whether the corners of a zone make a polygon the server does not take: one
 * with a corner twice, or with two sides that cross or touch but where the one
 * ends and the next begins. It is the server's own check.
 */
function tangled(corners) {
  const count = corners.length;
  // Which side of the line through a and b the point c is on, or 0 for on it.
  const side = ([ax, ay], [bx, by], [cx, cy]) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  // Of a point q on the line through p and r.
  const between = ([px, py], [qx, qy], [rx, ry]) =>
    Math.min(px, rx) <= qx && qx <= Math.max(px, rx) && Math.min(py, ry) <= qy && qy <= Math.max(py, ry);
  const meet = (a, b, c, d) => {
    const [one, two, three, four] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
    return (one !== two && three !== four) || (one === 0 && between(a, c, b)) || (two === 0 && between(a, d, b))
      || (three === 0 && between(c, a, d)) || (four === 0 && between(c, b, d));
  };
  // Whether the side from v to w goes back along the one from u to v.
  const back = (u, v, w) => side(u, v, w) === 0 && (u[0] - v[0]) * (w[0] - v[0]) + (u[1] - v[1]) * (w[1] - v[1]) > 0;
  if (new Set(corners.map(String)).size < count) return true;
  for (let i = 0; i < count; i += 1) {
    const [a, b] = [corners[i], corners[(i + 1) % count]];
    for (let j = i + 1; j < count; j += 1) {
      const [c, d] = [corners[j], corners[(j + 1) % count]];
      // Two sides that meet, the one ending where the other begins, may have nothing else in common.
      if (j === i + 1 ? back(a, b, d) : i === 0 && j === count - 1 ? back(c, a, b) : meet(a, b, c, d)) return true;
    }
  }
  return false;
}

/** The no-go lines of a floor plan, each from one cell to another, or none for a floor plan that has no track of them. */
function linesOf(track) {
  const lines = track ? parsed(track.shape_json) : [];
  return Array.isArray(lines) ? lines.filter(isCells) : [];
}

/** The corners of the rectangle of the cells from one cell to another, both of them among those. */
function boxed([x0, y0, x1, y1]) {
  const [left, top, right, bottom] = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1) + 1, Math.max(y0, y1) + 1];
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

// How a zone is drawn on a map: its fill, how opaque it is all told and the
// width of its edge, in pixels of the page. A zone that is chosen is drawn
// bolder and the others fainter, since each has a colour of its own, and the
// one that is being drawn has a dashed edge.
const ZONE_LOOKS = {
  plain: { fill: 0.22, alpha: 1, edge: 1.5 },
  drawn: { fill: 0.22, alpha: 1, edge: 1.5, dashed: true },
  chosen: { fill: 0.4, alpha: 1, edge: 3 },
  aside: { fill: 0.12, alpha: 0.55, edge: 1 },
};

/**
 * The colour of the zone in place `n` among those of its floor plan, as the
 * server lists them, which is the order they were added in. Only a floor plan
 * given more zones than a floor plan may have, before there was a limit, has
 * a zone past the last colour, and that one has the colour of its place less
 * that many.
 */
function zoneColour(palette, n) {
  return palette.zones[n % palette.zones.length];
}

/**
 * Draw a zone on a map's picture: the polygon of `corners`, with its name in
 * it, as `look` has it. One that is being drawn may have fewer than three
 * corners so far, which are a line or a point and have no name.
 */
function paintZone(pen, at, corners, name, colour, palette, ratio, look = 'plain') {
  const { fill, alpha, edge, dashed = false } = ZONE_LOOKS[look];
  const points = corners.map(([x, y]) => at(x, y));
  const outline = () => {
    pen.beginPath();
    points.forEach(([x, y], n) => (n === 0 ? pen.moveTo(x, y) : pen.lineTo(x, y)));
    if (points.length > 2) pen.closePath();
  };
  pen.save();
  pen.globalAlpha = alpha;
  outline();
  pen.fillStyle = `rgba(${colour}, ${fill})`;
  pen.fill();
  pen.strokeStyle = `rgb(${colour})`;
  pen.lineWidth = edge * ratio;
  pen.setLineDash(dashed ? [5 * ratio, 4 * ratio] : []);
  pen.stroke();
  pen.font = `600 ${12 * ratio}px ui-sans-serif, system-ui, sans-serif`;
  const spot = name && points.length > 2 ? nameSpot(points, pen.measureText(name).width, 12 * ratio, ratio) : null;
  if (spot) {
    // Within the zone, and readable over whatever is under it.
    outline();
    pen.clip();
    pen.setLineDash([]);
    pen.textBaseline = 'middle';
    pen.lineJoin = 'round';
    pen.lineWidth = 3 * ratio;
    pen.strokeStyle = `rgb(${palette.unseen})`;
    pen.strokeText(name, ...spot);
    pen.fillStyle = `rgb(${colour})`;
    pen.fillText(name, ...spot);
  }
  pen.restore();
}

/**
 * Where a zone whose corners are `points` on the canvas has its name written,
 * which is `wide` across and `high` down there: at the left of the first room
 * across the zone, from its top down, that is wide enough for the name, as a
 * rectangle has it in its top left corner; and where there is none, at the
 * left of the widest room there is. It is the middle of the name's left end.
 */
function nameSpot(points, wide, high, ratio) {
  const ys = points.map(([, y]) => y);
  const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
  const inset = 5 * ratio;
  let best = null;
  // At most so many lines across it are looked at, however large it is on the canvas.
  const step = Math.max(high / 2, (bottom - top) / 64);
  for (let y = Math.min(top + 4 * ratio + high / 2, (top + bottom) / 2); y < bottom; y += step) {
    // The zone is across the line from the first side that crosses it to the second, from the third to the fourth, and so on.
    const xs = [];
    points.forEach(([x0, y0], n) => {
      const [x1, y1] = points[(n + 1) % points.length];
      if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
    });
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const room = xs[n + 1] - xs[n];
      if (room >= wide + 2 * inset) return [xs[n] + inset, y];
      if (best === null || room > best.room) best = { room, spot: [xs[n] + inset, y] };
    }
  }
  return best?.spot ?? null;
}

/**
 * Mark on a map's picture the corners of the zone that is being drawn, which a
 * press takes hold of, and more faintly the middles of its sides, `middles`,
 * where a press puts a corner; those that are null are not marked.
 */
function paintGrips(pen, at, corners, middles, colour, palette, ratio) {
  pen.save();
  pen.lineWidth = 1.5 * ratio;
  for (const middle of middles) {
    if (middle === null) continue;
    pen.beginPath();
    pen.arc(...at(...middle), 3.5 * ratio, 0, 2 * Math.PI);
    pen.fillStyle = `rgb(${palette.unseen})`;
    pen.fill();
    pen.strokeStyle = `rgb(${colour})`;
    pen.stroke();
  }
  const half = 4 * ratio;
  for (const corner of corners) {
    const [x, y] = at(...corner);
    pen.fillStyle = `rgb(${colour})`;
    pen.fillRect(x - half, y - half, half * 2, half * 2);
    pen.strokeStyle = `rgb(${palette.unseen})`;
    pen.strokeRect(x - half, y - half, half * 2, half * 2);
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
 * colours. On the Maps tab, where it is `editable`, it is drawn on while
 * the view's `tracks.edit` is about that map. A drag draws one more line. Of
 * a zone, a click puts a corner after the last one, or on a side whose middle
 * it is on, and takes out a corner it is on; a drag moves the corner it starts
 * on, or puts one where it ends on the side whose middle it starts on; and a
 * drag that starts elsewhere draws a rectangle of cells in place of the zone.
 * Elsewhere the zone `pictured.chosen` is shown as chosen. All of it is read
 * from the view as it is drawn, since the picture outlives every page it is
 * put on.
 */
function trackLayer(mine, id, pictured, editable, { left, top, width, height, palette }) {
  let stroke = null; // the line being drawn: the cell the pointer went down on, and the one it is on
  // What a press on the zone being drawn took hold of, a corner or the middle of a side by its place, or nothing,
  // where the press went down and where it is now, in cells of the map, and whether it has moved far enough for a drag.
  let grip = null;
  let perCell = 1; // the pixels of the page to a cell, as the picture was last painted
  const clamp = (value, most) => Math.min(most - 1, Math.max(0, value));
  const cellOf = ([x, y]) => [clamp(Math.floor(x), width), clamp(Math.floor(y), height)];
  const cellAt = (x, y) => cellOf([x + left, y + top]);
  // The corner of cells nearest a point.
  const cornerOf = ([x, y]) => [clamp(Math.round(x), width + 1), clamp(Math.round(y), height + 1)];
  // How far apart two points of the map are on the page.
  const apart = ([x0, y0], [x1, y1]) => Math.hypot(x1 - x0, y1 - y0) * perCell;
  // The middle of each side of a zone, by the corner it begins at, where the zone may have one more corner and the side
  // is long enough on the page for its middle to be marked apart from its ends; else null.
  const middles = (corners) => (corners.length < 3 || corners.length >= CORNERS_MAX ? [] : corners.map((corner, n) => {
    const next = corners[(n + 1) % corners.length];
    return apart(corner, next) >= 3 * GRAB ? [(corner[0] + next[0]) / 2, (corner[1] + next[1]) / 2] : null;
  }));
  // The place of the nearest of these points that a press at `at` is near enough to, or -1.
  const nearest = (points, at) => {
    let [found, least] = [-1, GRAB];
    points.forEach((point, n) => {
      const far = point === null ? Infinity : apart(point, at);
      if (far <= least) [found, least] = [n, far];
    });
    return found;
  };
  // One more corner, after the one in place `n`, unless it is one of them already.
  const put = (corners, n, [x, y]) => (corners.some(([cx, cy]) => cx === x && cy === y) ? corners
    : [...corners.slice(0, n + 1), [x, y], ...corners.slice(n + 1)]);
  // The corners of the zone as they would be if the drag `held` ended now, and as they are while a click has not ended.
  const reshaped = (corners, held) => {
    if (held === null || !held.moved) return corners;
    const to = cornerOf(held.to);
    if (held.kind === 'corner') return corners.map((corner, n) => (n === held.n ? to : corner));
    if (held.kind === 'side') return put(corners, held.n, to);
    return boxed([...cellOf(held.from), ...cellOf(held.to)]);
  };
  // And as they are once the click `held` has ended.
  const clicked = (corners, held) => {
    if (held.kind === 'corner') return corners.filter((_, n) => n !== held.n);
    if (corners.length >= CORNERS_MAX) return corners;
    return put(corners, held.kind === 'side' ? held.n : corners.length - 1, cornerOf(held.from));
  };
  const editing = () => {
    const edit = mine.tracks.edit;
    return editable && edit !== null && edit.map === id ? edit : null;
  };
  return {
    editing: () => editing() !== null,
    begin: (x, y) => {
      const edit = editing();
      if (edit?.kind === 'zone') {
        const at = [x + left, y + top];
        const corner = nearest(edit.polygon, at);
        const side = corner < 0 ? nearest(middles(edit.polygon), at) : -1;
        grip = { kind: corner >= 0 ? 'corner' : side >= 0 ? 'side' : null, n: corner >= 0 ? corner : side, from: at, to: at, moved: false };
        return;
      }
      const at = cellAt(x, y);
      stroke = [...at, ...at];
    },
    extend: (x, y) => {
      if (grip) {
        grip.to = [x + left, y + top];
        grip.moved ||= apart(grip.from, grip.to) > STILL;
      }
      if (stroke) stroke = [stroke[0], stroke[1], ...cellAt(x, y)];
    },
    end: (keep) => {
      const [edit, drawn, held] = [editing(), stroke, grip];
      [stroke, grip] = [null, null];
      if (keep && edit?.kind === 'zone' && held !== null) {
        const corners = held.moved ? reshaped(edit.polygon, held) : clicked(edit.polygon, held);
        // What it was before is what Undo takes it back to.
        if (String(corners) !== String(edit.polygon)) {
          edit.history.push(edit.polygon);
          edit.polygon = corners;
        }
      }
      // A press that does not leave its cell draws no line.
      if (keep && edit?.kind === 'nogo' && drawn !== null && (drawn[0] !== drawn[2] || drawn[1] !== drawn[3])) {
        if (edit.lines.length < LINES_MAX) edit.lines.push(drawn);
      }
      pictured.repaint?.();
      // The popover says what has been drawn.
      if (edit && popped?.anchor === edit.anchor) (edit.kind === 'zone' ? sayZone : sayLines)(popped.node, edit);
    },
    paint: (pen, plot, size, ratio) => {
      perCell = size / ratio;
      const plan = mine.body && plansOf(mine.body).find((known) => known.map_id === id);
      if (!plan) return;
      const edit = editing();
      const at = (x, y) => plot(x - left, y - top);
      // Each zone in the colour of its place. Where one is chosen, it stands out and the others stand back.
      const chosen = plan.zones.some((zone) => zone.track_uuid === pictured.chosen) ? pictured.chosen : null;
      plan.zones.forEach((zone, n) => {
        const corners = polygonOf(zone);
        // The zone that is being drawn is where it is drawn now.
        if (!corners || (edit?.kind === 'zone' && zone.track_uuid === edit.track)) return;
        const look = chosen === null ? 'plain' : zone.track_uuid === chosen ? 'chosen' : 'aside';
        paintZone(pen, at, corners, zone.name, zoneColour(palette, n), palette, ratio, look);
      });
      const lines = edit?.kind === 'nogo' ? [...edit.lines, ...(stroke ? [stroke] : [])] : linesOf(plan.nogo);
      for (const line of lines) paintLine(pen, at, line, palette.nogo, size, ratio);
      if (edit?.kind === 'zone') {
        // In the colour it has, or a new one in that of the place it is to have, the last.
        const n = plan.zones.findIndex((zone) => zone.track_uuid === edit.track);
        const colour = zoneColour(palette, n < 0 ? plan.zones.length : n);
        const corners = reshaped(edit.polygon, grip);
        paintZone(pen, at, corners, edit.name.trim(), colour, palette, ratio, 'drawn');
        paintGrips(pen, at, corners, middles(corners), colour, palette, ratio);
      }
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
 * Open the popover that draws the no-go lines of the floor plan `plan`, which
 * is made of the map of that `id`, as `drawTrack` has it.
 */
function drawLines(mine, id, plan) {
  drawTrack(mine, 'Edit no-go lines', {
    map: id,
    rank: plan.rank_uuid,
    kind: 'nogo',
    anchor: `nogo-edit-${id}`,
    track: plan.nogo?.track_uuid ?? null,
    lines: linesOf(plan.nogo),
  }, linesForm, true);
}

/**
 * Open the popover that draws a zone of the floor plan `plan`, which is made
 * of the map of that `id`: the zone `zone`, or a new one where there is none,
 * as `drawTrack` has it. It has the zone's name, its mode, its corners and
 * what they were before each change, for Undo.
 */
function drawZone(mine, id, plan, zone = null) {
  drawTrack(mine, zone ? 'Edit zone' : 'Add zone', {
    map: id,
    rank: plan.rank_uuid,
    kind: 'zone',
    anchor: zone ? `zone-${zone.track_uuid}-edit` : `zone-add-${id}`,
    track: zone?.track_uuid ?? null,
    name: zone?.name ?? '',
    mode: MODES.includes(zone?.mode) ? zone.mode : MODES[0],
    polygon: zone ? polygonOf(zone) : [],
    history: [],
  }, zoneForm, true);
}

/**
 * Open the popover headed `title` that draws what `edit` holds, a zone or the
 * no-go lines, by the button its `anchor` names, with what `build` makes in
 * it; or shut it, where that button opened it. What it holds is drawn on the
 * picture of the map meanwhile. It stays open wherever else a press or the
 * keyboard goes, so that what it holds is not lost, and the other buttons that
 * would draw something are held back while it is open. Cancel, Escape and a
 * second press on the button that opened it shut it, and what it shuts with
 * is not kept. It opens under its button, so as not to stand on the picture
 * where that is above it. Where it is `wide`, its buttons are in one line.
 */
function drawTrack(mine, title, edit, build, wide = false) {
  const { anchor } = edit;
  if (popped?.mine === mine && popped.anchor === anchor) {
    closePopover(false);
    return;
  }
  mine.tracks.edit = edit;
  // The other buttons of the zones and the no-go lines are held back now, and the picture is drawn on.
  drawRobot(mine);
  openPopover(mine, anchor, title, () => build(mine, edit, anchor), {
    stands: () => mine.tracks.edit === edit,
    stays: true,
    shut: () => {
      if (mine.tracks.edit !== edit) return;
      mine.tracks.edit = null;
      drawRobot(mine);
    },
    under: true,
    wide,
  });
}

/**
 * Ask the robot, through the server, to keep a zone or the no-go lines of a
 * floor plan, or to drop a track, as `more` says, and say in a toast how that
 * went. The view's `tracks` holds whether an answer is waited for, and one is
 * asked at a time. Once the robot accepts, the popover is shut and the
 * keyboard goes to the button `back` names.
 */
async function askTracks(mine, label, more, back) {
  const job = mine.tracks;
  if (job.waiting) return;
  job.waiting = true;
  drawRobot(mine);
  const address = `api/track?${new URLSearchParams({ ...mine.robot, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  job.waiting = false;
  const went = outcome(label, status, answer);
  report(mine, 'tracks', went);
  if (mine !== view) return;
  if (went.tone !== 'good') {
    drawRobot(mine);
    return;
  }
  job.edit = null;
  // The popover goes with it, as what it was about stands no more.
  drawRobot(mine);
  app.querySelector(`[data-focus="${back}"]`)?.focus();
  // The zones and the no-go lines come with the robot, and so do the events of this.
  refresh(mine);
  // The robot gives the events of its schedule that clean a zone the cleaning mode the zone is given anew, and
  // takes the zone out of those that clean one it drops (section 6.3), so the schedule on the page is not that.
  const zone = more.action === 'nogo' ? null : more.track_uuid;
  const shown = mine.schedule.shown;
  const events = shown !== null && Array.isArray(shown.events) ? shown.events.map(record) : [];
  if (zone && events.some((event) => runsOf(event).some((run) => zoneOf(run) === zone))) askSchedule(mine, 'show', 'Schedule');
}

/** Ask for what the popover has drawn to be kept, or say what it lacks. */
function saveTracks(mine, back) {
  const edit = mine.tracks.edit;
  const label = edit.kind === 'nogo' ? 'Edit no-go lines' : edit.track ? 'Edit zone' : 'Add zone';
  const lacks = (text) => report(mine, 'tracks', { tone: 'bad', text: `${label}: ${text}` });
  if (edit.kind === 'zone') {
    // As the server keeps it: one line, its words a space apart.
    const name = edit.name.split(/\s+/).filter(Boolean).join(' ');
    if (name === '') return lacks('give the zone a name');
    if (edit.polygon.length < 3) return lacks('draw the zone on the map, with three corners at least');
    if (tangled(edit.polygon)) return lacks('the sides of the zone cross or touch; move a corner, or undo');
    const zone = JSON.stringify({ name, cleaning_mode: edit.mode, polygon: edit.polygon });
    return askTracks(mine, label, { action: 'zone', rank_uuid: edit.rank, zone, ...(edit.track && { track_uuid: edit.track }) }, back);
  }
  if (edit.lines.length > 0) {
    return askTracks(mine, label, { action: 'nogo', rank_uuid: edit.rank, lines: JSON.stringify(edit.lines) }, back);
  }
  // With no line left, the floor plan's are dropped, where it has any.
  if (edit.track) return askTracks(mine, label, { action: 'delete', track_uuid: edit.track }, back);
  return closePopover();
}

/**
 * What the popover that draws a zone holds: the zone's name and its mode, how
 * it is drawn on the map, Undo and Clear, which take back the last change to
 * its corners and all of them, then Cancel and Save. `back` names the button
 * that opened it. Save is held back while that button is, which is while the
 * robot has yet to answer; the popover shuts where the robot is not connected.
 */
function zoneForm(mine, edit, back) {
  const field = (label, control) => h('label', { class: 'popover-field' }, h('span', null, label), control);
  const name = h('input', {
    type: 'text',
    value: edit.name,
    maxlength: ZONE_NAME_MAX,
    autocomplete: 'off',
    oninput: ({ target }) => {
      edit.name = target.value;
      // The zone has its name in its corner on the map.
      repaint(mine);
    },
  });
  const save = h('button', { class: 'command', type: 'submit', 'data-answer': 'Save' }, 'Save');
  // Where `can` says that there is something for it to take back.
  const takeBack = (label, glyph, can, press) => h('button', {
    class: 'button',
    type: 'button',
    'data-takes': label,
    onclick: () => {
      if (!can()) return;
      press();
      sayZone(form, edit);
      repaint(mine);
    },
  }, icon(glyph), label);
  const form = h('form', {
    class: 'popover-form',
    onsubmit: (event) => {
      event.preventDefault();
      if (!save.hasAttribute('aria-disabled')) saveTracks(mine, back);
    },
  },
  field('Name', name),
  // A group of buttons is no one control that a label could hold, so its field is a block it names.
  h('div', { class: 'popover-field' }, h('span', null, 'Mode'),
    oneOf('Mode', 'zone-mode', MODES, edit.mode, (mode) => { edit.mode = mode; })),
  h('p', { id: 'popover-text' }),
  h('div', { class: 'popover-tools' },
    h('span', { class: 'popover-aside' },
      takeBack('Undo', 'undo', () => edit.history.length > 0, () => { edit.polygon = edit.history.pop(); }),
      takeBack('Clear', 'eraser', () => edit.polygon.length > 0, () => {
        edit.history.push(edit.polygon);
        edit.polygon = [];
      })),
    h('button', { class: 'button', type: 'button', onclick: () => closePopover() }, 'Cancel'),
    save));
  sayZone(form, edit);
  return [form, name];
}

/**
 * Say in `node`, what the popover that draws the zone `edit` holds, how far
 * the zone is drawn and how to draw it further, which changes as it is drawn
 * and taken back, and hold back Undo while there is nothing to take back and
 * Clear while there is no corner. Held back, not disabled, they keep the
 * keyboard.
 */
function sayZone(node, edit) {
  const count = edit.polygon.length;
  const said = count === 0 ? 'Drag on the map to draw a rectangle, or click on it to put the corners of the zone one by one.'
    : count < 3 ? `${count} ${count === 1 ? 'corner' : 'corners'} of the three a zone has at least. Click on the map to put the next.`
    : tangled(edit.polygon) ? 'Its sides cross or touch, which the sides of a zone may not. Drag a corner away, or undo.'
    : count < CORNERS_MAX ? `${count} corners. Click on the map to put one after the last, on the middle of a side to put one there, or on a corner to take it out; drag a corner to move it; drag elsewhere to draw a rectangle in place of the zone.`
    : `${count} corners, the most there may be. Click on a corner to take it out, or drag it to move it; drag elsewhere to draw a rectangle in place of the zone.`;
  node.querySelector('#popover-text').textContent = `${said} To move an enlarged map instead, press the button with the arrows beside it.`;
  const why = new Map([['Undo', edit.history.length === 0 && 'nothing has been drawn'], ['Clear', count === 0 && 'there is no corner']]);
  for (const button of node.querySelectorAll('[data-takes]')) {
    const held = why.get(button.dataset.takes);
    hold(button, Boolean(held));
    button.title = held ? `${button.dataset.takes}: ${held}` : '';
  }
}

/**
 * What the popover that draws the no-go lines holds: how many there are and
 * what is to be drawn on the map, Undo and Clear, which take back the last
 * line and all of them, then Cancel and Save. `back` names the button that
 * opened it. Save is held back while that button is, which is while the robot
 * has yet to answer; the popover shuts where the robot is not connected.
 */
function linesForm(mine, edit, back) {
  const save = h('button', { class: 'command', type: 'submit', 'data-answer': 'Save' }, 'Save');
  const takeBack = (label, glyph, press) => h('button', {
    class: 'button',
    type: 'button',
    'data-takes': label,
    onclick: () => {
      if (edit.lines.length === 0) return;
      press();
      sayLines(form, edit);
      repaint(mine);
    },
  }, icon(glyph), label);
  const form = h('form', {
    class: 'popover-form',
    onsubmit: (event) => {
      event.preventDefault();
      if (!save.hasAttribute('aria-disabled')) saveTracks(mine, back);
    },
  },
  h('p', { id: 'popover-text' }),
  h('div', { class: 'popover-tools' },
    h('span', { class: 'popover-aside' },
      takeBack('Undo', 'undo', () => edit.lines.pop()),
      takeBack('Clear', 'eraser', () => { edit.lines = []; })),
    h('button', { class: 'button', type: 'button', onclick: () => closePopover() }, 'Cancel'),
    save));
  sayLines(form, edit);
  return [form, save];
}

/**
 * Say in `node`, what the popover that draws the no-go lines `edit` holds,
 * how many there are, which changes as they are drawn and taken back, and
 * hold back Undo and Clear while there is none. Held back, not disabled, they
 * keep the keyboard, which may be on the one that took back the last line.
 */
function sayLines(node, edit) {
  const count = edit.lines.length;
  const said = count === 0 ? (edit.track ? 'No lines: saving deletes them from the robot.' : 'Drag on the map to draw a line.')
    : count < LINES_MAX ? `${count} ${count === 1 ? 'line' : 'lines'}. Drag on the map to draw another.`
    : `${count} lines, the most there may be.`;
  node.querySelector('#popover-text').textContent = `${said} To move an enlarged map instead, press the button with the arrows beside it.`;
  for (const button of node.querySelectorAll('[data-takes]')) {
    hold(button, count === 0);
    button.title = count === 0 ? `${button.dataset.takes}: there is no line` : '';
  }
}

/**
 * Ask in a popover whether the zone `zone`, called `name`, of the floor plan
 * made of the map of that `id`, is to go from the robot. Once it has, the
 * keyboard goes to Add zone.
 */
function askDropZone(mine, zone, name, id) {
  popover(mine, `zone-${zone.track_uuid}-drop`, {
    title: 'Delete zone',
    text: `Delete the zone ${name}? The robot deletes it.`,
    answers: [['Delete it', () => askTracks(mine, 'Delete zone', { action: 'delete', track_uuid: zone.track_uuid }, `zone-add-${id}`)]],
  });
}

/**
 * The zones and the no-go lines of the floor plan `plan`, which is made of the
 * map of that `id`, beside the picture of that map: a line to each zone,
 * with the buttons that draw it again in a popover and that ask in one whether
 * to delete it, and how many no-go lines there are, with the button that draws
 * them in a popover. One thing is drawn at a time, in the whole page: while
 * one is, every other button that would draw something is held back.
 */
function trackPanel(mine, robot, id, plan) {
  const job = mine.tracks;
  const colours = schemePalette();
  // One thing is drawn at a time on the whole page, so while something is, the buttons that would draw something else
  // are held back. The one that opened the popover it is drawn in is not, as a second press on it shuts that.
  const drawing = job.edit?.kind === 'nogo' ? 'no-go lines are being drawn' : job.edit?.kind === 'zone' ? 'a zone is being drawn' : null;
  const why = (focus) => (job.edit?.anchor === focus ? null : drawing);
  const lines = linesOf(plan.nogo);
  const full = plan.zones.length >= ZONES_MAX && `the floor plan has ${ZONES_MAX} zones, the most it may have`;
  const zoneLine = (zone, n) => {
    const focus = `zone-${zone.track_uuid}`;
    const name = word(zone.name) ?? 'Unnamed';
    return h('li', { class: 'track' },
      trackSwatch(zoneColour(colours, n)),
      h('span', { class: 'track-name' }, name),
      h('span', { class: 'track-mode' }, plain(zone.mode)),
      h('div', { class: 'entry-tools' },
        robotButton(job, robot, 'Edit', `${focus}-edit`, () => drawZone(mine, id, plan, zone),
          { why: why(`${focus}-edit`) ?? (polygonOf(zone) ? null : 'the server does not know its shape'), glyph: 'pencil', alone: true }),
        robotButton(job, robot, 'Delete', `${focus}-drop`, () => askDropZone(mine, zone, name, id),
          { why: why(`${focus}-drop`), glyph: 'trash', alone: true })));
  };
  return h('section', { class: 'tracks' },
    h('div', { class: 'tracks-head' },
      h('h3', null, 'Zones'),
      robotButton(job, robot, 'Add zone', `zone-add-${id}`, () => drawZone(mine, id, plan),
        { why: why(`zone-add-${id}`) ?? (full || null), glyph: 'plus' })),
    plan.zones.length > 0 ? h('ul', { class: 'track-list' }, plan.zones.map(zoneLine)) : h('p', { class: 'track-none' }, none('No zones.')),
    h('div', { class: 'tracks-head' },
      h('h3', null, 'No-go lines'),
      robotButton(job, robot, 'Edit', `nogo-edit-${id}`, () => drawLines(mine, id, plan), { why: why(`nogo-edit-${id}`), glyph: 'pencil' })),
    lines.length > 0 ? h('p', { class: 'track' }, trackSwatch(colours.nogo), `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`)
      : h('p', { class: 'track-none' }, none('None.')));
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
 * The floor plans the server had the robot keep, each with the `name` and the
 * `start` of the map it was made of: what that map is called, or null for
 * none, and when the robot says its run began, which is what it goes by
 * without one; both are null where the server has the map no more. Each has
 * as well the `zones` the server had the robot keep of it, by name, and as
 * `nogo` the track of its no-go lines, or null.
 */
function plansOf({ maps, floorplans, floorplan_maps: old, tracks }) {
  const all = [...maps, ...old];
  return floorplans.map((plan) => {
    const row = all.find((map) => map.id === plan.map_id);
    const own = tracks.filter((track) => track.rank_uuid === plan.rank_uuid);
    return {
      ...plan,
      name: row?.name ?? null,
      start: row ? record(record(parsed(row.map_json)).timing).start ?? null : null,
      zones: own.filter((track) => track.type === 'cleaning'),
      nogo: own.find((track) => track.type === 'no-go') ?? null,
    };
  });
}

/**
 * What the floor plan the robot knows as `uuid` is called, as text: what its
 * map is called, where it is one of `plans` and the server knows that map, or
 * else what the robot knows it by, `whole` or how that begins.
 */
function floorText(uuid, plans, whole = false) {
  const plan = plans.find((known) => known.rank_uuid === uuid);
  return (plan && mapText(plan.name, plan.start)) ?? (whole ? uuid : short(uuid));
}

/**
 * The floor plan the runs of an event are on, with a warning sign before one
 * the robot is not known to have. It is shown as its block on the Maps tab
 * shows it, by what its map is called. One whose map the server
 * does not know is shown by what the robot knows it by: for the row of the
 * event how that begins, the rest of which is told to a pointer that rests on
 * it, and for the event's form `whole`. The row has after it the zone of it
 * that is cleaned, or how many runs there are where there are more than one.
 */
function floorShown(runs, plans, whole = false) {
  if (runs.length === 0) return none('No runs');
  const place = runs[0].map == null ? null : record(runs[0].map);
  const uuid = place && word(place.rank_id);
  const plan = uuid && plans.find((known) => known.rank_uuid === uuid);
  const lost = strays(runs.map(floorOf), plans);
  const zone = !whole && runs.length === 1 && zoneShown(runs[0], plans);
  return [
    lost.length > 0 && sign(strayed(lost)),
    place === null ? none() : uuid === null ? none('Unnamed') : plan && mapText(plan.name, plan.start) !== null
      ? mapShown(plan.name, plan.start)
      : whole ? uuid : h('span', { title: uuid }, short(uuid)),
    !whole && runs.length > 1 && ` · ${runs.length} runs`,
    ...(zone ? [' · ', zone] : []),
  ];
}

/**
 * The days of an event, a chip to each in the order of a week, whatever order
 * the robot gave them in, or one chip for all seven. A name that is no day
 * comes after them, as the robot gave it.
 */
function daysOf(event) {
  const days = Array.isArray(event.days) ? event.days : [];
  const known = DAYS.filter(([name]) => days.includes(name)).map(([, label]) => label);
  const other = days.filter((day) => !DAY_LABELS.has(day)).map(String);
  return h('span', { class: 'days' },
    days.length === 0 ? none('No days')
      : known.length === DAYS.length ? h('span', { class: 'day' }, 'Every day')
      : [...known, ...other].map((label) => h('span', { class: 'day' }, label)));
}

/** An event as the server takes one: the fields the spec gives one, and of its command the runs alone. */
function sent({ id, enabled, days, time, runs }) {
  return { ...(id != null && { id }), enabled, days, time, command: { ability: 'cleaning.start', runs } };
}

/**
 * Ask the robot, through the server, for its schedule or for a change to it.
 * The view's `schedule` keeps which of those is waited for, and one is asked
 * at a time. A toast says how a change went, and of the schedule only that it
 * could not be had, since it is shown when it could. A change the robot
 * accepted is followed by asking for the schedule, because its answer says
 * nothing of that, not even the id it gave a new event.
 */
async function askSchedule(mine, action, label, more = {}) {
  const plan = mine.schedule;
  if (plan.waiting) return;
  plan.waiting = action;
  if (action === 'show') plan.asked = mine.body?.robot.session?.since ?? null;
  drawRobot(mine);
  const address = `api/schedule?${new URLSearchParams({ ...mine.robot, action, ...more })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  plan.waiting = null;
  const went = outcome(label, status, answer);
  if (went.tone !== 'good' || action !== 'show') report(mine, 'schedule', went);
  if (mine !== view) return;
  if (went.tone === 'good' && action === 'show') {
    plan.shown = record(answer.body);
  } else if (went.tone === 'good') {
    plan.form = null;
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
  drawRobot(mine);
  app.querySelector('[data-focus="plan-time"]')?.focus();
}

/** Ask for the event in the form to be added, or to be put in place of the one the form was opened on. */
function save(mine) {
  const plan = mine.schedule;
  const { id, enabled, time, mode, navigation, floor, zone, nogo, runs } = plan.form;
  const label = id === null ? 'Add event' : 'Save event';
  const days = DAYS.map(([name]) => name).filter((name) => plan.form.days.includes(name));
  if (days.length === 0) {
    report(mine, 'schedule', { tone: 'bad', text: `${label}: choose at least one day` });
    return;
  }
  // The form has the settings, the floor plan and the zone of an event's only run. The runs of an event with more go back as the robot gave them.
  const changed = runs.length === 1
    ? [{ ...runs[0], settings: { mode, navigation_mode: navigation }, map: placed(floor, zone, nogo) }]
    : runs;
  const event = sent({ id, enabled, days, time, runs: changed });
  askSchedule(mine, id === null ? 'add' : 'update', label, { event: JSON.stringify(event) });
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

/** A field of a form that is a choice of Yes and No, as a switch, which `set` is told of as true or false. `label` names it to a screen reader. */
function yesNo(label, focus, on, set) {
  return h('input', {
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    checked: on,
    'aria-label': label,
    'data-focus': focus,
    onchange: ({ target }) => set(target.checked),
  });
}

/**
 * A field of a form that is a choice of one of `values`, as a group of buttons
 * side by side, the one `chosen` lit, which `set` is told of as the value it
 * chooses. Each is a radio button under its label, so the group does what a
 * list does: the Tab key stops at the one chosen, and the arrow keys choose
 * another, and Enter does not send the form it is in, which a radio button
 * would. `label` names it to a screen reader, and `focus` names the group,
 * and with a value each of its buttons, to the keyboard.
 */
function oneOf(label, focus, values, chosen, set) {
  return h('div', {
    class: 'segments',
    role: 'radiogroup',
    'aria-label': label,
    // Not the Enter that ends the composing of a character.
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
    },
  },
    values.map((value) => h('label', { class: 'segment' },
      h('input', {
        type: 'radio',
        name: focus,
        value,
        checked: value === chosen,
        'data-focus': `${focus}-${value}`,
        onchange: ({ target }) => set(target.value),
      }),
      h('span', null, value))));
}

// What sets a zone in from its floor plan in a list of them: spaces that do not break, since a list lays out nothing of an option.
const ZONE_INDENT = '    ';

/**
 * A floor plan of `plans` as `placeField` offers it: by what its map is called,
 * or how what the robot knows it by begins where the server does not know that
 * map, with its zones by name, or by how what the robot knows one by begins
 * where it has none.
 */
function placeOf(plan) {
  return {
    uuid: plan.rank_uuid,
    label: floorText(plan.rank_uuid, [plan]),
    zones: plan.zones.map((zone) => ({ track: zone.track_uuid, label: word(zone.name) ?? short(zone.track_uuid) })),
  };
}

/**
 * The field that chooses where a run cleans, as one list: on no floor plan, on
 * one of `floors` whole, or on one of its zones, which stand under it and are
 * set in from it. A floor is its `uuid`, its `label` and its `zones`, each a
 * `track` and a `label`. `floor` and `zone` are what is chosen, empty for none
 * and for the whole of it, and `choose` is told of a choice as those two. A
 * list shows of a zone only its name, so the field says the floor plan as well
 * to a pointer that rests on it.
 */
function placeField(focus, floors, floor, zone, choose) {
  // The choices by their place in the list, since a robot chooses the names they are made of.
  const places = [['', '', null]];
  const option = (uuid, track, label, path) => {
    places.push([uuid, track, path]);
    return h('option', { value: String(places.length - 1), selected: uuid === floor && track === zone }, label);
  };
  const choices = floors.flatMap((each) => [
    option(each.uuid, '', each.label, each.label),
    ...each.zones.map((known) => option(each.uuid, known.track, `${ZONE_INDENT}${known.label}`, `${each.label} · ${known.label}`)),
  ]);
  const chosen = places.find(([uuid, track]) => uuid === floor && track === zone);
  return h('select', {
    'aria-label': 'Floor plan',
    title: chosen?.[2],
    'data-focus': focus,
    onchange: ({ target }) => {
      const [uuid, track, path] = places[Number(target.value)];
      target.title = path ?? '';
      choose(uuid, track);
    },
  }, h('option', { value: '0', selected: floor === '' }, 'None'), choices);
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
  // The zones of a floor plan the run cleans, or was last given here, that the server did not have the robot keep. Each stays
  // to choose under its floor plan, since a select whose value is none of its options shows another.
  const unlisted = ({ uuid, zones }) => [...new Set([uuid === own ? ownZone : null, uuid === draft.floor ? draft.zone : null])]
    .filter((track) => track && !zones.some((known) => known.track === track))
    .map((track) => ({ track, label: `⚠ ${short(track)} · not listed` }));
  // What there is to choose from: no floor plan, then those, then the ones the server had the robot keep, each with its zones.
  const floors = set ? [
    ...lost.map((uuid) => ({ uuid, label: `⚠ ${short(uuid)} · not listed`, zones: [] })),
    ...plans.map(placeOf),
  ].map((place) => ({ ...place, zones: [...unlisted(place), ...place.zones] })) : [];
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
  const nogoField = set && yesNo('No-go lines', 'plan-nogo', draft.nogo, (on) => { draft.nogo = on; });
  // On no floor plan, a run has no no-go lines to mind.
  if (set) nogoField.disabled = draft.floor === '';
  // On the floor plan the run is on, its no-go lines are as the robot gave them, and on another they are minded where
  // the server had the robot keep some. Another zone of the floor plan that is chosen leaves them as they are.
  const choose = (floor, zone) => {
    if (floor !== draft.floor) draft.nogo = floor === own ? ownNogo : Boolean(plans.find((known) => known.rank_uuid === floor)?.nogo);
    draft.floor = floor;
    draft.zone = zone;
    nogoField.disabled = floor === '';
    nogoField.checked = draft.nogo;
    depict();
  };
  // A line names its field to the eye, and this to a screen reader.
  const choice = (name, label, values) => oneOf(label, `plan-${name}`, values, draft[name], (value) => { draft[name] = value; });
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
    ['Floor plan', set ? placeField('plan-floor', floors, draft.floor, draft.zone, choose) : floorShown(runs, plans, true)],
    ...(set ? [['No-go lines', nogoField]] : [
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
 * Ask in a popover whether the event whose id is `id` is to go from the
 * robot's schedule. Its row is named to the keyboard by where it stands among
 * the events, `n`, so the question stands while the event there is that one.
 */
function askDrop(mine, id, n) {
  popover(mine, `slot-drop-${n}`, {
    title: 'Delete event',
    text: 'Delete this event? The robot takes it out of its schedule.',
    answers: [['Delete it', () => askSchedule(mine, 'delete', 'Delete event', { id })]],
    stands: () => record(mine.schedule.shown?.events?.[n]).id === id,
  });
}

/**
 * An event of the schedule as a row of the table: when it starts and on which
 * days, what its runs are set to and the floor plan they are on, and at its
 * end the buttons that turn it on or off, open the form on it and ask, in a
 * popover, whether to delete it. `n` is where it stands among the events. The
 * row opens on the form of the event, which says what the event has, and Edit
 * opens it with the fields that change that; it is not shut while they are
 * there.
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
  const toggle = () => askSchedule(mine, 'update', on ? 'Turn event off' : 'Turn event on', {
    event: JSON.stringify(sent({ ...event, enabled: !on, runs })),
  });
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
      planButton(mine, robot, 'Delete', `slot-drop-${n}`, () => askDrop(mine, id, n), { why, glyph: 'trash', alone: true }),
    ],
    detail:() => [scheduleForm(mine, robot, plans, event, changing ? plan.form : null, `slot-edit-${n}`)],
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
  ], { wide: true, tools });
}

// ---- The settings of one robot ----
//
// The robot keeps its settings and the server none of them, so they are read
// from a connected robot, as its schedule is: each with the action of its name,
// and changed with that name after `set_`. The answer to a change says nothing
// of the setting, so it is read again after one. Reading them all is three
// calls to the robot, and six events, so they are asked for only once the
// Settings tab is shown, and then once for each connection. They are one form,
// always open on what the robot last gave, whose Save sends those that were changed.

// The settings, under the names the server knows them by, in the order of their lines.
const SETTINGS = ['robot_language', 'cleaning_options', 'ota_updates'];

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
function switchWays(field, label) {
  return {
    title: label,
    draft: (given) => ({ [field]: given[field] === true }),
    lines: (given, draft, changed) => [[label, yesNo(label, `setting-${field}`, draft[field], (on) => {
      draft[field] = on;
      changed();
    })]],
    value: (draft) => ({ [field]: draft[field] }),
  };
}

// How each setting is shown and changed: what it is called, in its line while
// the robot has not given it and in a toast; the draft its field starts from,
// or null where the robot gave nothing to choose from; its lines, of what the
// robot gave and the draft, each with its field, which writes to the draft and
// tells `changed` so, or with what the robot gave where there is no draft; and
// what the server is sent, made of the draft.
const SETTING_WAYS = new Map([
  ['robot_language', {
    title: 'Language',
    draft: (given) => {
      const offered = languages(given);
      // The robot matches a language in whatever case, and may give its own in another than its list's.
      const own = typeof given.language === 'string' ? given.language.toLowerCase() : null;
      return offered.length === 0 ? null : { language: offered.find((one) => one.toLowerCase() === own) ?? offered[0], offered };
    },
    lines: (given, draft, changed) => [
      ['Language', draft !== null
        ? h('select', {
          'aria-label': 'Language',
          'data-focus': 'setting-language',
          onchange: ({ target }) => {
            draft.language = target.value;
            changed();
          },
        }, draft.offered.map((language) => h('option', { value: language, selected: language === draft.language }, languageName(language))))
        : typeof given.language === 'string' && given.language !== '' ? languageName(given.language)
        : plain(given.language)],
      // Which only some robots give, and none is told.
      ...(Object.hasOwn(given, 'gender') ? [['Gender', plain(given.gender)]] : []),
    ],
    value: ({ language }) => ({ language }),
  }],
  ['cleaning_options', switchWays('force_floorplan', 'Force floor plan')],
  ['ota_updates', switchWays('auto', 'Automatic updates')],
]);

/** Ask the robot, through the server, for one of its settings, or to change one: the status and the answer. */
function askSetting(mine, action, more = {}) {
  const address = `api/settings?${new URLSearchParams({ ...mine.robot, action, ...more })}`;
  return ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
}

/**
 * Read the settings `names` from the robot, one after the other. The view's
 * `settings` keeps what the robot gave for each, and sets its field to that,
 * and holds the buttons and the fields back until the last has been read. A
 * toast says why the robot did not give one.
 */
async function readSettings(mine, names) {
  const job = mine.settings;
  job.waiting = names;
  drawRobot(mine);
  for (const [n, name] of names.entries()) {
    const [status, answer] = await askSetting(mine, name);
    const ways = SETTING_WAYS.get(name);
    const went = outcome(ways.title, status, answer);
    if (went.tone !== 'good') report(mine, `setting-${name}`, went);
    if (mine !== view) return;
    if (went.tone === 'good') {
      job.shown[name] = record(answer.body);
      job.drafts[name] = ways.draft(job.shown[name]);
    }
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

/** Whether the field of the setting `name` holds other than what the robot last gave for it. */
function edited(job, name) {
  const ways = SETTING_WAYS.get(name);
  const draft = job.drafts[name] ?? null;
  // The draft was made of what the robot gave, so one made of that again is what the field started at.
  return draft !== null && JSON.stringify(ways.value(draft)) !== JSON.stringify(ways.value(ways.draft(job.shown[name])));
}

/**
 * Ask the robot to take each setting whose field was changed, one after the
 * other, and stop at the first it does not take. A toast says how that went,
 * and those it took are read again. The fields of the others keep what was
 * chosen, so Save sends them again.
 */
async function saveSettings(mine) {
  const job = mine.settings;
  const names = SETTINGS.filter((name) => edited(job, name));
  if (names.length === 0) return;
  // What is sent is what the fields held when Save was pressed; they are held back from then on.
  const values = names.map((name) => JSON.stringify(SETTING_WAYS.get(name).value(job.drafts[name])));
  job.waiting = names;
  drawRobot(mine);
  const saved = [];
  let went = null;
  for (const [n, name] of names.entries()) {
    const [status, answer] = await askSetting(mine, `set_${name}`, { value: values[n] });
    went = outcome(`Save ${SETTING_WAYS.get(name).title.toLowerCase()}`, status, answer);
    if (went.tone !== 'good') break;
    saved.push(name);
  }
  job.waiting = null;
  report(mine, 'settings', went.tone === 'good' && names.length > 1 ? { tone: 'good', text: 'Save settings: the robot accepted them' } : went);
  if (mine !== view) return;
  if (saved.length > 0) readSettings(mine, saved);
  else drawRobot(mine);
}

/**
 * The settings as one panel, which is a form always open: a line to each, with
 * its field once the robot has given it, and Save under them, which is held
 * back until a field holds other than what the robot gave. Beside the heading,
 * Refresh reads them all again, which sets the fields to what the robot gives.
 */
function settingsPanel(mine, robot) {
  const job = mine.settings;
  const waiting = job.waiting !== null;
  const tools = h('div', { class: 'panel-tools' },
    robotButton(job, robot, 'Refresh', 'settings-read', () => readSettings(mine, SETTINGS), { glyph: 'refresh' }));
  if (!SETTINGS.some((name) => Object.hasOwn(job.shown, name))) {
    return panel('Settings', h('p', { class: 'plan-note' }, none(!robot.session ? 'The robot is not connected.'
      : waiting ? 'Asking the robot…'
      : 'Not read from the robot.')), { tools });
  }
  const button = h('button', { class: 'command', type: 'submit', disabled: !robot.session, 'data-focus': 'setting-save' }, 'Save');
  // Told by a field as it changes, which draws nothing anew, as no field of a form does; held back, not disabled,
  // since the keyboard is on Save while the robot answers it.
  const changed = () => {
    if (!robot.session) {
      button.title = 'Save: the robot is not connected';
      return;
    }
    const why = job.waiting ? 'waiting for the robot to answer'
      : !SETTINGS.some((name) => edited(job, name)) ? 'nothing has been changed'
      : null;
    if (why) {
      button.setAttribute('aria-disabled', 'true');
      button.title = `Save: ${why}`;
    } else {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('title');
    }
  };
  changed();
  const lines = SETTINGS.flatMap((name) => {
    const ways = SETTING_WAYS.get(name);
    if (!Object.hasOwn(job.shown, name)) {
      return [[ways.title, none(job.waiting?.includes(name) ? 'Asking the robot…' : 'Not read from the robot.')]];
    }
    return ways.lines(job.shown[name], job.drafts[name] ?? null, changed);
  });
  const form = h('form', {
    class: 'setting-form',
    onsubmit: (submit) => {
      submit.preventDefault();
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      getSelection().removeAllRanges();
      if (!job.waiting) saveSettings(mine);
    },
  },
  rows(lines),
  h('div', { class: 'slot-tools' }, button));
  // Nothing is changed while the robot is asked, which would be lost when what it gives is read.
  for (const field of form.querySelectorAll('input, select')) field.disabled = waiting;
  return panel('Settings', form, { tools });
}

// ---- One robot ----

// The commands a robot takes, by the name the server knows each under: the
// label and the icon. The field that says whether the robot would accept one
// now is that name after `can_`, but for those of UNLISTED.
const COMMANDS = [
  ['start', 'Start', 'play'],
  ['pause', 'Pause', 'pause'],
  ['resume', 'Resume', 'resume'],
  ['cancel', 'Cancel', 'cross'],
  ['return_to_base', 'Return to base', 'dock'],
  ['find_me', 'Find me', 'sound'],
];

// The command a robot's status does not say whether it would accept: the sound
// it is found by. It is sent whenever the robot is connected, and since it
// changes nothing of what the robot would accept, the robot's next status is
// not waited for, before it or after it.
const UNLISTED = new Set(['find_me']);

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

// The alert a robot raises when a start it accepted cannot load the floor plan, the zone or the no-go lines of its run.
const LOAD_FAIL = 'pm_load_fail';

/** Whether the robot's errors hold the alert of a floor plan that could not be loaded. */
function loadFailing(robot) {
  const value = parsed(robot?.errors);
  return Array.isArray(value) && value.some((error) => error?.code === LOAD_FAIL);
}

/**
 * Whether the robot has said, since it accepted the start the view's `started`
 * is of, that it could not load what that start was to clean on. The spec has
 * the 200 of a start acknowledge the command and no more, and the robot say
 * this afterwards (section 6.1): in an event and a notification, which come
 * when the alert is new, and in the errors of its status, which may still hold
 * it from before the start, when they are not taken for it.
 */
function startFailed(started, body) {
  const said = (event) => {
    const told = record(parsed(event.body_json));
    return (event.kind === 'event' && event.service === 'robots.error_codes' && told.code === LOAD_FAIL)
      || (event.kind === 'request' && event.service === 'robots.notify' && told.message_code === LOAD_FAIL);
  };
  return body.events.some((event) => event.at > started.sent && said(event))
    || (!started.had && body.robot.state_at > started.sent && loadFailing(body.robot));
}

/**
 * Send the robot a command and say in a toast how it went, in place of how the
 * one before it went. A start may be given the `run` it is to clean.
 */
async function send(mine, name, label, run = null) {
  const listed = !UNLISTED.has(name);
  if (mine.command?.waiting || (listed && awaiting(mine))) return;
  // A selection would hold the page as it is, and the press has to show.
  getSelection().removeAllRanges();
  const had = loadFailing(mine.body?.robot);
  // The sound changes nothing of a start, which may still fail to load what it was to clean on.
  if (listed) mine.started = null;
  mine.command = { name, waiting: true };
  drawRobot(mine);
  const address = `api/command?${new URLSearchParams({ ...mine.robot, command: name, ...(run && { run: JSON.stringify(run) }) })}`;
  const [status, answer] = await ask(address, new AbortController(), COMMAND_TIMEOUT_MS, 'POST');
  const said = outcome(label, status, answer);
  // The spec has a robot answer this, with nothing more, to a start on a floor plan or a zone that it does not have.
  if (status === 200 && answer.code === 422 && run?.map) {
    said.text = `${label}: the robot answered 422, which it gives for a floor plan or a zone it does not have`;
  }
  report(mine, 'command', said);
  mine.command = null;
  // Both times are the server's, as text that sorts by time. The browser's own is for how long to keep asking eagerly.
  if (said.tone === 'good' && listed) mine.accepted = { sent: answer.sent, at: Date.now() };
  if (said.tone === 'good' && name === 'start') mine.started = { sent: answer.sent, at: Date.now(), had, label };
  if (mine !== view) return;
  drawRobot(mine);
  // The robot's new state and the events of this command are worth more now than at the next turn.
  refresh(mine);
}

/** Why the robot would not take the command `name` now, going by its last state, or null when it would. */
function barred(robot, name) {
  const value = robot[`can_${name}`];
  return !robot.session ? 'the robot is not connected'
    : UNLISTED.has(name) || isOn(value) ? null
    : isOff(value) ? 'the robot would not accept it now'
    : 'the robot has not said whether it would accept it';
}

/**
 * Shut the menu of the Start button. The keyboard goes back to what opened it,
 * unless `back` is false, as for a press elsewhere, which leaves the keyboard
 * and any selection where that press put them.
 */
function shutStart(mine, back = true) {
  mine.start.open = false;
  // A selection would hold the page as it is, and so would a field of the menu while the keyboard is in it.
  if (back) getSelection().removeAllRanges();
  if (document.activeElement?.closest('.start-menu')) document.activeElement.blur();
  drawRobot(mine);
  if (back) app.querySelector('[data-focus="start-options"]')?.focus();
}

/**
 * The other half of the Start button, which opens and shuts the menu that sets
 * what a start from it is to clean, and puts the keyboard in that menu. It is
 * disabled and held back as Start is, `why` and `wait` being why: `show` shuts
 * the menu once Start is disabled, and a hold begins only with a press of a
 * command, which shuts it too, so the menu is never open while this cannot be
 * pressed.
 */
function startToggle(mine, why, wait) {
  const start = mine.start;
  const held = why === null && wait !== null;
  return h('button', {
    class: 'command caret',
    type: 'button',
    disabled: why !== null,
    'aria-disabled': held && 'true',
    'aria-expanded': String(start.open),
    'aria-controls': start.open && 'start-menu',
    'aria-label': 'Start options',
    title: held ? `Start options: ${wait}` : why ? `Start options: ${why}` : 'Start options',
    'data-focus': 'start-options',
    'data-start': '',
    onclick: () => {
      if (held) return;
      if (start.open) {
        shutStart(mine);
        return;
      }
      start.open = true;
      // A selection would hold the page as it is, and the press has to show.
      getSelection().removeAllRanges();
      drawRobot(mine);
      app.querySelector(`[data-focus="start-mode-${start.mode}"]`)?.focus();
    },
  }, icon('down'));
}

/**
 * The menu of the Start button: the run a start from it is to clean, set as a
 * run of an event of the schedule is, and Start under it. The view's `start`
 * holds what is chosen, as it is chosen, and keeps it while the page is open,
 * so the menu opens again on the last choice. A floor plan is one of `plans`,
 * those the server had the robot keep, and a zone one of its zones; the Start
 * of the button itself cleans on no floor plan, in the first mode and
 * navigation mode. `why` is why the robot would not take a start now, and
 * `hold` why a press would do nothing for now, as for the other commands.
 * `away` is why the floor plan cannot be chosen, which is while the robot is
 * not on its base, when the run is on none: `show` sees to that. On no floor
 * plan there is no No-go lines, and the run minds none.
 */
function startMenu(mine, plans, why, hold, away) {
  const start = mine.start;
  // A group of buttons is no one control that a label could hold, so its field is a block it names.
  const field = (label, control) => h(control.matches('input, select') ? 'label' : 'div', { class: 'start-field' },
    h('span', null, label), control);
  const choice = (name, label, values) => oneOf(label, `start-${name}`, values, start[name], (value) => { start[name] = value; });
  const nogoField = yesNo('No-go lines', 'start-nogo', start.nogo, (on) => { start.nogo = on; });
  const nogoLine = field('No-go lines', nogoField);
  nogoLine.hidden = start.floor === '';
  const placeChoice = placeField('start-floor', plans.map(placeOf), start.floor, start.zone, (floor, zone) => {
    // Another floor plan minds its no-go lines where the server had the robot keep some, and another zone of the same one
    // leaves them as they are. None is no floor plan of `plans`, so it minds none.
    if (floor !== start.floor) start.nogo = Boolean(plans.find((plan) => plan.rank_uuid === floor)?.nogo);
    start.floor = floor;
    start.zone = zone;
    nogoLine.hidden = floor === '';
    nogoField.checked = start.nogo;
  });
  if (away !== null) {
    placeChoice.disabled = true;
    placeChoice.title = `Floor plan: ${away}`;
  }
  // Held back, not disabled, as the other commands are.
  const held = why === null && hold !== null;
  const button = h('button', {
    class: 'command',
    type: 'submit',
    disabled: why !== null,
    'aria-disabled': held && 'true',
    title: held ? `Start: ${hold}` : why && `Start: ${why}`,
    'data-focus': 'start-run',
  }, icon('play'), 'Start');
  return h('form', {
    class: 'start-menu',
    id: 'start-menu',
    'aria-label': 'Start options',
    'data-start': '',
    onsubmit: (event) => {
      event.preventDefault();
      if (mine.command?.waiting || awaiting(mine)) return;
      const run = { settings: { mode: start.mode, navigation_mode: start.navigation }, map: placed(start.floor, start.zone, start.nogo) };
      start.open = false;
      // A field that kept the focus would hold the page as it is, as a selection would, and the press has to show.
      button.focus();
      send(mine, 'start', 'Start', run);
      // The menu went with the press, so the keyboard goes to the Start that is waiting for the robot's answer.
      app.querySelector('[data-focus="can_start"]')?.focus();
    },
  },
  field('Mode', choice('mode', 'Mode', MODES)),
  field('Navigation', choice('navigation', 'Navigation', NAVIGATION_MODES)),
  field('Floor plan', placeChoice),
  nogoLine,
  plans.length === 0 && h('p', { class: 'hint' }, 'No floor plans yet: a map is made one on the Maps tab.'),
  h('div', { class: 'slot-tools' }, button));
}

/**
 * The commands as buttons. One can be pressed when the robot is connected and
 * its last state said it would accept that command. From when one is sent until the robot has answered and,
 * if it accepted, sent its next status, pressing any of them does nothing.
 * Find me, which a state says nothing of, can be pressed whenever the robot is
 * connected and no command waits for the robot's answer.
 * Start is two buttons in one, the second of which opens a menu under them
 * that sets what a start is to clean.
 */
function commands(mine, robot) {
  const sent = mine.command;
  const answering = sent?.waiting ? 'waiting for the robot to answer' : null;
  const hold = answering ?? (awaiting(mine) ? 'waiting for the robot\'s next status' : null);
  return h('div', {
    class: 'commands',
    // Not the Escape that ends the composing of a character.
    onkeydown: (event) => {
      if (event.key !== 'Escape' || event.isComposing || !mine.start.open) return;
      event.preventDefault();
      shutStart(mine);
    },
  },
  COMMANDS.map(([name, label, glyph]) => {
    const why = barred(robot, name);
    const wait = UNLISTED.has(name) ? answering : hold;
    // Held back, not disabled: a disabled button could not keep the keyboard's focus.
    const held = why === null && wait !== null;
    const button = h('button', {
      class: `command${sent?.waiting && sent.name === name ? ' busy' : ''}`,
      type: 'button',
      disabled: why !== null,
      'aria-disabled': held && 'true',
      title: held ? `${label}: ${wait}` : why && `${label}: ${why}`,
      'data-focus': `can_${name}`,
      onclick: () => send(mine, name, label),
    }, icon(glyph), label);
    return name === 'start' ? h('div', { class: 'split' }, button, startToggle(mine, why, wait)) : button;
  }),
  mine.start.open && startMenu(mine, plansOf(mine.body), barred(robot, 'start'), hold,
    isOn(robot.is_docked) ? null : 'the robot is not docked'));
}

/**
 * Ask the server to call the robot what `draft` holds, or by its serial again
 * where that holds nothing, and say in a toast how that went. The view's
 * `naming` holds whether the server has yet to answer. Once the name is saved,
 * the popover it was entered in is shut.
 */
async function rename(mine, draft) {
  const naming = mine.naming;
  if (naming.waiting) return;
  naming.waiting = true;
  drawRobot(mine);
  const address = `api/name?${new URLSearchParams({ ...mine.robot, name: draft })}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  naming.waiting = false;
  // From the robot as it was called until now.
  report(mine, 'name', status !== 200 ? { tone: 'bad', text: `Rename robot: ${answer?.error ?? 'no answer from the server'}` }
    : answer.name === null ? { tone: 'good', text: 'Rename robot: it goes by its board serial again' }
    : { tone: 'good', text: `Rename robot: it is now called ${answer.name}` });
  if (mine !== view) return;
  if (status === 200) {
    // The answer has the name as the server keeps it. It goes on the page now, and an
    // answer that was asked for before the change, which has the old one, is dropped.
    if (mine.body) mine.body.robot.name = answer.name;
    if (popped?.mine === mine && popped.anchor === 'rename') closePopover();
    refresh(mine);
  }
  drawRobot(mine);
}

/** Ask the server to delete the robot, say in a toast how that went, and go to the list of the others once it has. */
async function forget(mine) {
  const deleting = mine.deleting;
  deleting.waiting = true;
  drawRobot(mine);
  const address = `api/delete?${new URLSearchParams(mine.robot)}`;
  const [status, answer] = await ask(address, new AbortController(), FETCH_TIMEOUT_MS, 'POST');
  deleting.waiting = false;
  report(mine, 'delete', status !== 200 ? { tone: 'bad', text: `Delete robot: ${answer?.error ?? 'no answer from the server'}` }
    : { tone: 'good', text: 'Delete robot: it is gone from this server' });
  if (mine !== view) return;
  if (status !== 200) {
    drawRobot(mine);
    return;
  }
  // The robot has no page any more.
  location.hash = '#/';
}

/**
 * The button that asks, in a popover, whether the robot is to be deleted, and
 * what doing it means. It does nothing while the server has yet to answer.
 */
function deleteButton(mine) {
  return h('button', {
    class: 'button',
    type: 'button',
    // Held back, not disabled: a disabled button could not keep the keyboard's focus.
    'aria-disabled': mine.deleting.waiting && 'true',
    'data-focus': 'delete',
    onclick: () => {
      if (mine.deleting.waiting) return;
      popover(mine, 'delete', {
        title: 'Delete robot',
        text: 'Delete this robot? Its state, its events, its maps, its name and those of its maps are deleted from the database, '
          + 'and so is its key, if the server keeps one for it. If it is connected, its connection is ended. '
          + 'None of this can be undone. A robot that can still log in is listed again, as a new one, once it connects.',
        answers: [['Delete it', () => forget(mine)]],
      });
    },
  }, icon('trash'), 'Delete');
}

/**
 * What the robot is called, beside the button that asks in a popover what it
 * is to be called, and the one that asks whether to delete the robot. Neither
 * does anything while the server has yet to answer it.
 */
function nameLine(mine, robot) {
  const waiting = mine.naming.waiting;
  return h('div', { class: 'hero-name' },
    called('h1', robot),
    h('button', {
      class: 'button',
      type: 'button',
      // Held back, not disabled: a disabled button could not keep the keyboard's focus.
      'aria-disabled': waiting && 'true',
      title: waiting && 'Rename: waiting for the server to answer',
      'data-focus': 'rename',
      onclick: () => {
        if (mine.naming.waiting) return;
        // A selection would hold the page as it is, and the press has to show.
        getSelection().removeAllRanges();
        askName(mine, 'rename', 'Rename robot', {
          name: robot.name,
          placeholder: robot.serial,
          text: 'Only this server knows the name. Left empty, the robot goes by its board serial.',
          save: (draft) => rename(mine, draft),
        });
      },
    }, icon('pencil'), 'Rename'),
    deleteButton(mine));
}

function hero(mine, robot) {
  return h('section', { class: 'card hero' },
    h('div', { class: 'avatar' }, icon('robot')),
    h('div', { class: 'hero-main' },
      nameLine(mine, robot),
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

/** Lines of a name and a value, each `[label, value]`, or `[label, value, true]` for a value laid out under its name, the panel's width. */
function rows(pairs) {
  return h('dl', { class: 'kv' }, pairs.map(([label, value, under]) =>
    h('div', { class: under ? 'kv-under' : null }, h('dt', null, label), h('dd', null, value))));
}

/**
 * The line of the errors the robot reports: a dash for none; a table of them,
 * under the line's name, where they are what the spec has them be, a list of
 * objects; and otherwise as sent.
 */
function errorsLine(robot) {
  const value = parsed(robot.errors);
  if (isEmpty(value)) return ['Errors', none()];
  if (!Array.isArray(value) || !value.every((error) => error !== null && typeof error === 'object' && !Array.isArray(error))) {
    return ['Errors', h('span', { class: 'mono bad' }, typeof value === 'string' ? value : JSON.stringify(value))];
  }
  return ['Errors', errorTable(value), true];
}

/**
 * The errors as a table of their code and severity, and the zone where one
 * names one. A warning is yellow and any other severity red, as the events
 * have them.
 */
function errorTable(list) {
  const zoned = list.some((error) => word(error.zone_name) !== null);
  const columns = [['Code', 'code'], ['Severity', 'severity'], ...(zoned ? [['Zone', 'zone']] : [])];
  return h('table', { class: 'errors', 'aria-label': 'Errors' },
    h('thead', null, h('tr', null, columns.map(([title, kind]) => h('th', { class: `cell-${kind}`, scope: 'col' }, title)))),
    h('tbody', null, list.map((error) => {
      const severity = word(error.severity);
      return h('tr', null,
        h('td', { class: 'mono' }, word(error.code) ?? none()),
        h('td', null, severity === null ? none() : pill(isWarning(error) ? 'warn' : 'bad', severity, 'alert')),
        zoned && h('td', null, word(error.zone_name) ?? none()));
    })));
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
      ['Action', plain(actionShown(robot))],
      errorsLine(robot),
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
  ['maps', 'Maps', (mine, body) => mapPanels(mine, body)],
  ['settings', 'Settings', (mine, { robot }) => settingsPanel(mine, robot)],
  ['events', 'Events', (mine, body) => panel('Events', eventLog(mine, body), { wide: true })],
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

/**
 * Show how the server's connection to Home Assistant's MQTT broker is, as an answer gives it: `null` from a server
 * that has no broker, which hides the indicator, and nothing while the server cannot be reached, which makes it not known.
 */
function setHomeAssistant(told) {
  if (told === null) {
    homeAssistant.hidden = true;
    return;
  }
  const [state, text] = told === undefined ? ['loading', 'not known while the server cannot be reached']
    : told.connected ? ['ok', 'connected to the MQTT broker']
    : told.error ? ['down', `no connection to the MQTT broker: ${told.error}`]
    : ['loading', 'connecting to the MQTT broker'];
  // One that is hidden stays hidden until the server says it has a broker.
  if (told !== undefined) homeAssistant.hidden = false;
  homeAssistant.dataset.state = state;
  homeAssistant.title = `Home Assistant: ${text}`;
  homeAssistant.setAttribute('aria-label', homeAssistant.title);
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

/**
 * Put `build()` on screen unless `data`, which it is built from, is what is
 * already there, or unless the reader is at something a new page would undo,
 * where it is to `hold`. Say whether it was put there.
 */
function draw(mine, data, build, hold = true) {
  const drawn = JSON.stringify(data);
  if (drawn === mine.drawn || (hold && (selecting() || entering() || dragging()))) return false;
  // Whatever had the keyboard's focus is replaced too, so hand it to its successor, and a field keeps where its caret was.
  // It is asked for first: building the page takes the pictures of the maps out of the old one.
  const at = document.activeElement;
  const focus = at?.dataset?.focus;
  const caret = at?.matches('input[type="text"]') ? [at.selectionStart, at.selectionEnd] : null;
  const page = build();
  if (mine.drawn === null) page.classList.add('enter');
  mine.drawn = drawn;
  app.replaceChildren(page);
  const next = focus && app.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
  next?.focus({ preventScroll: true });
  if (caret && next?.matches('input[type="text"]')) next.setSelectionRange(...caret);
  return true;
}

/** Draw the robot's page from the server's last answer and what its view holds, which a press on the page changes between answers. */
function drawRobot(mine) {
  const body = mine.body;
  if (mine !== view || !body) return;
  const data = [
    body.robot, body.events, body.more, body.maps, body.more_maps, body.floorplans, body.floorplan_maps, body.tracks,
    body.map_names, mine.tab, mine.naming, mine.mapNaming, mine.mapDeleting, mine.command, mine.accepted, mine.start,
    mine.schedule, mine.settings, mine.floors, mine.tracks, mine.deleting,
    // For the colours of the zones beside the pictures of floor plans.
    scheme(),
  ];
  draw(mine, data, () => robotPage(mine, body));
  // The pictures of the maps are no part of what is drawn, and what is drawn over them may have changed.
  repaint(mine);
  // Nor is a popover, whose button may be new, held back or gone.
  placePopover();
}

// What the toast that says the server cannot be reached said, while it cannot, or null while it can.
let down = null;

// The version of this page, which the server wrote into it. Each answer the page polls for gives the version that the
// server has, which is another once the server has been started with other files: this page is then out of date.
const VERSION = document.querySelector('meta[name="deorbit-version"]')?.content;
// The other version the server was last found to have, or null while it has this one.
let newer = null;

/** Offer to reload the page while the server has a `version` of it other than this one. */
function outdated(version) {
  if (version === VERSION) {
    newer = null;
    hush('version');
    return;
  }
  // Said once of each version, as the server being out of reach is, so that a toast that was closed stays closed.
  if (version === newer) return;
  newer = version;
  toast('version', {
    tone: 'accent',
    text: 'The server has a new version of this page. Reload it to use that one.',
    glyph: 'refresh',
    action: ['Reload', 'refresh', () => location.reload()],
  }, 'Server');
}

function show(mine, status, body) {
  const missing = status === 404 && mine.robot && body?.error;
  if (status !== 200 && !missing) {
    // No answer at all, or one that says what went wrong. What is on screen stays.
    setLive('down', body?.error ? 'Server error' : 'Reconnecting');
    setHomeAssistant();
    const text = body?.error
      ? `The server could not answer: ${body.error}`
      : 'Cannot reach the server. Trying again every few seconds.';
    // Said once and not at every turn, so that a toast that was closed stays closed until there is something new to say.
    if (text !== down) toast('server', { tone: 'bad', text }, 'Server');
    down = text;
    return;
  }
  setLive('ok', 'Live');
  down = null;
  hush('server');
  if (missing) {
    mine.body = null;
    const { vendor, serial } = mine.robot;
    draw(mine, null, () => message('Robot not found',
      `${vendor}/${serial} is not in the database. A robot appears once it has connected and sent a state or a heartbeat.`));
  } else {
    clockOffset = Date.parse(body.now) - Date.now();
    outdated(body.version);
    setHomeAssistant(body.home_assistant);
    if (mine.robot) {
      mine.body = body;
      document.title = `${nameOf(body.robot)} · deorbit`;
      // A map deleted from another page is no more on this one.
      forgetMaps(mine);
      // What was being drawn on a floor plan that is one no more, of that map, has nothing to be drawn on.
      const edit = mine.tracks.edit;
      if (edit && !body.floorplans.some((plan) => plan.rank_uuid === edit.rank && plan.map_id === edit.map)) mine.tracks.edit = null;
      // A floor plan or a zone that is kept no more, as after a Demote, is one the robot does not have to start on either.
      // A robot off its base starts on none, and on none a run has no no-go lines to mind.
      const start = mine.start;
      // A start the robot would not take has no menu, its arrow being disabled with Start. A menu the keyboard is in stays
      // on screen, the page being held, until the keyboard leaves it.
      if (barred(body.robot, 'start') !== null) start.open = false;
      const kept = isOn(body.robot.is_docked) ? plansOf(body).find((plan) => plan.rank_uuid === start.floor) : null;
      if (!kept) start.floor = '';
      if (!kept?.zones.some((zone) => zone.track_uuid === start.zone)) start.zone = '';
      if (start.floor === '') start.nogo = false;
      // A start the robot accepted may still not clean, which the robot says only afterwards. That is said in the toast
      // of the commands, in place of its having been accepted, and stays until it is closed, as a command that failed does.
      const started = mine.started;
      if (started && Date.now() - started.at > START_WATCH_MS) mine.started = null;
      else if (started && startFailed(started, body)) {
        mine.started = null;
        report(mine, 'command', {
          tone: 'bad',
          text: `${started.label}: the robot accepted it, then could not load the floor plan, the zone or the no-go lines to clean on (${LOAD_FAIL})`,
        });
      }
      // The schedule is asked for once of each connection the page sees, not at every turn: asking is a call to the robot.
      const since = body.robot.session?.since;
      if (since && mine.schedule.asked !== since) askSchedule(mine, 'show', 'Schedule');
      settingsDue(mine);
      drawRobot(mine);
    } else if (!mine.bind) {
      mine.body = body;
      draw(mine, body.robots, () => listPage(mine, body.robots));
    }
    // The page that binds a robot is drawn by what is done on it. It asks for the list only to know that the server is
    // there and which version of the page it has.
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
    // What was said of why the page that binds a robot could not do it goes with it; how a robot was configured stays.
    if (view.bind) for (const key of BIND_HELD) hush(key);
    // A popover is no part of the page, so it does not go with it unless it is shut.
    closePopover(false);
  }
  const binds = location.hash === '#/bind';
  const mine = {
    robot: robotInAddress(),
    tab: TABS[0][0],
    asked: { events: EVENTS_STEP, maps: MAPS_STEP },
    open: new Set(),
    openMaps: new Set(),
    openSlots: new Set(),
    drawings: new Map(),
    // Whether the server has yet to answer the renaming of the robot, whose name is entered in a popover.
    naming: { waiting: false },
    // Whether the server has yet to answer the renaming of a map, whose name is entered in a popover.
    mapNaming: { waiting: false },
    // Whether the server has yet to answer the deleting of a map.
    mapDeleting: { waiting: false },
    // The command sent from this view, by its name, while the robot has yet to answer it.
    command: null,
    accepted: null,
    // The start the robot last accepted from this view, while it may yet say that it could not load what to clean on:
    // when it was sent, by the server's clock and by the browser's, whether its errors held that already, and its label.
    started: null,
    // Whether the menu of the Start button is open, and the run it sets: the settings, the floor plan by what the robot
    // knows it by or nothing for none, its zone the same way or nothing for the whole of it, and whether it minds its no-go lines.
    start: { open: false, mode: MODES[0], navigation: NAVIGATION_MODES[0], floor: '', zone: '', nogo: false },
    // How each request below went is said in a toast, and none of it is kept here.
    // The connection the schedule was last asked of, by when it began; what is waited for; what the robot gave;
    // and the form, when one is open.
    schedule: { asked: null, waiting: null, shown: null, form: null },
    // The connection the settings were last asked of; those that are being read or saved, while any is; what
    // the robot gave for each, by name; and what the field of each holds, by name, which is null for one that has none.
    settings: { asked: null, waiting: null, shown: {}, drafts: {} },
    // Whether the robot has yet to answer what was asked of it about a floor plan.
    floors: { waiting: false },
    // The same for the zones and no-go lines of a floor plan, and what the popover that draws them has, while it is open.
    tracks: { waiting: false, edit: null },
    // Whether the server has yet to answer the deleting of the robot.
    deleting: { waiting: false },
    // On the page that binds a robot, what it holds of the run under way, or else of a new one (see `freshBind`).
    bind: binds ? binding ?? freshBind() : null,
    body: null,
    drawn: null,
    controller: null,
    timer: 0,
    paused: false,
  };
  view = mine;
  // By its serial until the server has said what the robot is called.
  document.title = `${binds ? 'Bind a robot' : mine.robot ? mine.robot.serial : 'Robots'} · deorbit`;
  allRobots.hidden = !binds && !mine.robot;
  app.replaceChildren();
  scrollTo(0, 0);
  // That page has nothing to wait for before it is drawn.
  if (binds) openBind(mine);
  setTimeout(() => {
    if (mine === view && mine.drawn === null) app.replaceChildren(skeleton(mine.robot));
  }, SKELETON_MS);
  load(mine);
}

addEventListener('hashchange', navigate);
// A press anywhere but in the menu of the Start button, or on what opens it, shuts that menu, as a dropdown is shut. A
// press that drew the page anew has a target that is no longer in it, but still has the ancestors it had.
document.addEventListener('click', ({ target }) => {
  if (view?.start.open && !target.closest?.('[data-start]')) shutStart(view, false);
  // The same for a popover, which leaves the keyboard where that press put it.
  if (elsewhere(target)) closePopover(false);
});
// And the keyboard going anywhere else, or Escape, which puts it back on the button that opened it.
document.addEventListener('focusin', ({ target }) => {
  if (elsewhere(target)) closePopover(false);
});
document.addEventListener('keydown', (event) => {
  if (!popped || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closePopover();
    return;
  }
  // The Tab key from the button of a popover that is open goes into it, as if it stood after the button in the page,
  // which is how the keyboard comes back to one that stays open while it is elsewhere.
  const { target } = event;
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!app.contains(target) || target.dataset?.focus !== popped.anchor) return;
  event.preventDefault();
  popped.node.querySelector('input, select, button')?.focus();
});
// The button a popover is by moves when the page is laid out anew without being drawn anew, as when a row above it
// is opened or a map above it is drawn, and when the window changes its size.
new ResizeObserver(() => placePopover()).observe(app);
addEventListener('resize', () => placePopover());
// The pictures of the maps are painted in the colours of a scheme, which theme.js changes when another is chosen, or
// when the system's changes while auto is.
new MutationObserver(() => {
  if (!view?.robot) return;
  for (const pictured of view.drawings.values()) pictured.recolour?.();
  drawRobot(view);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && view?.paused) {
    view.paused = false;
    load(view);
  }
});
setInterval(tick, 1000);
navigate();
