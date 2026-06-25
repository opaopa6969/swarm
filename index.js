// swarm — a large-count particle / lightweight-fluid engine for visual effects.
//
// GOAL: drive *thousands* of particles cheaply and DETERMINISTICALLY for smoke,
// snow, falling petals (verlet-ish drift) and — at M2 — water/splash (SPH-lite).
// Two regimes share one substrate:
//
//   granular/drift   gravity + drag + a little curl-ish wind (sum of sines).
//                    Cheap, no neighbour queries. Smoke rises, snow settles,
//                    petals tumble. This is M1, and it's all in this file.
//   SPH-lite (M2)    a uniform-grid neighbour search feeds density → pressure →
//                    viscosity so particles behave like a fluid (splash, pool).
//
// DATA-ORIENTED, RENDERER-AGNOSTIC: state lives in FLAT, typed-array-friendly
// `pos`/`vel` buffers (cache-friendly, scales to thousands). NO three.js / DOM /
// canvas import. The host reads `field.positions` (flat [x,y, x,y, ...]) and
// `field.count` and draws them however it likes. Deterministic — a seeded
// mulberry32 PRNG (NO Math.random) + sin-based wind — so replays/tests are
// reproducible and it runs headless in Node. See test.mjs.
//
// `minimal primitives × combinatorial expressiveness`: a buffer, an integrator,
// a few force functions and a seeded emitter already cover smoke/snow/petals;
// the grid + SPH passes drop in beside them without touching the buffer layout.

// ------------------------------------------------------------- seeded PRNG
// mulberry32: tiny, fast, pure 32-bit PRNG. Same seed → same stream, so every
// emit (jittered position/velocity/life) is reproducible across runs/machines.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// curl-ish wind: a deterministic, divergence-free-ish drift from a sum of
// incommensurate sines (no noise table, no Math.random). Gives organic swirl
// for smoke/snow instead of a flat constant push. Returns [ax, ay].
function wind(x, y, t, amp) {
  const ax = Math.sin(y * 0.7 + t * 0.6) + 0.5 * Math.sin(y * 1.7 - t * 0.9 + x * 0.3);
  const ay = Math.cos(x * 0.8 - t * 0.5) + 0.5 * Math.cos(x * 1.9 + t * 0.7 - y * 0.4);
  return [ax * amp, ay * amp];
}

// ----------------------------------------------------------------- Field
// One simulation domain. Particles are stored in parallel flat arrays packed as
// [x0,y0, x1,y1, ...] so the whole sim is a few tight loops over Float64-friendly
// memory. `count` is the live particle count; dead (life<=0) particles are
// swapped to the tail and dropped, keeping the live range contiguous.
export class Field {
  constructor({
    gravity = [0, -9.8],   // m/s^2; snow/petals use a small |g|, splash a large one
    drag = 0.1,            // velocity damping per second (air resistance)
    windAmp = 0.0,         // curl-ish wind strength (0 = still air)
    bounds = null,         // optional [minX,minY,maxX,maxY] for M3 collision/cull
    seed = 1,
    capacity = 8192,       // max particles (buffers are pre-sized, never grow mid-step)
  } = {}) {
    this.gravity = gravity;
    this.drag = drag;
    this.windAmp = windAmp;
    this.bounds = bounds;
    this.capacity = capacity;
    this.rand = mulberry32(seed);
    this.t = 0;
    this.count = 0;
    this.pos = new Float64Array(capacity * 2);
    this.vel = new Float64Array(capacity * 2);
    this.life = new Float64Array(capacity);   // seconds remaining; <=0 → recycled
    this.age = new Float64Array(capacity);     // seconds lived (for fade-in/out)
  }

  // spawn n particles from `pos` with seeded jitter. `spread` scatters position,
  // `vel`+`velJitter` set initial velocity, `life` (± lifeJitter) sets lifetime.
  emit(n, { pos = [0, 0], spread = 0, vel = [0, 0], velJitter = 0, life = 2, lifeJitter = 0 } = {}) {
    const r = this.rand;
    for (let i = 0; i < n && this.count < this.capacity; i++) {
      const k = this.count++;
      this.pos[k * 2] = pos[0] + (r() - 0.5) * 2 * spread;
      this.pos[k * 2 + 1] = pos[1] + (r() - 0.5) * 2 * spread;
      this.vel[k * 2] = vel[0] + (r() - 0.5) * 2 * velJitter;
      this.vel[k * 2 + 1] = vel[1] + (r() - 0.5) * 2 * velJitter;
      this.life[k] = Math.max(0.0001, life + (r() - 0.5) * 2 * lifeJitter);
      this.age[k] = 0;
    }
    return this;
  }

  // advance the whole field by dt: forces → integrate → age/cull. Semi-implicit
  // Euler (velocity first) for stability. Fixed-dt callers stay deterministic.
  step(dt) {
    const { pos, vel, gravity, drag } = this;
    const gx = gravity[0], gy = gravity[1];
    const damp = Math.max(0, 1 - drag * dt);   // exponential-ish drag, dt-stable
    this.t += dt;
    for (let k = 0; k < this.count; k++) {
      let vx = vel[k * 2], vy = vel[k * 2 + 1];
      vx += gx * dt; vy += gy * dt;            // gravity
      if (this.windAmp) {                       // curl-ish wind (organic drift)
        const [wx, wy] = wind(pos[k * 2], pos[k * 2 + 1], this.t, this.windAmp);
        vx += wx * dt; vy += wy * dt;
      }
      vx *= damp; vy *= damp;                   // drag
      vel[k * 2] = vx; vel[k * 2 + 1] = vy;
      pos[k * 2] += vx * dt;                    // integrate position
      pos[k * 2 + 1] += vy * dt;
    }
    this.#ageAndCull(dt);
    // TODO M2 SPH-lite: build uniform-grid neighbour hash over `pos`, then
    //   density → pressure → symmetric pressure force → XSPH viscosity passes.
    // TODO M3 collision: clamp/bounce against `bounds` (ground plane / box).
    return this;
  }

  // age particles, fade lifetime, and recycle the dead by swapping the last live
  // particle into the dead slot — O(1) removal that keeps [0,count) contiguous.
  #ageAndCull(dt) {
    for (let k = 0; k < this.count; k++) {
      this.age[k] += dt;
      this.life[k] -= dt;
      if (this.life[k] <= 0) {
        const last = --this.count;
        if (k !== last) {
          this.pos[k * 2] = this.pos[last * 2]; this.pos[k * 2 + 1] = this.pos[last * 2 + 1];
          this.vel[k * 2] = this.vel[last * 2]; this.vel[k * 2 + 1] = this.vel[last * 2 + 1];
          this.life[k] = this.life[last]; this.age[k] = this.age[last];
        }
        k--; // re-test the swapped-in particle
      }
    }
  }

  // flat [x0,y0, x1,y1, ...] view of the LIVE particles, for the host renderer.
  get positions() { return this.pos.subarray(0, this.count * 2); }
  get velocities() { return this.vel.subarray(0, this.count * 2); }
}
