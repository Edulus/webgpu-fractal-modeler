// tour.js — the boot tour: what it says, and when each step is on screen.
//
// The renderer takes a moment to come up. Before this, the only sign of that
// was the word "initializing…" in 12px at the bottom of the panel, which is
// easy to miss entirely on a fast machine and reads as "nothing is happening"
// on a slow one. The wait is now spent teaching the panel: each control is
// highlighted in turn with a short note saying what it does.
//
// Only the sequencing lives here, as pure functions over elapsed milliseconds,
// so the timing rules can be tested without a browser or a GPU. index.html owns
// the DOM half -- positioning the tooltip, moving the highlight.

// One step is about as long as it takes to read a short line and glance at what
// is being pointed at. 2200ms was measured to be too quick to read comfortably,
// so each step now holds two seconds longer.
//
// This does mean the tour long outlasts the wait: cold start here is ~640ms
// against 33.6s of tour across eight steps. That is deliberate and already how
// it worked -- the card claiming the renderer is starting has its own lifetime
// and disappears on the first frame, while the tour runs on as a lesson over a
// live picture, dismissable at any point.
export const STEP_MS = 4200;

// The panel, in the order someone meets it. Shape first because it is what the
// page is for; the setup controls before the view controls; Image last, since
// it is the one section that is about the picture rather than the model.
//
// `target` is resolved against the document by the caller. Text is kept to one
// sentence -- this is a label on a control, not documentation, and the wait is
// measured in seconds.
export const TOUR_STEPS = [
  {
    target: '#sel-fractal',
    title: 'Shape',
    body: 'Thirty-one objects, from the Mandelbulb to hyperbolic honeycombs. Every one is drawn live, not loaded.',
  },
  {
    target: '#shape-params',
    title: 'Shape maths',
    body: 'The chosen shape\'s own constants, not a filter over it. Move one and the mathematics is re-solved as you drag.',
  },
  {
    target: '#sel-palette',
    title: 'Palette',
    body: 'Recolour the shape as you watch. You can paste in your own from a coolors.co link or a .gpl file.',
  },
  {
    target: '#cycle-speed',
    title: 'Shift colours',
    body: 'Drifts the palette through the shape. Zero holds it still.',
  },
  {
    target: '#sel-quality',
    title: 'Quality',
    body: 'Auto watches the frame rate and finds the most this machine can hold. Pin it here if you would rather choose.',
  },
  {
    target: '#btn-fly',
    title: 'Fly through',
    body: 'The other of the two modes. WASD to move, drag to look; the shapes with an interior can be flown inside.',
  },
  {
    target: '#btn-reset',
    title: 'Reset view',
    body: 'Puts the camera back where it started, for when a zoom has taken you somewhere unrecognisable.',
  },
  {
    target: '#img-io',
    title: 'Image',
    body: 'Brightness, contrast, saturation and hue, applied to the finished picture.',
  },
];

// What the boot card says, by how long it has been going.
//
// WebGPU offers no progress signal between "create this pipeline" and the
// promise resolving, so there is no honest percentage to show. What CAN be said
// honestly is which stage is taking the time, and these thresholds are set from
// where the time actually goes here: device request is quick, and everything
// after roughly a second is shader and pipeline compilation -- fractal.wgsl.js
// alone is some two thousand lines handed to the driver in one module.
//
// The later lines exist to say "this is slow, not stuck", which is the thing a
// spinner on its own never manages to communicate.
export const BOOT_PHASES = [
  { at: 0, text: 'Setting up WebGPU…' },
  { at: 900, text: 'Compiling shaders…' },
  { at: 3000, text: 'Still compiling — the first run is the slow one.' },
  { at: 8000, text: 'Taking longer than usual. Hang on.' },
];

export function bootPhaseAt(elapsedMs, phases = BOOT_PHASES) {
  if (!phases.length) return '';
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  let text = phases[0].text;
  for (const p of phases) if (t >= p.at) text = p.text;
  return text;
}

// The tour ends when the app is ready, but never before this many steps have
// played. It is the WHOLE sequence: walking the panel is the point of the tour,
// and a floor shorter than the sequence means which controls you are taught
// depends on how fast your GPU is, which is a strange way to decide a lesson.
// Measured cold start here is ~640ms against 15.4s of tour, so in practice this
// is what sets the length and readiness never enters into it.
//
// A floor is needed at all because without one a fast start shows a single
// highlight for 200ms and rips it away, which is worse than showing nothing:
// the eye is drawn to a flash it then cannot find.
//
// This is the one number to change to make the tour shorter -- at 2 it plays
// Shape and Palette and stops, which is roughly the length of a quick start.
export const MIN_STEPS = TOUR_STEPS.length;

// Which step is showing at `elapsedMs`.
//
// Steps run in order and then HOLD on the last one. Cycling back to the start
// was the other option and is worse: a slow start would replay the lesson from
// the top, which reads as a stutter rather than as progress, and the second
// pass teaches nobody anything.
//
// Returns -1 when there is nothing to show.
export function tourStepAt(elapsedMs, stepCount, stepMs = STEP_MS) {
  if (!(stepCount > 0) || !(stepMs > 0)) return -1;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.min(Math.floor(elapsedMs / stepMs), stepCount - 1);
}

// When the tour should come down, in elapsed milliseconds.
//
// `readyMs` is when the renderer finished starting, or null while it is still
// going. Two rules shape the answer: never cut a step off part-way through, and
// never finish before MIN_STEPS have had their turn. So readiness is rounded UP
// to the end of whatever step it lands in, and floored at the minimum.
//
// Returns Infinity while the app is not ready, which is what holds the last
// step on screen for as long as starting takes.
export function tourEndsAt(readyMs, stepCount, stepMs = STEP_MS, minSteps = MIN_STEPS) {
  if (!(stepCount > 0) || !(stepMs > 0)) return 0;
  if (readyMs == null || !Number.isFinite(readyMs)) return Infinity;
  const floor = Math.min(Math.max(minSteps, 1), stepCount) * stepMs;
  const wholeStep = Math.ceil(Math.max(0, readyMs) / stepMs) * stepMs;
  return Math.max(floor, wholeStep);
}

// The whole visible state of the tour at one instant, so the DOM layer has no
// timing decisions of its own to make and the rules above are the only place
// any of this is decided.
//
// `dismissed` short-circuits everything: skipping is immediate, because a user
// who has asked for the tour to go away is not interested in the rule about not
// cutting a step off part-way.
export function tourStateAt({
  elapsedMs, readyMs, dismissed = false, stepCount = TOUR_STEPS.length,
  stepMs = STEP_MS, minSteps = MIN_STEPS,
} = {}) {
  if (dismissed) return { done: true, index: -1, endsAt: 0 };
  const endsAt = tourEndsAt(readyMs, stepCount, stepMs, minSteps);
  if (elapsedMs >= endsAt) return { done: true, index: -1, endsAt };
  return { done: false, index: tourStepAt(elapsedMs, stepCount, stepMs), endsAt };
}
