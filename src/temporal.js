// temporal.js — decisions for temporal anti-aliasing of MOVING frames.
//
// Pure and environment-free, like quality.js and camera.js, so the frame-by-
// frame policy can be tested without a GPU (tools/temporal.test.js).
//
// Background. A still view is already antialiased by progressive accumulation:
// up to 96 jittered samples averaged in place. A moving view could not use
// that — averaging frames of a moving image smears it — so it was a single
// unjittered sample per pixel, staircased and speckled. Temporal reprojection
// keeps averaging across motion by first working out, per pixel, where that
// surface point was on screen in the previous frame.
//
// Three frame modes follow from that:
//   'accumulate'  still view: the existing in-place average (unchanged)
//   'temporal'    moving view: jittered sample + reprojected history
//   'single'      temporal filtering unavailable: one sample, as before

// Sub-pixel camera offsets for moving frames, in render pixels, centred on 0.
// Halton(2,3): low-discrepancy, so any run of consecutive frames covers the
// pixel evenly — which matters because history weights recent frames most.
export const JITTER_COUNT = 16;

function halton(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export function temporalJitter(frame) {
  const i = (((frame % JITTER_COUNT) + JITTER_COUNT) % JITTER_COUNT) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

// Fraction of each resolved pixel taken from history while the view moves.
// 0.9 is roughly a ten-frame window: long enough to antialias, short enough
// that a morphing surface catches up within a sixth of a second at 60fps.
export const HISTORY_WEIGHT_MOVING = 0.9;

// A view can be motionless without being in 'accumulate' mode — the landing
// camera under reduced motion, or the short idle wait before accumulation
// starts. With nothing moving there is nothing for history to lag behind, so
// frames are averaged exactly (weight n/(n+1)) instead of exponentially, up to
// this many.
export const STILL_CAP = 32;

// What an accumulation is worth when it is started from temporal history
// rather than from nothing. The history of a motionless view is already an
// average of many jittered frames; counting it as this many samples lets the
// in-place average carry on from it instead of restarting from one raw sample,
// which was a visible flicker every time the view came to rest.
export const ACCUM_SEED_SAMPLES = 8;

// The history buffers double the material memory, and supersampled rungs
// (scale > 1) already put several samples in every display pixel of a moving
// frame. So history is only kept where it is both affordable and needed.
export const TEMPORAL_MAX_SCALE = 1.0;

export function temporalAllowed(enabled, scale) {
  return !!enabled && Number.isFinite(scale) && scale <= TEMPORAL_MAX_SCALE + 1e-6;
}

export function historyWeight(historyValid, stillCount) {
  if (!historyValid) return 0;
  if (stillCount > 0) {
    const n = Math.min(stillCount, STILL_CAP);
    return n / (n + 1);
  }
  return HISTORY_WEIGHT_MOVING;
}

// Decide one frame.
//
// s: carried state  { historyValid, stillCount, accumHeld }
//      historyValid  the history buffers hold a resolved image at this size
//      stillCount    consecutive frames whose geometry did not change
//      accumHeld     samples in the in-place average as of the last frame
//                    (0 when the last frame was not an accumulating one)
// f: this frame     { allowed, accumulating, accumSamples, geometrySame }
//      allowed       temporalAllowed() for the live rung
//      accumulating  the renderer's own stillness test says accumulate
//      accumSamples  the renderer's sample count going into this frame
//      geometrySame  camera, time and shape are identical to the last frame
//
// Returns the plan, including the carried state for the next frame:
//   mode          'accumulate' | 'temporal' | 'single'
//   weight        history weight for the temporal resolve (0 = no history)
//   seedAccum     copy history into the material targets before drawing, and
//                 start the average at accumSamples
//   seedHistory   copy the material targets into history before drawing
//   accumSamples  the sample count the renderer should proceed with
//   stillCount, historyValid   carried state
export function planTemporalFrame(s, f) {
  const stillCount = f.geometrySame ? Math.min((s.stillCount | 0) + 1, STILL_CAP) : 0;

  if (f.accumulating) {
    // Hand the moving image over to the accumulator, but only if it is the
    // same picture: same camera, same instant, same shape.
    const seedAccum = !!f.allowed && f.accumSamples === 0
                      && !!s.historyValid && !!f.geometrySame;
    return {
      mode: 'accumulate',
      weight: 0,
      seedAccum,
      seedHistory: false,
      accumSamples: seedAccum ? ACCUM_SEED_SAMPLES : f.accumSamples,
      stillCount,
      // History is not updated while accumulating, so it goes stale.
      historyValid: false,
    };
  }

  if (!f.allowed) {
    return {
      mode: 'single', weight: 0, seedAccum: false, seedHistory: false,
      accumSamples: f.accumSamples, stillCount, historyValid: false,
    };
  }

  // Leaving a still view: the in-place average is the best available picture
  // of the moment before motion, so it becomes the history to reproject from.
  const seedHistory = !s.historyValid && (s.accumHeld | 0) > 0;
  const valid = !!s.historyValid || seedHistory;
  return {
    mode: 'temporal',
    weight: historyWeight(valid, f.geometrySame ? stillCount : 0),
    seedAccum: false,
    seedHistory,
    accumSamples: f.accumSamples,
    stillCount,
    historyValid: true,
  };
}
