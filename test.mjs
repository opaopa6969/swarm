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


// 10) flutter: a falling particle drifts laterally (weaves), off by default
{
  const off = new Field({ gravity: [0, -30], drag: 0, seed: 3 });
  off.emit(1, { pos: [0, 500], vel: [0, -20], life: 4 });
  for (let i = 0; i < 120; i++) off.step(1 / 60);
  ok(Math.abs(off.positions[0]) < 1e-6, 'no lateral drift when flutter is 0 (default off)');

  const on = new Field({ gravity: [0, -30], drag: 0.3, flutter: 60, flutterFreq: 1.5, seed: 3 });
  on.emit(1, { pos: [0, 500], vel: [0, -20], life: 4 });
  const xs = [];
  for (let i = 0; i < 180; i++) { on.step(1 / 60); xs.push(on.positions[0]); }
  let dirChanges = 0;
  for (let i = 2; i < xs.length; i++)
    if (Math.sign(xs[i] - xs[i - 1]) !== Math.sign(xs[i - 1] - xs[i - 2])) dirChanges++;
  ok(dirChanges >= 3, 'flutter makes the particle weave (multiple lateral direction changes)');
}

// 11) vortex: particles orbit the centre; off by default
{
  const v = new Field({ gravity: [0, 0], drag: 0, vortex: { center: [0, 0], strength: 80, inward: 0.1 }, seed: 4 });
  v.emit(1, { pos: [100, 0], life: 5 });
  const a0 = Math.atan2(v.positions[1], v.positions[0]);
  for (let i = 0; i < 60; i++) v.step(1 / 60);
  const a1 = Math.atan2(v.positions[1], v.positions[0]);
  ok(Math.abs(a1 - a0) > 0.05, 'vortex swirls particles around its centre');
}

// 11b) vortex inward/updraft act independently of strength (issue #13)
{
  // 2D: strength=0, inward>0 pulls the particle toward the centre
  const s = new Field({ gravity: [0, 0], drag: 0, seed: 1,
    vortex: { center: [0, 0], strength: 0, inward: 1 } });
  s.emit(1, { pos: [100, 0], life: 5 });
  for (let i = 0; i < 60; i++) s.step(1 / 60);
  ok(s.positions[0] < 100, '2D inward pulls particle toward centre even when strength is 0');

  // 3D: strength=0, updraft>0 lifts the particle
  const u = new Field({ gravity: [0, 0], drag: 0, seed: 1,
    vortex: { axis: "y", center: [0, 0], strength: 0, inward: 0, updraft: 20 } });
  u.emit(1, { pos: [0, 0], z: 0, life: 5 });
  for (let i = 0; i < 60; i++) u.step(1 / 60);
  ok(u.positions[1] > 0, '3D updraft lifts particle even when strength is 0');

  // all-zero vortex is a no-op (no spurious motion)
  const z = new Field({ gravity: [0, 0], drag: 0, seed: 1,
    vortex: { center: [0, 0], strength: 0, inward: 0, updraft: 0 } });
  z.emit(1, { pos: [100, 0], life: 5 });
  for (let i = 0; i < 60; i++) z.step(1 / 60);
  ok(Math.abs(z.positions[0] - 100) < 1e-9 && Math.abs(z.positions[1]) < 1e-9,
     'all-zero vortex is a no-op (no spurious motion)');
}

// 12) per-particle traits survive cull (swap keeps phase/spin/wobble aligned)
{
  const f = new Field({ capacity: 50, flutter: 10, seed: 7 });
  f.emit(30, { spread: 1, life: 1 });
  for (const arr of [f.phase, f.spin, f.wobble]) ok(arr.length === 50, 'trait buffers sized to capacity');
  f.emit(5, { spread: 1, life: 0.001 });
  f.step(0.5);
  ok(allFinite(f) && f.phase.every((v) => Number.isFinite(v)), 'cull keeps trait buffers finite/valid');
  ok(typeof f.angle(0) === 'number' && Number.isFinite(f.angle(0)), 'angle(k) returns a finite rotation');
}


