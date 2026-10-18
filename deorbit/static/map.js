// How the page reads a map: the two pictures a robot uploads with one, and the
// one picture it draws from them. Nothing here touches the document.
//
// The spec says of a binary only that it is a "compressed PGM" file as Base64.
// The rest is read off what a robot on firmware 1.7.0 uploaded to this server:
//
// - The compression is zlib's and the file a binary PGM ("P5") of 2000 by 2000
//   cells, a byte each. Its header has a comment,
//   "# Neato metadata: origin_x=-40000 origin_y=-40000 resolution=40 alignment=0.000000",
//   which says where the cells are: the corner the picture starts from and the
//   side of a cell, in millimetres. The first row is the far end of the y
//   axis, so x runs across the picture and y up it.
// - A cell of `rank_binary` is how sure the robot is that something is there:
//   128 where it has not looked, down to 0 for clear floor, up to 255 for a wall.
// - In `real_binary`, 3 and 4 are the cells the robot cleaned: together they
//   came to the `stats.area` of the run, in square metres. What tells 3 from 4
//   is not known. 6 fills a square of 256 cells around where the robot has
//   been, and 0 the rest.
// - A heading (`dir`) is in degrees, anticlockwise from the x axis.

const INFLATED_MAX = 32 * 1024 * 1024; // the longest file a binary may inflate to; the robot's were 4 MB
const PIXELS_MAX = 8000000; // the largest picture made, in pixels, which are its cells
const MARGIN = 3; // how many cells are left around what the robot saw
const UNSEEN = 128;
const VALUES = 256; // how many values a cell can have
const COMMENT_MAX = 1024; // how much of a comment in a file's header is read

// The colours of a picture, for a dark page and for a light one, as red, green
// and blue. A canvas cannot take them from the stylesheet. The last two are
// what the page draws over the picture of a floor plan: its no-go lines, and
// its zones, a colour to each by its place among them, in this order, so that
// there are as many as a floor plan may have zones (ZONES_MAX in app.js).
//
// A zone's colour is the same hue on both pages, lime, orchid, rust, violet,
// pink and teal, a step lighter on the dark one. They were found by a search
// in OKLab, and checked there (distances times 100): on each page any two are
// at least 15.5 apart, and each is at least 15 from every other colour of the
// map, the no-go lines among them. Under protanopia and deuteranopia two are
// at least 6.9 apart, which the name drawn in each zone makes up for. The
// first are the farthest apart, as a floor plan has few zones: the first two
// are 45 apart, and no two of the first three are less than 26.
export const PALETTES = {
  dark: {
    unseen: [26, 30, 38],
    floor: [58, 66, 84],
    wall: [233, 236, 242],
    cleaned: [46, 150, 110],
    robot: [124, 157, 255],
    base: [243, 185, 78],
    nogo: [255, 114, 114],
    zones: [
      [116, 220, 0],
      [214, 114, 255],
      [193, 99, 0],
      [133, 87, 255],
      [255, 169, 236],
      [0, 203, 195],
    ],
  },
  light: {
    unseen: [226, 229, 236],
    floor: [255, 255, 255],
    wall: [20, 24, 33],
    cleaned: [140, 216, 182],
    robot: [52, 87, 227],
    base: [200, 126, 6],
    nogo: [208, 58, 58],
    zones: [
      [86, 167, 0],
      [129, 0, 166],
      [131, 65, 0],
      [156, 132, 255],
      [216, 26, 191],
      [0, 165, 158],
    ],
  },
};

const isSpace = (byte) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

function text(bytes) {
  return String.fromCharCode(...bytes);
}

async function inflate(packed) {
  // The two bytes zlib data starts with: the method, and a check on both.
  if ((packed[0] & 0x0f) !== 8 || ((packed[0] << 8) | packed[1]) % 31 !== 0) throw new Error('is not zlib data');
  if (typeof DecompressionStream === 'undefined') throw new Error('cannot be inflated by this browser');
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    let part;
    try {
      part = await reader.read();
    } catch {
      throw new Error('is zlib data that does not inflate');
    }
    if (part.done) break;
    size += part.value.length;
    // A few bytes can inflate to any length, and what they come to is held in memory.
    if (size > INFLATED_MAX) {
      reader.cancel().catch(() => {});
      throw new Error(`inflates to more than ${INFLATED_MAX / 1024 / 1024} MB`);
    }
    parts.push(part.value);
  }
  const file = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    file.set(part, at);
    at += part.length;
  }
  return file;
}

/** A binary PGM file as a picture: its cells, and what the comments in its header say of them. */
function readPgm(file) {
  const said = new Map();
  let at = 0;
  // The next word of the header. Comments may stand before any of them.
  const word = () => {
    for (;;) {
      while (at < file.length && isSpace(file[at])) at += 1;
      if (file[at] !== 0x23) break;
      const from = at;
      while (at < file.length && file[at] !== 0x0a && file[at] !== 0x0d) at += 1;
      const comment = text(file.subarray(from, Math.min(at, from + COMMENT_MAX)));
      for (const [, name, value] of comment.matchAll(/(\w+)=(-?\d+(?:\.\d+)?)/g)) {
        said.set(name, Number(value));
      }
    }
    const from = at;
    while (at < file.length && !isSpace(file[at]) && at - from < 16) at += 1;
    return text(file.subarray(from, at));
  };
  if (word() !== 'P5') throw new Error('is not a binary PGM file');
  const [width, height, most] = [word(), word(), word()].map((number) => (/^\d+$/.test(number) ? Number(number) : 0));
  if (width < 1 || height < 1 || most < 1) throw new Error('is a PGM file without a size');
  if (most >= VALUES) throw new Error('is a PGM file of two bytes to a cell');
  at += 1; // the one space that ends the header
  if (width * height > file.length - at) throw new Error('is a PGM file cut short');
  const [x, y, resolution] = ['origin_x', 'origin_y', 'resolution'].map((name) => said.get(name));
  return {
    width,
    height,
    cells: file.subarray(at, at + width * height),
    origin: x === undefined || y === undefined ? null : { x, y },
    resolution: resolution > 0 ? resolution : null,
  };
}

