// palette-io.js — importing and persisting colour palettes. Pure and
// dependency-free: no WebGPU, no DOM beyond localStorage, so it is unit-tested
// in plain Node (tools/palette.test.js).
//
// The renderer's built-in palettes are Inigo Quilez cosine palettes — four
// coefficient triples evaluated as a + b*cos(2*PI*(c*t + d)) — which produce
// smooth, endlessly periodic ramps. An imported palette is the opposite shape:
// a short list of specific colours somebody chose. Fitting cosine coefficients
// to those swatches would reproduce most palettes only loosely, and the ones
// with a deliberate hard contrast not at all.
//
// So imported palettes are kept as what they are, a list of stops, and the
// shader gained a second palette mode that interpolates them. Nothing is
// approximated: the colours that come out are the colours that went in.
//
// EVERYTHING HERE PARSES UNTRUSTED INPUT — pasted text, dropped files — and so
// must never throw. Parsers return null on anything they do not understand.

// The shader carries a fixed-size stop array; see RAMP_MAX in fractal.wgsl.js.
export const MAX_STOPS = 8;
export const MIN_STOPS = 2;

const STORAGE_KEY = 'wgpu-fractal-modeler.palettes.v1';

/** Parse one #rrggbb / rrggbb / #rgb token to [r,g,b] in 0..1, or null. */
export function parseHexColor(token) {
  if (typeof token !== 'string') return null;
  const h = token.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    const v = [...h].map((ch) => parseInt(ch + ch, 16) / 255);
    return v;
  }
  if (/^[0-9a-fA-F]{6}$/.test(h)) {
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  return null;
}

/**
 * Colours out of a coolors.co URL.
 *
 * Their share links carry the palette in the path as hyphen-separated hex:
 *   https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51
 * with /palette/ and /visualizer/ variants. Taking the last path segment covers
 * all of them; a segment that is not entirely hex tokens is rejected rather
 * than partially accepted.
 */
export function parseCoolorsUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!/coolors\.co/i.test(s)) return null;
  const path = s.split(/[?#]/)[0].replace(/\/+$/, '');
  const seg = path.split('/').pop() || '';
  const parts = seg.split('-').filter(Boolean);
  if (parts.length < MIN_STOPS) return null;
  const colors = parts.map(parseHexColor);
  if (colors.some((c) => c === null)) return null;
  return colors;
}

/**
 * Colours out of a GIMP palette (.gpl).
 *
 * Header lines, then one `R G B  optional name` per colour, whitespace-aligned.
 * Comments start with '#'. Values outside 0..255 are treated as a malformed
 * file rather than clamped, since silently accepting them would import wrong
 * colours.
 */
export function parseGPL(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  if (!/^GIMP Palette/i.test((lines[0] || '').trim())) return null;

  let name = 'Imported';
  const colors = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    const named = line.match(/^Name:\s*(.+)$/i);
    if (named) { name = named[1].trim() || name; continue; }
    if (/^Columns:/i.test(line) || line.startsWith('#')) continue;
    const m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
    if (!m) continue;
    const rgb = [1, 2, 3].map((i) => Number(m[i]));
    if (rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return null;
    colors.push(rgb.map((v) => v / 255));
  }
  return colors.length >= MIN_STOPS ? { name, colors } : null;
}

/** Colours out of a loose list: "#264653, 2a9d8f" or one per line. */
export function parseHexList(text) {
  if (typeof text !== 'string') return null;
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length < MIN_STOPS) return null;
  const colors = tokens.map(parseHexColor);
  if (colors.some((c) => c === null)) return null;
  return colors;
}

/**
 * Accept whatever the user pasted or dropped.
 *
 * @returns {{name: string, colors: number[][], source: string}|null}
 */
export function parsePalette(input, fallbackName = 'Imported') {
  if (typeof input !== 'string' || !input.trim()) return null;

  const gpl = parseGPL(input);
  if (gpl) return { name: gpl.name, colors: clampStops(gpl.colors), source: 'gpl' };

  const co = parseCoolorsUrl(input);
  if (co) return { name: fallbackName, colors: clampStops(co), source: 'coolors' };

  const hex = parseHexList(input);
  if (hex) return { name: fallbackName, colors: clampStops(hex), source: 'hex' };

  return null;
}

/**
 * Fit a colour list to the shader's fixed stop count.
 *
 * Fewer than the maximum is passed through untouched — the shader is told how
 * many are live. More than the maximum is resampled evenly across the original
 * rather than truncated, so a long palette keeps its overall sweep instead of
 * losing its tail.
 */
export function clampStops(colors) {
  if (!Array.isArray(colors) || colors.length === 0) return [];
  if (colors.length <= MAX_STOPS) return colors.map(clampColor);
  const out = [];
  for (let i = 0; i < MAX_STOPS; i++) {
    const src = Math.round((i * (colors.length - 1)) / (MAX_STOPS - 1));
    out.push(clampColor(colors[src]));
  }
  return out;
}

function clampColor(c) {
  const v = Array.isArray(c) ? c : [0, 0, 0];
  return [0, 1, 2].map((i) => Math.max(0, Math.min(1, Number(v[i]) || 0)));
}

/** Mean colour of a ramp — the renderer tints its background with this. */
export function averageColor(colors) {
  if (!Array.isArray(colors) || colors.length === 0) return [0.5, 0.5, 0.5];
  const sum = [0, 0, 0];
  for (const c of colors) {
    const k = clampColor(c);
    sum[0] += k[0]; sum[1] += k[1]; sum[2] += k[2];
  }
  return sum.map((v) => v / colors.length);
}

/** Back to `#rrggbb`, for round-tripping into the UI. */
export function toHex(color) {
  const c = clampColor(color);
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// ---- Persistence ----------------------------------------------------------
// localStorage rather than cookies: cookies are capped near 4KB, are sent with
// every request, and are cleared by privacy settings that leave localStorage
// alone. Every entry point below tolerates storage being unavailable — private
// browsing and embedded webviews can make it throw on access, not just on write.

function readStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStore(obj) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(obj));
    return true;
  } catch (_) {
    return false;   // quota, or storage disabled
  }
}

/** Saved palettes as { name: colors[] }. */
export function listSavedPalettes() {
  const store = readStore();
  const out = {};
  for (const [name, colors] of Object.entries(store)) {
    const clean = Array.isArray(colors) ? clampStops(colors) : [];
    if (clean.length >= MIN_STOPS) out[name] = clean;
  }
  return out;
}

/** Persist a palette. Returns false if storage refused it. */
export function savePalette(name, colors) {
  const key = String(name || '').trim().slice(0, 48);
  const clean = clampStops(colors);
  if (!key || clean.length < MIN_STOPS) return false;
  const store = readStore();
  store[key] = clean.map((c) => c.map((v) => Math.round(v * 1000) / 1000));
  return writeStore(store);
}

export function deletePalette(name) {
  const store = readStore();
  if (!(name in store)) return false;
  delete store[name];
  return writeStore(store);
}