// 13) z-axis: emit/integrate depth; 2D fields keep z=0 (backward compatible)
{
  const flat = new Field({ gravity: [0, -10], seed: 1 });
  flat.emit(5, { spread: 1, life: 2 });
  flat.step(0.5);
  ok(flat.depths.every((z) => z === 0), 'z stays 0 for fields that never touch it (2D unchanged)');

  const d = new Field({ drag: 0, seed: 1 });
  d.emit(1, { pos: [0, 0], z: 10, zVel: 5, life: 3 });
  ok(Math.abs(d.z(0) - 10) < 1e-9, 'emit sets initial z');
  d.step(1);
  ok(d.z(0) > 10, 'zVel integrates the depth forward');
}

// 14) 3D tornado (vortex axis:"y"): front and back get OPPOSITE screen-x motion
{
  const f = new Field({ gravity: [0, 0], drag: 0.1,
    vortex: { axis: "y", center: [0, 0], centerZ: 0, strength: 100, inward: 0.05, updraft: 20 }, seed: 2 });
  f.emit(1, { pos: [50, 0], z: 50, life: 5 });   // front
  f.emit(1, { pos: [50, 0], z: -50, life: 5 });  // back
  for (let i = 0; i < 20; i++) f.step(1 / 60);
  ok(Math.sign(f.velocities[0]) !== Math.sign(f.velocities[2]),
     'front and back particles swirl in opposite screen-x directions (3D rotation)');
  ok(f.positions[1] > 0, 'updraft lifts particles in y');
  // determinism
  const run = () => { const g = new Field({ vortex: { axis: "y", center: [0, 0], strength: 80 }, seed: 9 });
    g.emit(20, { pos: [30, 0], z: 20, zSpread: 40, life: 3 });
    for (let i = 0; i < 30; i++) g.step(1 / 60); return [...g.depths]; };
  ok(JSON.stringify(run()) === JSON.stringify(run()), '3D tornado is deterministic');
}

// 15) bounds is reserved (M3): passing it has no effect yet (no collision/cull)
{
  const f = new Field({ gravity: [0, -2], bounds: [-10, -10, 10, 10], seed: 1 });
  f.emit(10, { pos: [0, 5], spread: 1, life: 2 });
  for (let i = 0; i < 60; i++) f.step(1 / 60);
  // particles freely leave the bounds (no collision yet) — fix this contract
  ok(allFinite(f), 'bounds is reserved (M3) and has no effect in M1');
  ok(f.count === 10, 'bounds does not cull particles in M1 (reserved argument)');
}

// 15b) windScale: 0 is respected (no silent || 1 coercion); property == behaviour (issue #15)
{
  const mk = (ws) => {
    const f = new Field({ windScale: ws, windAmp: 5, gravity: [0, 0], drag: 0, seed: 1 });
    f.emit(1, { pos: [100, 100], life: 5 });
    f.step(1 / 60);
    return [f.velocities[0], f.velocities[1]];
  };
  const z = mk(0), one = mk(1);
  ok(z[0] === 0 && z[1] === 0, 'windScale=0 disables wind (no silent 1 coercion)');
  ok(one[0] !== 0, 'windScale=1 still applies wind (regression)');
  const f = new Field({ windScale: 0, windAmp: 5, seed: 1 });
  ok(f.windScale === 0, 'field.windScale stays 0 (no property/behaviour divergence)');
  // windScale=0 with windAmp>0 stays finite (no NaN from x/0) for many steps
  const g = new Field({ windScale: 0, windAmp: 5, gravity: [0, 0], drag: 0, seed: 1 });
  g.emit(20, { pos: [0, 0], spread: 5, life: 10 });
  for (let i = 0; i < 600; i++) g.step(1 / 60);
  ok(allFinite(g), 'windScale=0 + windAmp>0 stays finite over 600 steps (no NaN)');
}

