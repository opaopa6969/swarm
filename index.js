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
function wind(x, y, t, amp, scale) {
  // scale = world-units per wind wavelength. The sine frequencies assume
  // O(1) coords; pixel-space callers pass scale≈100+ so gusts stay coherent
  // (large flowing eddies) instead of scrambling per-pixel.
  const xs = x / scale, ys = y / scale;
  const ax = Math.sin(ys * 0.7 + t * 0.6) + 0.5 * Math.sin(ys * 1.7 - t * 0.9 + xs * 0.3);
  const ay = Math.cos(xs * 0.8 - t * 0.5) + 0.5 * Math.cos(xs * 1.9 + t * 0.7 - ys * 0.4);
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
    windScale = 1.0,       // world-units per wind wavelength (pixel-space: ~100+)
    flutter = 0.0,         // per-particle lateral sway amplitude (petals/leaves ひらひら)
    flutterFreq = 1.2,     // sway oscillations per second (each particle gets its own phase)
    vortex = null,         // { center:[x,y], strength, inward=0 } — tornado/updraft swirl
    bounds = null,         // optional [minX,minY,maxX,maxY] for M3 collision/cull
    seed = 1,
    capacity = 8192,       // max particles (buffers are pre-sized, never grow mid-step)
  } = {}) {
    this.gravity = gravity;
    this.drag = drag;
    this.windAmp = windAmp;
    this.windScale = windScale;
    this.flutter = flutter;
    this.flutterFreq = flutterFreq;
    this.vortex = vortex;
    this.bounds = bounds;
    this.capacity = capacity;
    this.rand = mulberry32(seed);
    this.t = 0;
    this.count = 0;
    this.pos = new Float64Array(capacity * 2);
    this.vel = new Float64Array(capacity * 2);
    this.life = new Float64Array(capacity);   // seconds remaining; <=0 → recycled
    this.age = new Float64Array(capacity);     // seconds lived (for fade-in/out)
    // per-particle traits so motion isn't uniform: flutter phase + a size/mass
    // scalar that scales how strongly wind/flutter push each particle around.
    this.phase = new Float64Array(capacity);   // radians, flutter sway offset
    this.spin = new Float64Array(capacity);    // rad/s, visual rotation rate for the host
    this.wobble = new Float64Array(capacity);  // 0.6..1.4 per-particle drift multiplier
    // optional depth axis: pos/vel stay 2D (x,y) so existing packing is intact;
    // z is a parallel scalar. Stays 0 unless emit/vortex touch it → 2D by default.
    this.zpos = new Float64Array(capacity);    // depth: >0 toward viewer, <0 away
    this.zvel = new Float64Array(capacity);
  }

  // spawn n particles from `pos` with seeded jitter. `spread` scatters position,
  // `vel`+`velJitter` set initial velocity, `life` (± lifeJitter) sets lifetime.
  emit(n, { pos = [0, 0], spread = 0, vel = [0, 0], velJitter = 0, life = 2, lifeJitter = 0,
            z = 0, zSpread = 0, zVel = 0, zVelJitter = 0 } = {}) {
    const r = this.rand;
    for (let i = 0; i < n && this.count < this.capacity; i++) {
      const k = this.count++;
      this.pos[k * 2] = pos[0] + (r() - 0.5) * 2 * spread;
      this.pos[k * 2 + 1] = pos[1] + (r() - 0.5) * 2 * spread;
      this.vel[k * 2] = vel[0] + (r() - 0.5) * 2 * velJitter;
      this.vel[k * 2 + 1] = vel[1] + (r() - 0.5) * 2 * velJitter;
      this.zpos[k] = z + (r() - 0.5) * 2 * zSpread;
      this.zvel[k] = zVel + (r() - 0.5) * 2 * zVelJitter;
      this.life[k] = Math.max(0.0001, life + (r() - 0.5) * 2 * lifeJitter);
      this.age[k] = 0;
      this.phase[k] = r() * Math.PI * 2;                 // unique flutter phase
      this.spin[k] = (r() - 0.5) * 2 * 4;                // -4..4 rad/s tumble
      this.wobble[k] = 0.6 + r() * 0.8;                  // 0.6..1.4 drift scale
    }
    return this;
  }

  // advance the whole field by dt: forces → integrate → age/cull. Semi-implicit
  // Euler (velocity first) for stability. Fixed-dt callers stay deterministic.
  step(dt) {
    const { pos, vel, gravity, drag, flutter, phase, wobble } = this;
    const gx = gravity[0], gy = gravity[1];
    this.t += dt;                              // per-particle drag computed in-loop
    const vx0 = this.vortex, wscale = this.windScale || 1;
    for (let k = 0; k < this.count; k++) {
      const w = wobble[k] || 1;
      let vx = vel[k * 2], vy = vel[k * 2 + 1];
      vx += gx * dt; vy += gy * dt;            // gravity
      if (this.windAmp) {                       // curl-ish wind (organic drift)
        const [wx, wy] = wind(pos[k * 2], pos[k * 2 + 1], this.t, this.windAmp, wscale);
        vx += wx * w * dt; vy += wy * w * dt;
      }
      if (flutter) {                            // ひらひら: per-particle lateral sway
        const s = Math.sin(this.t * this.flutterFreq * Math.PI * 2 + phase[k]);
        vx += flutter * s * w * dt;
      }
      let vz = this.zvel[k];
      if (vx0) {
        const st = vx0.strength, inw = vx0.inward || 0;
        if (vx0.axis === "y") {
          // 3D tornado: swirl in the horizontal XZ plane around a VERTICAL axis.
          // Front particles (z>cz) and back particles (z<cz) get opposite screen-X
          // velocity → the column reads as a rotating 3D funnel. Optional updraft.
          const dx = pos[k * 2] - vx0.center[0], dz = this.zpos[k] - (vx0.centerZ || 0);
          const inv = 1 / (Math.sqrt(dx * dx + dz * dz) + 1e-3);
          vx += (-dz * inv * st - dx * inv * inw * st) * dt;
          vz += (dx * inv * st - dz * inv * inw * st) * dt;
          if (vx0.updraft) vy += vx0.updraft * dt;
        } else {                                // 2D point swirl in the screen plane
          const dx = pos[k * 2] - vx0.center[0], dy = pos[k * 2 + 1] - vx0.center[1];
          const inv = 1 / (Math.sqrt(dx * dx + dy * dy) + 1e-3);
          vx += (-dy * inv * st - dx * inv * inw * st) * dt;
          vy += (dx * inv * st - dy * inv * inw * st) * dt;
        }
      }
      // per-particle drag (wobble as a size/mass proxy): lighter particles are
      // dragged harder → they fall slower, so a field shows a spread of speeds
      // instead of one uniform terminal velocity.
      const pdamp = Math.max(0, 1 - drag * (2 - w) * dt);
      vx *= pdamp; vy *= pdamp; vz *= pdamp;
      vel[k * 2] = vx; vel[k * 2 + 1] = vy; this.zvel[k] = vz;
      pos[k * 2] += vx * dt;                    // integrate position
      pos[k * 2 + 1] += vy * dt;
      this.zpos[k] += vz * dt;
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
          this.phase[k] = this.phase[last]; this.spin[k] = this.spin[last]; this.wobble[k] = this.wobble[last];
          this.zpos[k] = this.zpos[last]; this.zvel[k] = this.zvel[last];
        }
        k--; // re-test the swapped-in particle
      }
    }
  }

  // flat [x0,y0, x1,y1, ...] view of the LIVE particles, for the host renderer.
  get positions() { return this.pos.subarray(0, this.count * 2); }
  get velocities() { return this.vel.subarray(0, this.count * 2); }
  get ages() { return this.age.subarray(0, this.count); }
  get lives() { return this.life.subarray(0, this.count); }
  // per-particle visual rotation (radians) for host renderers that draw a
  // tumbling sprite — spin[k] is the rate, phase[k] the offset.
  angle(k) { return this.phase[k] + this.spin[k] * this.age[k]; }
  // depth axis (0 = window plane, >0 toward viewer, <0 behind). Hosts project
  // it to size/alpha/parallax and painter-sort by z for a 3D look.
  z(k) { return this.zpos[k]; }
  get depths() { return this.zpos.subarray(0, this.count); }
}
