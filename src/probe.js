// probe.js — the clearance probe's asynchronous readback, as pure logic.
//
// The probe is a one-thread compute pass whose two floats (clearance, centre-hit
// distance) are copied into a MAP_READ staging buffer and read back by the CPU a
// frame or two later. WebGPU forbids using a buffer in a submit while a mapAsync
// on it is pending, so the renderer must never start another probe until the
// previous readback has finished with the same buffer.
//
// That rule is easy to break when the buffers can be replaced mid-flight, which
// is what used to happen: they were recreated on every resize while a readback
// was still running on the old ones. The late readback then cleared the busy
// flag of the new probe while ITS readback was still pending, and the next probe
// copied into a buffer that was waiting to be mapped.
//
// So the readback is handed the probe object it belongs to and touches nothing
// else: it sets that object's busy flag and nothing more, and it may publish a
// reading only if that object is still the current one. Kept free of WebGPU
// globals so tools/probe.test.js can drive it with fakes.

// probe:     { staging, busy } -- staging has mapAsync/getMappedRange/unmap
// isCurrent: () => boolean     -- is this still the renderer's live probe?
// onReading: (dist, hit) => void
// mapRead:   the GPUMapMode.READ constant (a parameter so no global is needed)
export function startProbeReadback(probe, isCurrent, onReading, mapRead) {
  probe.busy = true;
  return probe.staging.mapAsync(mapRead).then(() => {
    const v = new Float32Array(probe.staging.getMappedRange());
    const dist = v[0];
    const hit = v[1];
    probe.staging.unmap();
    if (isCurrent()) onReading(dist, hit);
    probe.busy = false;
  }).catch(() => {
    // The map was aborted (buffer destroyed, device lost). Nothing was mapped,
    // so this buffer is free again -- and no other buffer is affected.
    probe.busy = false;
  });
}