// 16) step(0) is a no-op: zero advancement neither moves nor ages any particle
// (boundary dt — regression guard against a future 1/dt normalization or an
// age/cull path that advances on dt==0).
{
  const f = new Field({ gravity: [0, -9.8], drag: 0.2, windAmp: 1.5, seed: 1 });
  f.emit(50, { pos: [0, 5], spread: 1, vel: [0, 1], velJitter: 1, life: 2, lifeJitter: 0.5 });
  const pos0 = [...f.positions];
  const age0 = [...f.ages];
  const life0 = [...f.lives];
  const cnt0 = f.count;
  for (let i = 0; i < 10; i++) f.step(0);   // ten zero-length steps
  ok(f.count === cnt0, 'step(0) preserves the live count (no cull on zero time)');
  ok(allFinite(f), 'step(0) keeps positions finite');
  let moved = false, aged = false, lifeChanged = false;
  for (let i = 0; i < f.count * 2; i++) if (f.positions[i] !== pos0[i]) moved = true;
  for (let k = 0; k < f.count; k++) {
    if (f.ages[k] !== age0[k]) aged = true;
    if (f.lives[k] !== life0[k]) lifeChanged = true;
  }
  ok(!moved, 'step(0) does not move any particle (positions frozen)');
  ok(!aged, 'step(0) does not age any particle');
  ok(!lifeChanged, 'step(0) does not decrement any lifetime');
}

// 17) live views track count: positions/velocities/ages/lives/depths are subarray
// views whose length follows count, including after a partial cull. Hosts read
// `field.positions` + `field.count` and rely on `positions.length === count*2`.
{
  const f = new Field({ gravity: [0, 0], drag: 0, seed: 8 });
  f.emit(10, { spread: 0, life: 1, lifeJitter: 0 });   // die at exactly 1s
  f.emit(10, { spread: 0, life: 2, lifeJitter: 0 });   // die at exactly 2s
  ok(f.count === 20, 'two emits bring count to 20');
  ok(f.positions.length === f.count * 2, 'positions.length === count*2 before any cull');
  ok(f.ages.length === f.count, 'ages.length === count before any cull');
  for (let i = 0; i < 90; i++) f.step(1 / 60);          // 1.5s: first half dead, second alive
  ok(f.count === 10, 'partial cull: exactly half culled (deterministic lifetimes)');
  ok(f.positions.length === f.count * 2, 'positions.length === count*2 after partial cull');
  ok(f.velocities.length === f.count * 2, 'velocities.length === count*2 after partial cull');
  ok(f.ages.length === f.count, 'ages.length === count after partial cull');
  ok(f.lives.length === f.count, 'lives.length === count after partial cull');
  ok(f.depths.length === f.count, 'depths.length === count after partial cull');
}

// 18) a particle at the exact vortex centre stays finite — the 1e-3 epsilon in
// `1/(r+1e-3)` is the div-by-zero guard; removing it would NaN every on-centre
// particle (2D swirl centre and 3D tornado axis).
{
  const v2 = new Field({ gravity: [0, 0], drag: 0, seed: 1,
    vortex: { center: [0, 0], strength: 100, inward: 5 } });
  v2.emit(1, { pos: [0, 0], life: 5 });
  for (let i = 0; i < 120; i++) v2.step(1 / 60);
  ok(v2.count === 1, '2D centre particle is not lost');
  ok(allFinite(v2), '2D vortex at exact centre stays finite (epsilon div-by-zero guard)');

  const v3 = new Field({ gravity: [0, 0], drag: 0, seed: 1,
    vortex: { axis: "y", center: [0, 0], centerZ: 0, strength: 100, inward: 5, updraft: 10 } });
  v3.emit(1, { pos: [0, 0], z: 0, life: 5 });
  for (let i = 0; i < 120; i++) v3.step(1 / 60);
  ok(v3.count === 1, '3D on-axis particle is not lost');
  ok(allFinite(v3), '3D tornado on-axis stays finite (epsilon div-by-zero guard)');
}

