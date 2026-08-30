# swarm — design

> A large-count particle / lightweight-fluid engine for visual effects: smoke,
> snow, falling petals (cheap drift) and water/splash (SPH-lite). Pure,
> dependency-free, deterministic, headless-testable.

`minimal primitives × combinatorial expressiveness`. A flat particle buffer, an
integrator, a handful of force functions, a seeded emitter, a uniform-grid
neighbour search and one SPH pass already span **two regimes** — from cheap
non-interacting drift to interacting fluid — without changing the data layout.
It's renderer-agnostic plain data (no three.js / canvas / DOM), so it runs
headless and is unit-tested in Node, and it's deterministic so replays and tests
are reproducible.

## Two regimes, one substrate

| regime | forces | neighbours? | use |
|---|---|---|---|
| **granular / drift** | gravity, drag, curl-ish wind | none | smoke (small −g, rises via buoyant emit + wind), snow (small −g, high drag), falling petals (drag + tumble) |
| **SPH-lite** (M2) | + density→pressure→viscosity | uniform grid | water, splash, a settling pool |

Same `pos`/`vel` buffers, same `step(dt)` loop; SPH-lite is extra passes inside
`step`, not a separate engine. The host picks a regime by how it configures the
`Field` and which passes are enabled.

## Primitives

- **Particle buffers** — flat, typed-array-friendly parallel arrays:
  `pos = [x0,y0, x1,y1, …]`, `vel`, plus scalar `life`/`age`. Packed and
  contiguous (cache-friendly, scales to thousands). Dead particles are removed by
  swap-with-last (O(1)), keeping the live range `[0, count)` contiguous so every
  pass is a tight loop with no holes.
- **Integrator** — semi-implicit Euler (velocity first, then position) for
  stability under stiff forces. Fixed-`dt` callers are deterministic; `step(dt)`
  is the single per-frame entry point.
- **Forces**
  - *gravity* — constant `[gx, gy]`; sign/magnitude select smoke (small +/−) vs
    splash (large −).
  - *drag* — dt-stable exponential-ish damping (air); the per-particle `wobble`
    trait slightly varies the damping so particles do not share one terminal speed.
  - *wind / curl-ish noise* — a deterministic sum of incommensurate sines (no
    noise table, **no `Math.random`**) giving organic, non-repeating swirl. This
    is what makes smoke/snow read as *alive* instead of a flat constant push.
  - *flutter* — optional per-particle lateral sway with a seeded phase, for
    falling petals/leaves.
  - *vortex* — optional 2D point swirl or `axis: "y"` XZ tornado with updraft;
    the latter uses the optional depth axis without changing the 2D buffer layout.
    Shape: `{ center:[x,y], strength, inward }` for 2D, or
    `{ axis: "y", center:[x,y], centerZ, strength, inward, updraft }` for a 3D
    tornado — `centerZ` locates the swirl in the depth axis and `updraft` adds a
    vertical velocity component per step.
- **Neighbour search (M2)** — a **uniform grid** spatial hash over `pos`: bucket
  each particle into a cell of side ≈ the SPH smoothing radius `h`, then each
  particle only tests its 3×3 (2D) cell neighbourhood — O(N) instead of O(N²).
  The grid is rebuilt each step from the flat buffer; nothing about the buffer
  layout changes.
- **Emitters** — `emit(n, opts)` spawns `n` particles from a point with **seeded**
  jitter on position (`spread`), velocity (`vel` + `velJitter`) and lifetime
  (`life` + `lifeJitter`), plus optional depth (`z`, `zSpread`, `zVel`,
  `zVelJitter`). Every jitter/scatter parameter is a **full extent**: the value
  `s` produces a uniform draw in `[-s, +s]` (so `spread: 2` scatters across a 4-unit
  span, not a radius-2 disc). All randomness comes from the field's seeded PRNG,
  so an emit is byte-reproducible. Lifetime drives fade-in/out via `age`/`life`;
  `phase`, `spin` and `wobble` are per-particle host/motion traits.
