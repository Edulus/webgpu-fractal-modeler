// Pacing of progressive accumulation.
//
// The image is fixed by WHICH samples are taken -- 96 R2-jittered offsets,
// averaged with weight 1/(k+1) -- and not at all by how many frames they are
// spread across. So the batch schedule may change freely, provided it still
// takes exactly those samples, in order, and lands on the cap rather than
// past it: a frame that overshoots divides the running mean by a count of
// samples it did not take, which lightens the whole image.
import { accumBatchFor, ACCUM_BATCH_AFTER, ACCUM_BATCH_MAX } from '../src/fractal-bg.js';

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

console.log('\naccumulation pacing');

const CAP = 96;
let taken = 0, frames = 0, overshot = false, order = [];
while (taken < CAP && frames < 1000) {
  const b = accumBatchFor(taken, CAP);
  if (b <= 0) break;
  if (taken + b > CAP) overshot = true;
  order.push(b);
  taken += b;
  frames += 1;
}

ok(`the schedule takes exactly the cap, not one more (${taken})`, taken === CAP);
ok('no frame overshoots the cap', !overshot);
ok(`it finishes in far fewer frames than samples (${frames} frames for ${CAP} samples)`,
  frames < CAP / 2);
ok('a converged accumulator asks for no further samples', accumBatchFor(CAP, CAP) === 0);
ok('and stays at zero past the cap', accumBatchFor(CAP + 50, CAP) === 0);

// The early samples stay one-per-frame. A multi-sample frame is slower to
// notice that a drag has begun, and the start of a still period is exactly
// when that is most likely to happen.
const early = Array.from({ length: ACCUM_BATCH_AFTER }, (_, i) => accumBatchFor(i, CAP));
ok(`the first ${ACCUM_BATCH_AFTER} samples are one per frame, so input stays responsive`,
  early.every((b) => b === 1));
ok('batching begins only after that', accumBatchFor(ACCUM_BATCH_AFTER, CAP) === ACCUM_BATCH_MAX);
ok('no frame exceeds the batch ceiling', order.every((b) => b <= ACCUM_BATCH_MAX));

// Every sample index is visited once and in order, which is what makes the
// result identical to taking them one per frame -- the R2 sequence is not
// commutative with the running mean's weights.
const visited = [];
let at = 0;
while (at < CAP) { const b = accumBatchFor(at, CAP); for (let i = 0; i < b; i++) visited.push(at + i); at += b; }
ok('every sample index is visited exactly once, in order',
  visited.length === CAP && visited.every((v, i) => v === i));

// Junk in must not produce a negative or fractional batch, which would either
// stall accumulation forever or step the index off the sequence.
ok('a negative count is treated as none taken yet', accumBatchFor(-5, CAP) === 1);
ok('a fractional count does not yield a fractional batch',
  Number.isInteger(accumBatchFor(7.6, CAP)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