// 19) life is clamped to a tiny positive minimum: a lifeJitter larger than life
// can push the computed life negative, but emit must not produce instant-death
// (life<=0) particles. Removing the Math.max clamp would cull them on step 1.
{
  const f = new Field({ gravity: [0, 0], drag: 0, seed: 2 });
  // life=0.1, lifeJitter=1 → computed life ∈ [-0.9, 1.1]; clamped to >= 0.0001
  f.emit(200, { spread: 1, life: 0.1, lifeJitter: 1 });
  ok(f.count === 200, 'emit spawns all 200 particles despite lifeJitter > life');
  let allPos = true;
  for (let k = 0; k < f.count; k++) {
    if (!(Number.isFinite(f.lives[k]) && f.lives[k] > 0)) allPos = false;
  }
  ok(allPos, 'all emitted lives are finite & positive (clamped, no instant death)');
  f.step(1e-5);   // a tiny step must not cull the clamped (>= 0.0001s) particles
  ok(f.count > 0, 'particles survive a tiny step (clamp prevents instant cull)');
}

// 20) windScale ≤ 0 or non-finite disables wind: the guard `wscale > 0` keeps
// `x/scale` from producing NaN. A future `!== 0` check or `|| 1` coercion would
// let NaN/Infinity propagate into every position. Complements #15b (the 0 case).
{
  const mk = (ws) => {
    const f = new Field({ windScale: ws, windAmp: 5, gravity: [0, 0], drag: 0, seed: 1 });
    f.emit(1, { pos: [100, 100], life: 5 });
    f.step(1 / 60);
    return [f.velocities[0], f.velocities[1]];
  };
  const neg = mk(-1);
  ok(neg[0] === 0 && neg[1] === 0, 'windScale < 0 disables wind (≤ 0 contract, no silent |1| coercion)');
  const nan = mk(NaN);
  ok(nan[0] === 0 && nan[1] === 0, 'windScale=NaN disables wind (non-finite guard, no NaN via x/NaN)');
  // many steps with NaN windScale must not accumulate NaN into positions
  const g = new Field({ windScale: NaN, windAmp: 5, gravity: [0, 0], drag: 0, seed: 1 });
  g.emit(20, { pos: [0, 0], spread: 5, life: 10 });
  for (let i = 0; i < 300; i++) g.step(1 / 60);
  ok(allFinite(g), 'windScale=NaN + windAmp>0 stays finite over 300 steps (no NaN propagation)');
  // the property is preserved as-is (property == behaviour, see issue #15)
  const f = new Field({ windScale: NaN, seed: 1 });
  ok(Number.isNaN(f.windScale), 'field.windScale preserves NaN (no silent coercion to a default)');
}

// 21) M2 SPH-lite: nearby particles interact through the uniform grid, while
// the default M1 path remains unchanged. Density and force passes are finite
// and deterministic for a settling fluid-like cluster.
{
  const opts = { gravity: [0, 0], drag: 0, seed: 6,
    sph: { h: 2, restDensity: 0.1, stiffness: 4, viscosity: 0.2, mass: 1 } };
  const a = new Field(opts), b = new Field(opts);
  for (const f of [a, b]) f.emit(20, { pos: [0, 0], spread: 0.2, life: 10 });
  for (let i = 0; i < 30; i++) { a.step(1 / 60); b.step(1 / 60); }
  ok(a.density.slice(0, a.count).every(Number.isFinite), 'SPH densities stay finite');
  ok(allFinite(a), 'SPH positions stay finite');
  ok(JSON.stringify([...a.positions]) === JSON.stringify([...b.positions]),
    'SPH uniform-grid simulation is deterministic');
  const isolated = new Field({ gravity: [0, 0], drag: 0,
    sph: { h: 1, restDensity: 1, stiffness: 10 }, seed: 2 });
  isolated.emit(1, { pos: [0, 0], life: 2 });
  isolated.step(1 / 60);
  ok(isolated.positions[0] === 0 && isolated.positions[1] === 0,
    'an isolated SPH particle has no spurious pressure motion');
}

console.log(`swarm M1: ${pass} passed${fail ? `, ${fail} failed` : ''}`);
process.exit(fail ? 1 : 0);
