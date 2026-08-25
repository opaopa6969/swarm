// swarm — reproducible micro-benchmark for `Field.step` hot loop.
//
// Measures the cost of `Field.step(dt)` across representative scenarios so
// engine-level changes (alloc removal, hoisting, typed-array layout) can be
// compared reproducibly. Deterministic by design: same seed → same workload.
//
//   node bench.mjs [warmupSteps] [measureSteps] [particles]
//
// Defaults: 200 warmup frames (lets V8 TurboFan tier up), 2000 measured frames,
// 8000 particles (default `Field` capacity). Prints one JSON line per scenario
// so the output is machine-parseable for before/after comparisons.
//
// Scenarios (each runs in a fresh Field, with its own warmup + measure window):
//   1. gravity+drag baseline  — cheapest step path (no wind/flutter/vortex)
//   2. +wind                  — exercises `wind()` (allocs `[wx,wy]` per call)
//   3. +flutter               — adds per-particle sin sway
//   4. +vortex2d              — 2D swirl: Math.sqrt per particle, no allocs
//   5. +vortex3d              — 3D XZ tornado (uses z axis)
//
// Metric: ns per particle per step (lower is better). Computed as
//   (meanStepNs / count) so counts that vary slightly via cull are normalised.
// Also reports steps/sec and ns/step so total throughput is auditable.
//
// Reproducibility notes:
//   - Fixed seed (1) and fixed `dt = 1/60` across all runs.
//   - Warmup window is long enough to trigger TurboFan on the step function.
//   - We measure only `step(dt)`; emit is done before timing.
//   - `life` is large so cull does not perturb `count` mid-measurement.
//   - Uses `performance.now` (monotonic, ns resolution under Node).
//   - GC: a `global.gc()` is attempted between scenarios if `--expose-gc` is
//     passed, otherwise we just rely on warmup to stabilise heap.

import { Field } from './index.js';

const warmup = +(process.argv[2] ?? 200);
const measure = +(process.argv[3] ?? 2000);
const N = +(process.argv[4] ?? 8000);
const dt = 1 / 60;

// One scenario: build a field, emit `N` particles, warm up, then time `measure`
// steps. Returns a result row.
function scenario(name, fieldOpts, emitOpts) {
  const f = new Field({ capacity: N, seed: 1, ...fieldOpts });
  f.emit(N, { life: 1e6, ...emitOpts });
  for (let i = 0; i < warmup; i++) f.step(dt);
  if (typeof global.gc === 'function') { global.gc(); global.gc(); }

  const t0 = performance.now();
  for (let i = 0; i < measure; i++) f.step(dt);
  const t1 = performance.now();

  const elapsedNs = (t1 - t0) * 1e6;
  const nsPerStep = elapsedNs / measure;
  const nsPerParticleStep = nsPerStep / f.count;
  const stepsPerSec = measure / ((t1 - t0) / 1000);

  return {
    scenario: name,
    particles: f.count,
    warmup, measure,
    ns_per_step: Math.round(nsPerStep),
    ns_per_particle_step: +nsPerParticleStep.toFixed(3),
    steps_per_sec: Math.round(stepsPerSec),
  };
}

const rows = [
  scenario('gravity+drag',
    { gravity: [0, -9.8], drag: 0.1 },
    { pos: [0, 0], spread: 2, vel: [0, 0], velJitter: 1 }),
  scenario('+wind',
    { gravity: [0, -9.8], drag: 0.1, windAmp: 1.5, windScale: 100 },
    { pos: [0, 0], spread: 2, vel: [0, 0], velJitter: 1 }),
  scenario('+flutter',
    { gravity: [0, -9.8], drag: 0.1, flutter: 30, flutterFreq: 1.2 },
    { pos: [0, 0], spread: 2, vel: [0, 0], velJitter: 1 }),
  scenario('+vortex2d',
    { gravity: [0, -9.8], drag: 0.1, vortex: { center: [0, 0], strength: 80, inward: 0.1 } },
    { pos: [0, 0], spread: 2, vel: [0, 0], velJitter: 1 }),
  scenario('+vortex3d',
    { gravity: [0, -9.8], drag: 0.1,
      vortex: { axis: 'y', center: [0, 0], centerZ: 0, strength: 100, inward: 0.05, updraft: 20 } },
    { pos: [0, 0], spread: 2, vel: [0, 0], velJitter: 1, z: 0, zSpread: 40 }),
];

const meta = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  warmup, measure, particles: N, dt,
  ts: new Date().toISOString(),
};
console.log(JSON.stringify({ meta, rows }));
