// palettes.js — Inigo Quilez cosine palettes.
//
// A cosine palette maps a scalar t -> RGB via:
//     color(t) = a + b * cos( 2*PI * (c*t + d) )
// where a, b, c, d are per-channel (vec3) coefficients.
//
// Each preset below stores { a, b, c, d } as length-3 arrays. The renderer
// uploads them as vec4s (w component unused / reserved) into the uniform
// buffer so the palette can be swapped at runtime without recompiling.
//
// Reference: https://iquilezles.org/articles/palettes/

export const PALETTES = {
  // Teal -> magenta with a cool luminous core. Good default "moody" look.
  aurora: {
    a: [0.5, 0.5, 0.55],
    b: [0.45, 0.4, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.5, 0.62, 0.78],
  },

  // Deep red -> orange -> gold. Warm, volcanic.
  ember: {
    a: [0.55, 0.28, 0.12],
    b: [0.5, 0.35, 0.18],
    c: [1.0, 0.9, 0.7],
    d: [0.0, 0.08, 0.18],
  },

  // Iridescent full-spectrum rainbow on dark — classic IQ rainbow.
  'oil-slick': {
    a: [0.5, 0.5, 0.5],
    b: [0.5, 0.5, 0.5],
    c: [1.0, 1.0, 1.0],
    d: [0.0, 0.33, 0.67],
  },

  // Cool monochrome ice: blue-white banding, very restrained.
  'mono-ice': {
    a: [0.62, 0.72, 0.85],
    b: [0.28, 0.3, 0.35],
    c: [1.0, 1.0, 1.0],
    d: [0.55, 0.6, 0.7],
  },
};

export const DEFAULT_PALETTE = 'aurora';

/**
 * Resolve a palette by key, falling back to the default if unknown.
 * @param {string} key
 * @returns {{a:number[],b:number[],c:number[],d:number[]}}
 */
export function getPalette(key) {
  return PALETTES[key] || PALETTES[DEFAULT_PALETTE];
}

export function paletteKeys() {
  return Object.keys(PALETTES);
}
