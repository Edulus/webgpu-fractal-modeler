// Device-loss recovery decisions. Run: node tools/recovery.test.js
//
// This path cannot be exercised in a browser on demand -- a GPU device loss is
// not something a page can provoke -- which is exactly why the decision lives
// in a pure function. The bug these cover was real and user-visible: a single
// boolean recorded the first re-try and was never cleared, so the second loss
// in a session was fatal however far apart the two were, and the message
// claimed the re-init had failed when it had actually succeeded.
import {
  planDeviceLoss, MAX_REINITS, REINIT_RESET_MS,
} from '../src/camera.js';

let passed = 0, failed = 0;
const check = (name, ok) => {
  if (ok) { passed++; }
  else { failed++; console.log(`  FAIL: ${name}`); }
};

{
  // A first loss always retries.
  const a = planDeviceLoss(0, 1000);
  check('first loss retries', a.retry === true);
  check('first loss counts one attempt', a.attempts === 1);

  // Repeated losses in quick succession retry up to the cap, then give up.
  let attempts = 0;
  for (let i = 0; i < MAX_REINITS; i++) {
    const p = planDeviceLoss(attempts, 500);
    check(`burst loss ${i + 1} retries`, p.retry === true);
    attempts = p.attempts;
  }
  const giveUp = planDeviceLoss(attempts, 500);
  check('a burst past the cap gives up', giveUp.retry === false);
  check('and reports the attempts made', giveUp.attempts === MAX_REINITS);

  // The regression: a device that ran a long time before failing must NOT be
  // judged as part of an earlier burst.
  const late = planDeviceLoss(MAX_REINITS, REINIT_RESET_MS + 1);
  check('a loss after a long healthy run retries again', late.retry === true);
  check('and restarts the count', late.attempts === 1);

  // Exactly at the threshold counts as recovered.
  check('the reset window is inclusive',
        planDeviceLoss(MAX_REINITS, REINIT_RESET_MS).retry === true);
  // Just under it does not.
  check('just inside the window still counts as the same burst',
        planDeviceLoss(MAX_REINITS, REINIT_RESET_MS - 1).retry === false);

  // Two separate incidents, each recoverable, must both recover -- this is the
  // exact case the old boolean broke.
  let n = planDeviceLoss(0, 5000).attempts;
  n = planDeviceLoss(n, REINIT_RESET_MS + 5000).attempts;
  check('two incidents hours apart both recover', n === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