- **Collision (M3)** — particles vs simple colliders: a ground **plane** and an
  axis-aligned **box** (`bounds`). On contact, reflect the normal velocity with a
  restitution + friction coefficient so particles **bounce** then **settle**
  (snow piling, splash droplets landing).

## Determinism

- Seeded **mulberry32** PRNG (tiny, pure, 32-bit) — same seed → same stream.
- Wind is sin-based, **no `Math.random` anywhere**.
- Fixed-`dt` stepping. → identical inputs produce byte-identical `positions`, so
  replays reproduce exactly and tests assert equality across runs (see
  `test.mjs`, which checks emit/gravity/finiteness/determinism).

## API

```js
import { Field } from 'swarm';

const field = new Field({
  gravity: [0, -9.8],   // m/s^2; small for smoke/snow, large for splash
  drag: 0.1,            // air damping / s
  windAmp: 1.5,         // curl-ish wind strength (0 = still)
  windScale: 1.0,       // wind wavelength in world units
  flutter: 0.0,         // lateral petal/leaf sway (0 = off)
  flutterFreq: 1.2,     // sway oscillations per second
  vortex: null,          // optional 2D swirl or { axis: "y", ... } tornado
  bounds: null,         // reserved for M3 collision/cull; currently unused
  seed: 42,             // deterministic emit + replay
  capacity: 8192,       // pre-sized buffers (never grow mid-step)
});

field.emit(500, { pos: [0, 0], spread: 1, vel: [0, 2], velJitter: 1, life: 3, lifeJitter: 1 });

field.step(1 / 60);     // forces → integrate → age/cull (fixed dt)

field.positions;        // flat [x0,y0, x1,y1, …] of LIVE particles (host draws these)
field.count;            // live particle count
```

- `new Field(opts)` — a simulation domain.
- `field.emit(n, { pos, spread, vel, velJitter, life, lifeJitter, z, zSpread, zVel, zVelJitter })` — seeded spawn with optional depth.
- `field.step(dt)` — advance one fixed step.
- `field.positions` / `field.velocities` — flat live-particle views; `field.count`.
  `ages`, `lives`, `depths`, `angle(k)` and `z(k)` expose additional host data.
- `mulberry32(seed)` — the seeded PRNG, exported for hosts that want the same stream.

## Milestones

- **M1 (done)** particle buffers + integrate + basic forces (gravity / drag /
  curl-ish wind = smoke / snow / petal drift), optional flutter/vortex motion,
  seeded-deterministic emit, lifetime cull and optional z integration. *All in
  `index.js`.*
- **M2** SPH-lite: uniform-grid neighbour search → density → pressure → viscosity
  (water splash / pool).
- **M3** collision vs ground plane / box: bounce + settle (`bounds`, restitution,
  friction).
- **M4** host wiring (see below): determinism preserved end-to-end for replay.

## Applications — dropping into a mahjong game ([netmahg](https://github.com/opaopa6969/netmahg))

Engine-agnostic, but the driving use case:

- **Seasonal ambient particles** — replace the host's current per-season ambient
  loop with a `Field`: spring petals (drag + tumble), summer fireflies (low −g +
  wind drift), autumn leaves, winter snow (high drag). One field, four configs.
- **Win / burst effects** — on a win, `emit` a radial burst (high `velJitter`,
  short `life`) for a confetti/spark pop.
- **Splash effects (M2)** — pouring/clearing tiles, a water motif: an SPH-lite
  `Field` with large `−g` gives a real splash-and-settle.

Because everything is fixed-`dt` and seeded, these stay compatible with the host's
**deterministic replay** — the same match replays to the same particles.

## House-style notes

- **Pure ESM**, zero runtime dependencies, single-file core (`index.js`).
- **Deterministic**: fixed timestep, seeded mulberry32 PRNG, **no `Math.random`**.
- **Headless-testable**: `node test.mjs` — no browser/canvas needed.
- **MIT**, author `opaopa6969`. Sibling engines:
  [motion-engine](https://github.com/opaopa6969/motion-engine),
  [xpbd-body](https://github.com/opaopa6969/xpbd-body).
