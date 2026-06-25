// swarm unit tests — proves the engine runs headless (no canvas / browser),
// is deterministic (seeded PRNG, no Math.random), and that M1 forces behave.
//   node test.mjs    (or: npm test)
import { Field, mulberry32 } from './index.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const meanY = (f) => {
  let s = 0;
  for (let k = 0; k < f.count; k++) s += f.positions[k * 2 + 1];
  return f.count ? s / f.count : 0;
};
const allFinite = (f) => {
  for (let i = 0; i < f.count * 2; i++) if (!Number.isFinite(f.positions[i])) return false;
  return true;
};

// drive a field for `steps` frames at fixed 60fps and return it.
function run(opts, emitOpts, steps = 120, n = 500) {
  const f = new Field(opts);
  f.emit(n, emitOpts);
  for (let i = 0; i < steps; i++) f.step(1 / 60);
  return f;
}

// 1) emit increases count
{
  const f = new Field({ seed: 7 });
  ok(f.count === 0, 'a fresh field has zero particles');
  f.emit(300, { pos: [0, 0], spread: 1 });
  ok(f.count === 300, 'emit(300) raises count to 300');
}

// 2) particles fall under gravity (mean y decreases over time)
{
  const f = new Field({ gravity: [0, -9.8], drag: 0.05, seed: 3 });
  f.emit(400, { pos: [0, 0], spread: 0.5, life: 100 });   // long life so none cull
  const y0 = meanY(f);
  for (let i = 0; i < 120; i++) f.step(1 / 60);
  const y1 = meanY(f);
  ok(y1 < y0, 'mean y decreases under gravity (particles fall)');
}

// 3) everything stays finite (no NaN/Inf) even with wind + drag for many steps
{
  const f = run(
    { gravity: [0, -3], drag: 0.2, windAmp: 2.0, seed: 11 },
    { pos: [0, 5], spread: 2, vel: [0, 1], velJitter: 1, life: 100 },
    600,
  );
  ok(allFinite(f), 'positions stay finite under gravity + drag + wind');
}

// 4) DETERMINISTIC: same seed → byte-identical positions across two runs
{
  const mk = () => run(
    { gravity: [0, -9.8], drag: 0.1, windAmp: 1.5, seed: 42 },
    { pos: [0, 0], spread: 1, vel: [0, 2], velJitter: 1.5, life: 100 },
  );
  const a = mk().positions, b = mk().positions;
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  ok(same, 'identical seed → identical positions (deterministic replay)');
}

// 5) a DIFFERENT seed diverges (the PRNG actually varies the emit)
{
  const p = (seed) => run({ seed, windAmp: 1 }, { spread: 1, velJitter: 1, life: 100 }).positions;
  const a = p(1), b = p(2);
  let differs = false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differs = true; break; }
  ok(differs, 'a different seed produces a different field');
}

// 6) lifetime culling: short-lived particles are recycled, count returns to 0
{
  const f = new Field({ gravity: [0, 0], seed: 5 });
  f.emit(200, { life: 0.5, lifeJitter: 0 });
  ok(f.count === 200, 'emitted 200 short-lived particles');
  for (let i = 0; i < 60; i++) f.step(1 / 60);   // 1s elapsed > 0.5s life
  ok(f.count === 0, 'all particles culled after their lifetime');
}

// 7) cull keeps the live range contiguous and finite (swap-remove is correct)
{
  const f = new Field({ gravity: [0, -2], seed: 9 });
  f.emit(300, { spread: 1, life: 1, lifeJitter: 0.8 });
  for (let i = 0; i < 90; i++) f.step(1 / 60);
  ok(f.count >= 0 && f.count <= 300 && allFinite(f), 'partial cull leaves a valid contiguous buffer');
}

// 8) capacity is respected (buffers never overflow)
{
  const f = new Field({ capacity: 100, seed: 4 });
  f.emit(500, { spread: 1 });
  ok(f.count === 100, 'emit is clamped to capacity');
}

// 9) PRNG sanity: deterministic stream in [0,1)
{
  const r = mulberry32(123); const a = [r(), r(), r()];
  const s = mulberry32(123); const b = [s(), s(), s()];
  ok(a.every((v) => v >= 0 && v < 1), 'mulberry32 yields [0,1)');
  ok(a.every((v, i) => v === b[i]), 'mulberry32 is reproducible for a seed');
}

console.log(`swarm M1: ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);