/**
 * A binary of a map as a picture: its `width` and `height` in cells, the
 * `cells` row by row from the top, and if its header says so the `origin` it
 * starts from and its `resolution`, the side of a cell, in millimetres. What
 * it throws says what is wrong with the binary, to follow its name.
 */
export async function readBinary(binary) {
  if (typeof binary !== 'string' || binary === '') throw new Error('is not there');
  let packed;
  try {
    const bytes = atob(binary);
    packed = new Uint8Array(bytes.length);
    for (let n = 0; n < bytes.length; n += 1) packed[n] = bytes.charCodeAt(n);
  } catch {
    throw new Error('is not Base64');
  }
  return readPgm(await inflate(packed));
}

function sameGrid(one, other) {
  return one.width === other.width && one.height === other.height && one.resolution === other.resolution
    && one.origin?.x === other.origin?.x && one.origin?.y === other.origin?.y;
}

/**
 * One picture of the two a map has: the floor and the walls of `rank` with the
 * cells of `real` that were cleaned, cut down to what the robot saw, a pixel to
 * a cell. Whoever shows it enlarges it. `real` may be null. `places` are
 * positions the map gives, by name.
 *
 * It is `width` by `height` pixels, as `rgba`, and starts at the cell `left`
 * across `rank` and `top` down it. `marks` are the places that are
 * on the map, each with where it is in the picture, in cells, and its heading. `cleaned`
 * is how many cells were, or null when `real` could not be laid over `rank`.
 * `odd` are the values in `real` that nothing here has a meaning for, each
 * with its count.
 */
export function paint(rank, real, places, palette) {
  const { width, height, cells } = rank;
  const over = real !== null && sameGrid(rank, real) ? real.cells : null;
  const counts = new Uint32Array(VALUES);
  const isCleaned = (at) => over !== null && (over[at] === 3 || over[at] === 4);

  let [left, top, right, bottom] = [width, height, -1, -1];
  const reach = (x, y) => {
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  };
  for (let y = 0, at = 0; y < height; y += 1) {
    let [first, last] = [-1, -1];
    for (let x = 0; x < width; x += 1, at += 1) {
      if (over !== null) counts[over[at]] += 1;
      if (cells[at] === UNSEEN && !isCleaned(at)) continue;
      if (first < 0) first = x;
      last = x;
    }
    if (first >= 0) {
      reach(first, y);
      reach(last, y);
    }
  }

  // Where each place is, in cells from the left and from the top.
  const spots = [];
  for (const [name, place] of Object.entries(rank.origin && rank.resolution ? places : {})) {
    if (!Number.isFinite(place?.x) || !Number.isFinite(place?.y)) continue;
    const x = (place.x - rank.origin.x) / rank.resolution;
    const y = height - (place.y - rank.origin.y) / rank.resolution;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    spots.push({ name, x, y, dir: Number.isFinite(place.dir) ? place.dir : null });
    reach(Math.floor(x), Math.floor(y));
  }
  if (right < 0) throw new Error('the robot marked nothing on it');

  left = Math.max(0, left - MARGIN);
  top = Math.max(0, top - MARGIN);
  right = Math.min(width - 1, right + MARGIN);
  bottom = Math.min(height - 1, bottom + MARGIN);
  const [across, down] = [right - left + 1, bottom - top + 1];
  if (across * down > PIXELS_MAX) throw new Error(`it is ${across} by ${down} cells, more than is drawn`);

  // The colour of each value a cell of the rank map can have: the less sure the robot was, the nearer to unseen.
  const shades = [];
  for (let value = 0; value < VALUES; value += 1) {
    const [colour, share] = value < UNSEEN
      ? [palette.floor, (UNSEEN - value) / UNSEEN]
      : [palette.wall, (value - UNSEEN) / (VALUES - 1 - UNSEEN)];
    shades.push(colour.map((full, n) => Math.round(palette.unseen[n] + (full - palette.unseen[n]) * share)));
  }

  const rgba = new Uint8ClampedArray(across * down * 4);
  for (let y = 0, to = 0; y < down; y += 1) {
    for (let x = 0; x < across; x += 1, to += 4) {
      const at = (top + y) * width + left + x;
      const [red, green, blue] = isCleaned(at) ? palette.cleaned : shades[cells[at]];
      rgba[to] = red;
      rgba[to + 1] = green;
      rgba[to + 2] = blue;
      rgba[to + 3] = 255;
    }
  }

  const odd = [];
  for (const [value, count] of counts.entries()) {
    if (count > 0 && ![0, 3, 4, 6].includes(value)) odd.push([value, count]);
  }
  return {
    width: across,
    height: down,
    left,
    top,
    rgba,
    marks: spots.map(({ name, x, y, dir }) => ({ name, x: x - left, y: y - top, dir })),
    cleaned: over === null ? null : counts[3] + counts[4],
    odd,
  };
}
